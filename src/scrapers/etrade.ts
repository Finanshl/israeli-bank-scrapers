import { type Page } from 'puppeteer';
import { DOLLAR_CURRENCY } from '../constants';
import { getDebug } from '../helpers/debug';
import { waitForRedirect } from '../helpers/navigation';
import { type TransactionsAccount, type Security } from '../transactions';
import { BaseScraperWithBrowser, LoginResults, type PossibleLoginResults } from './base-scraper-with-browser';

const debug = getDebug('etrade');

// Helper function to round to 2 decimal places
function roundToTwoDecimals(value: number): number {
  return Math.round(value * 100) / 100;
}

function getPossibleLoginResults(baseUrl: string) {
  const urls: PossibleLoginResults = {};
  urls[LoginResults.Success] = [
    `${baseUrl}/etx/hw/accounts`,
    `${baseUrl}/etx/hw/v2/accountshome`,
    /\/etx\/hw\/accounts/i,
    /\/etx\/hw\/v2\/accountshome/i,
  ];
  urls[LoginResults.InvalidPassword] = [`${baseUrl}/etx/pxy/login?error=true`, /error=true/i];
  return urls;
}

function createLoginFields(credentials: ScraperSpecificCredentials) {
  return [
    { selector: '#USER', value: credentials.username },
    { selector: '#password', value: credentials.password },
  ];
}

async function selectTargetPage(page: Page) {
  debug('Selecting target page from dropdown');
  try {
    // Wait for the dropdown to be available
    await page.waitForSelector('#loginOptions', { timeout: 5000 });

    // Select the accounts option
    await page.select('#loginOptions', 'accounts');

    debug('Target page selected');
  } catch (error) {
    debug('Error selecting target page: %s', error);
    throw error;
  }
}

async function handleTwoFactor(page: Page, isHeadless: boolean) {
  debug('Checking for 2FA screen');

  try {
    // Check if we're on a 2FA page by looking at the URL
    let currentUrl = page.url();
    debug('Current URL after redirect: %s', currentUrl);

    const is2FAPage =
      currentUrl === 'https://us.etrade.com/etx/pxy/login/sendotpcode' ||
      currentUrl === 'https://us.etrade.com/etx/pxy/login/verifyotpcode';

    if (is2FAPage) {
      if (isHeadless) {
        debug('2FA screen detected in headless mode - cannot proceed without user interaction');
        throw new Error('2FA required - cannot complete in headless mode. Please run with showBrowser: true');
      }

      debug('2FA screen detected - waiting for user to complete 2FA');
      debug('User has 2 minutes to send and enter the code');

      // Wait up to 2 minutes for the user to complete 2FA
      const maxWaitTime = 120000; // 120 seconds
      const checkInterval = 2000; // Check every 2 seconds
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        // Check if we've successfully navigated to the accounts page
        currentUrl = page.url();
        if (currentUrl.includes('/etx/hw/accounts') || currentUrl.includes('/etx/hw/v2/accountshome')) {
          debug('2FA completed successfully - redirected to accounts page');
          return;
        }

        // Check if we're still on 2FA page
        const stillOn2FA =
          currentUrl === 'https://us.etrade.com/etx/pxy/login/sendotpcode' ||
          currentUrl === 'https://us.etrade.com/etx/pxy/login/verifyotpcode';

        if (!stillOn2FA) {
          debug('2FA page changed - checking for success');
          // Give it a moment to redirect
          await new Promise(resolve => setTimeout(resolve, 2000));
          return;
        }

        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, checkInterval));
        debug('Still waiting for 2FA completion... (%d seconds elapsed)', Math.floor((Date.now() - startTime) / 1000));
      }

      debug('2FA timeout - user did not complete 2FA within 60 seconds');
      throw new Error('2FA timeout - please complete 2FA within 60 seconds');
    } else {
      debug('No 2FA screen detected, proceeding normally');
    }
  } catch (error) {
    debug('Error handling 2FA: %s', error);
    throw error;
  }
}

async function scrapeAccountData(page: Page, accountName: string, accountSymbol: string, accountNumber: string) {
  debug('Scraping data for account: %s (%s)', accountName, accountSymbol);

  // Click "View All" button to see all holdings
  debug('Looking for View All button');
  const viewAllButton = await page.evaluateHandle(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find(btn => btn.textContent?.includes('View All')) || null;
  });

  const buttonExists = await page.evaluate(btn => btn !== null, viewAllButton);
  if (buttonExists) {
    debug('Clicking View All button');
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const viewAllBtn = buttons.find(btn => btn.textContent?.includes('View All'));
      if (viewAllBtn) {
        viewAllBtn.click();
      }
    });
    // Wait for the expanded table to load
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Extract holdings data from the table
  const holdingsData = await page.evaluate(() => {
    const holdings: Array<{
      dateAcquired: string;
      benefitType: string;
      sellableQty: number;
      expectedGainLoss: number;
      capitalGainsStatus: string;
      costBasisPerShare: number;
      estMarketValue: number;
    }> = [];

    // Find all table rows in the tbody
    const rows = document.querySelectorAll('.spTable tbody tr.spTableRow');

    rows.forEach(row => {
      try {
        const cells = row.querySelectorAll('td');
        if (cells.length < 8) return; // Skip if not enough columns

        // Extract data from each cell
        const dateAcquired = cells[1]?.textContent?.trim() || '';
        const benefitType = cells[2]?.textContent?.trim() || '';
        const sellableQtyText = cells[3]?.textContent?.trim() || '0';
        const sellableQty = parseInt(sellableQtyText, 10);

        // Extract Expected Gain/Loss (remove +/- and $, convert to number)
        const expectedGainLossText = cells[4]?.textContent?.trim() || '+$0.00';
        const expectedGainLossMatch = expectedGainLossText.match(/([+-])?\$([0-9,]+\.\d{2})/);
        const expectedGainLoss = expectedGainLossMatch
          ? parseFloat((expectedGainLossMatch[1] === '-' ? '-' : '') + expectedGainLossMatch[2].replace(/,/g, ''))
          : 0;

        const capitalGainsStatus = cells[5]?.textContent?.trim() || '';

        // Extract Cost Basis (per share)
        const costBasisText = cells[6]?.textContent?.trim() || '$0.00';
        const costBasisMatch = costBasisText.match(/\$([0-9,]+\.\d{2})/);
        const costBasisPerShare = costBasisMatch ? parseFloat(costBasisMatch[1].replace(/,/g, '')) : 0;

        // Extract Est. Market Value
        const estMarketValueText = cells[7]?.textContent?.trim() || '$0.00';
        const estMarketValueMatch = estMarketValueText.match(/\$([0-9,]+\.\d{2})/);
        const estMarketValue = estMarketValueMatch ? parseFloat(estMarketValueMatch[1].replace(/,/g, '')) : 0;

        holdings.push({
          dateAcquired,
          benefitType,
          sellableQty,
          expectedGainLoss,
          capitalGainsStatus,
          costBasisPerShare,
          estMarketValue,
        });
      } catch (e) {
        // Skip rows that can't be parsed
      }
    });

    return holdings;
  });

  debug('Found %d holdings in table', holdingsData.length);

  // Calculate total market value by summing individual holding values
  const totalMarketValue = holdingsData.reduce((sum, holding) => sum + holding.estMarketValue, 0);
  debug('Total market value (calculated from holdings): %s', totalMarketValue);

  // Calculate total gain/loss from all holdings
  const totalExpectedGainLoss = holdingsData.reduce((sum, holding) => sum + holding.expectedGainLoss, 0);
  const totalSellableQty = holdingsData.reduce((sum, holding) => sum + holding.sellableQty, 0);

  return {
    accountName,
    accountSymbol,
    accountNumber,
    totalMarketValue,
    totalExpectedGainLoss,
    totalSellableQty,
  };
}

async function fetchAccountData(page: Page) {
  debug('Starting to fetch account data');

  const finalAccounts: TransactionsAccount[] = [];
  const processedAccounts = new Set<string>();

  try {
    let accountIndex = 0;
    let previousAccountName = '';

    // Keep processing accounts until we encounter one we've already processed
    while (true) {
      const stockPlanUrl = `https://us.etrade.com/etx/sp/stockplan?accountIndex=${accountIndex}&traxui=tsp_portfolios/#/holdings/byStatus`;
      debug('Navigating to account index %d: %s', accountIndex, stockPlanUrl);

      try {
        await page.goto(stockPlanUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      } catch (error) {
        debug('Navigation failed for accountIndex %d: %s', accountIndex, error);
        break;
      }

      // Wait for both the table and dropdown to be visible
      try {
        await page.waitForSelector('.spTable', { timeout: 30000 });
        await page.waitForSelector('.dropdown-toggle', { timeout: 30000 });
      } catch (error) {
        debug('Required selectors not found for accountIndex %d', accountIndex);
        break;
      }

      // Wait for dynamic content to load
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Extract current account information from dropdown with detailed debugging
      const accountExtraction = await page.evaluate(() => {
        // Find all dropdown-toggle elements
        const allDropdowns = Array.from(document.querySelectorAll('.dropdown-toggle'));

        if (allDropdowns.length === 0) {
          return {
            success: false,
            error: 'No dropdown buttons found with selector .dropdown-toggle',
          };
        }

        // Find the dropdown that contains the account info (matches the pattern with parentheses)
        let dropdownButton: HTMLElement | null = null;
        for (const dropdown of allDropdowns) {
          const text = dropdown.textContent?.trim() || '';
          if (text.match(/^(.+?)\s*\(([A-Z0-9]+)\)/)) {
            dropdownButton = dropdown as HTMLElement;
            break;
          }
        }

        if (!dropdownButton) {
          // Return all dropdown-toggle elements for inspection
          return {
            success: false,
            error: 'No dropdown matched the account pattern',
            allDropdownElements: allDropdowns.map(el => ({
              text: el.textContent?.trim(),
              className: el.className,
            })),
            regexPattern: '^(.+?)\\s*\\(([A-Z0-9]+)\\)',
          };
        }

        const buttonText = dropdownButton.textContent?.trim() || '';
        const accountMatch = buttonText.match(/^(.+?)\s*\(([A-Z0-9]+)\)\s*-?(\d+)/);

        if (!accountMatch) {
          return {
            success: false,
            error: 'Regex failed to match even though initial check passed',
            buttonText: buttonText,
          };
        }

        return {
          success: true,
          name: accountMatch[1].trim(),
          symbol: accountMatch[2],
          accountNumber: accountMatch[3],
          text: buttonText,
        };
      });

      if (!accountExtraction.success) {
        debug('Account extraction failed at accountIndex %d: %s', accountIndex, accountExtraction.error);
        debug('Extraction details: %O', accountExtraction);
        break;
      }

      const accountInfo = accountExtraction as {
        success: true;
        name: string;
        symbol: string;
        accountNumber: string;
        text: string;
      };

      debug('Found account at index %d: %s (%s)', accountIndex, accountInfo.name, accountInfo.symbol);

      // Check if we've already processed this account (indicating we've cycled through all)
      if (previousAccountName === accountInfo.name) {
        debug('Encountered same account name again (%s), all accounts processed', accountInfo.name);
        break;
      }

      // Skip if we've already processed this account
      if (processedAccounts.has(accountInfo.name)) {
        debug('Account %s already processed, skipping', accountInfo.name);
        accountIndex++;
        continue;
      }

      processedAccounts.add(accountInfo.name);
      previousAccountName = accountInfo.name;

      try {
        const accountData = await scrapeAccountData(
          page,
          accountInfo.name,
          accountInfo.symbol,
          accountInfo.accountNumber,
        );

        if (accountData.totalMarketValue > 0) {
          // Calculate change percentage
          const costBasis = accountData.totalMarketValue - accountData.totalExpectedGainLoss;
          const changePercentage = costBasis > 0 ? (accountData.totalExpectedGainLoss / costBasis) * 100 : 0;

          const security: Security = {
            name: accountInfo.name,
            symbol: accountInfo.symbol,
            volume: accountData.totalSellableQty,
            value: roundToTwoDecimals(accountData.totalMarketValue),
            currency: DOLLAR_CURRENCY,
            changePercentage: roundToTwoDecimals(changePercentage),
            profitLoss: roundToTwoDecimals(accountData.totalExpectedGainLoss),
          };

          finalAccounts.push({
            accountNumber: accountInfo.accountNumber,
            balance: roundToTwoDecimals(accountData.totalMarketValue),
            currency: DOLLAR_CURRENCY,
            txns: [],
            savingsAccount: true,
            securities: [security],
          });

          debug('Added account %s with balance %s', accountInfo.symbol, accountData.totalMarketValue);
        }
      } catch (error) {
        debug('Error processing account %s at index %d: %s', accountInfo.symbol, accountIndex, error);
      }

      accountIndex++;

      // Safety limit to prevent infinite loops
      if (accountIndex > 50) {
        debug('Reached account index limit, stopping');
        break;
      }
    }

    debug('Successfully fetched %d accounts', finalAccounts.length);
  } catch (error) {
    debug('Error fetching account data: %s', error);
    throw error;
  }

  return {
    success: true,
    accounts: finalAccounts,
  };
}

type ScraperSpecificCredentials = { username: string; password: string };

class ETradeScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  get baseUrl() {
    return 'https://us.etrade.com';
  }

  getLoginOptions(credentials: ScraperSpecificCredentials) {
    return {
      loginUrl: `${this.baseUrl}/etx/pxy/login`,
      fields: createLoginFields(credentials),
      submitButtonSelector: '#mfaLogonButton',
      preAction: async () => selectTargetPage(this.page),
      postAction: async () => {
        await waitForRedirect(this.page);
        const isHeadless = !(this.options as any).showBrowser;
        await handleTwoFactor(this.page, isHeadless);
      },
      possibleResults: getPossibleLoginResults(this.baseUrl),
    };
  }

  async fetchData() {
    return fetchAccountData(this.page);
  }
}

export default ETradeScraper;
