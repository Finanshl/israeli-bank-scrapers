import { type Page } from 'puppeteer';
import { DOLLAR_CURRENCY } from '../constants';
import { getDebug } from '../helpers/debug';
import { waitForRedirect } from '../helpers/navigation';
import { type TransactionsAccount, type Security } from '../transactions';
import { BaseScraperWithBrowser, LoginResults, type PossibleLoginResults } from './base-scraper-with-browser';

const debug = getDebug('etrade');

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

async function fetchAccountData(page: Page) {
  debug('Starting to fetch account data');

  const finalAccounts: TransactionsAccount[] = [];

  try {
    // Wait for the page to load
    await page.waitForSelector('[class*="WelcomeBanner---dataRowNonExtAc"]', { timeout: 30000 });
    debug('Welcome banner found');

    // Extract total assets
    const totalAssets = await page.evaluate(() => {
      const welcomeBanner = document.querySelector('[class*="WelcomeBanner---dataRowNonExtAc"]');
      if (!welcomeBanner) return null;

      const totalAssetsText = welcomeBanner.textContent || '';
      const match = totalAssetsText.match(/\$([0-9,]+\.\d{2})/);
      return match ? parseFloat(match[1].replace(/,/g, '')) : null;
    });

    debug('Total assets: %s', totalAssets);

    // Log the current URL for debugging
    debug('Current page URL: %s', page.url());

    // Wait a bit longer for dynamic content to load
    await new Promise(resolve => setTimeout(resolve, 3000));
    debug('Waited 3 seconds for dynamic content');

    // Extract individual account information
    const accountsData = await page.evaluate(async () => {
      const accountElements = document.querySelectorAll('[class*="Account---account---"]');

      const accounts: Array<{
        accountNumber: string;
        accountName: string;
        symbol?: string;
        currentValue: number;
        daysGain?: number;
        daysGainPercent?: number;
        totalValue?: number;
      }> = [];

      accountElements.forEach(accountEl => {
        // Click "Show number" button to reveal full account number
        const showNumberBtn = accountEl.querySelector(
          'button[aria-label="Show full account number"]',
        ) as HTMLButtonElement;
        if (showNumberBtn) {
          showNumberBtn.click();
        }
      });

      // Wait a moment for all the clicks to take effect and DOM to update
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Now extract the account information
      accountElements.forEach(accountEl => {
        // Extract account number (after clicking show button and waiting)
        const accountNumberEl = accountEl.querySelector('[class*="Title---id---"]');
        let accountNumber = accountNumberEl?.textContent?.trim() || '';

        // Remove "Account number" text if present and convert spaces to hyphens
        accountNumber = accountNumber
          .replace(/Account number/gi, '')
          .trim()
          .replace(/\s+/g, '-');

        // Extract account name and symbol
        const accountTitleEl = accountEl.querySelector('[id^="account-pre-title-"]');
        const accountName = accountTitleEl?.textContent?.trim() || '';

        const symbolEl = accountEl.querySelector('[id^="account-title-"]');
        const symbolMatch = symbolEl?.textContent?.match(/\(([A-Z]+)\)/);
        const symbol = symbolMatch ? symbolMatch[1] : undefined;

        // Extract values from the data table
        const dataTable = accountEl.querySelector('[class*="Info---dataTable---"]');
        if (!dataTable) {
          return;
        }

        const rows = dataTable.querySelectorAll('tr');
        let currentValue = 0;
        let daysGain: number | undefined;
        let daysGainPercent: number | undefined;
        let totalValue: number | undefined;

        rows.forEach(row => {
          const label = row.querySelector('td:first-child')?.textContent || '';
          const valueEl = row.querySelector('td:last-child');
          const valueText = valueEl?.textContent || '';

          if (label.includes('Current Account')) {
            const match = valueText.match(/\$([0-9,]+\.\d{2})/);
            if (match) currentValue = parseFloat(match[1].replace(/,/g, ''));
          } else if (label.includes("Day's Gain")) {
            const matches = valueText.match(/\$([0-9,]+\.\d{2})\s+\(([0-9.-]+)%\)/);
            if (matches) {
              daysGain = parseFloat(matches[1].replace(/,/g, ''));
              daysGainPercent = parseFloat(matches[2]);
            }
          } else if (label.includes('Total Account')) {
            const match = valueText.match(/\$([0-9,]+\.\d{2})/);
            if (match) totalValue = parseFloat(match[1].replace(/,/g, ''));
          }
        });

        accounts.push({
          accountNumber,
          accountName,
          symbol,
          currentValue,
          daysGain,
          daysGainPercent,
          totalValue,
        });
      });

      return accounts;
    });

    debug('Found %d accounts', accountsData.length);
    for (const accountData of accountsData) {
      const balance = accountData.currentValue; // We use current value because we only care about vested stocks

      // Create securities array if we have symbol information
      const securities: Security[] = [];
      if (accountData.symbol) {
        securities.push({
          name: accountData.accountName,
          symbol: accountData.symbol,
          volume: 0, // Not available in the current view
          value: accountData.currentValue,
          currency: DOLLAR_CURRENCY,
          changePercentage: 0, // accountData.daysGainPercent, // TODO: Replace with overall change percentage
          profitLoss: 0, // accountData.daysGain, // TODO: Replace with overall gain
        });
      }

      finalAccounts.push({
        accountNumber: accountData.accountNumber,
        balance,
        currency: DOLLAR_CURRENCY,
        txns: [], // E-Trade scraper doesn't fetch transactions in this implementation
        savingsAccount: securities.length > 0 ? true : undefined,
        securities: securities.length > 0 ? securities : undefined,
      });

      debug('Added account %s with balance %s', accountData.accountNumber, balance);
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
  // eslint-disable-next-line class-methods-use-this
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
