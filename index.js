const path = require('path');
const puppeteer = require('puppeteer-core');
const yargs = require('yargs');
const request = require('request');
const inquirer = require('inquirer');
const chalk = require('chalk');

yargs.options({
  owner: {
    alias: 'o',
    describe: 'github repo owner',
    demandOption: true,
  },
  repo: {
    alias: 'r',
    describe: 'github repo name',
    demandOption: true,
  },
  pr: {
    alias: 'p',
    describe: 'pull request number',
    demandOption: true,
  },
  usr: {
    alias: 'u',
    describe: 'github username',
    demandOption: true,
  },
  pwd: {
    alias: 'w',
    describe: 'github password',
    demandOption: true,
  },
  token: {
    alias: 't',
    describe: 'github repo personal token',
    demandOption: true,
  },
});

const argv = yargs.argv;
const Status = {
  UNKNOWN: 'unknown',
  PENDING_REVIEW: 'pending_review',
  CHANGE_REQUEST: 'change_request',
  TEST_FAILED: 'test_failed',
  UPDATABLE: 'updatable',
  MERGABLE: 'mergable',
}
const infinite = 1e9;
const baseUrl = 'https://github.com';
const loginPath = path.join(baseUrl, 'login');
const prPath = path.join(baseUrl, argv.owner, argv.repo, 'pull', argv.pr.toString());
const getSinglePrURL = `https://api.github.com/repos/${argv.owner}/${argv.repo}/pulls/${argv.pr}`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage();

  // Login.
  await page.goto(loginPath);
  const usrEl = await page.$('#login_field');
  await usrEl.type(argv.usr);
  const pwdEl = await page.$('#password');
  await pwdEl.type(argv.pwd);
  const sbmEl = await page.$('input[type="submit"]');
  await sbmEl.click();
  await page.waitForNavigation();

  // Two-factor auth.
  const otpEl = await page.$('#otp');
  const inputs = await inquirer.prompt([{ type: 'input', name: 'two-factor code' }]);
  await otpEl.type(inputs['two-factor code'].toString());
  await otpEl.press('Enter');

  // Merge or update branch.
  await page.waitForNavigation();
  await page.goto(prPath);
  let complete = false;
  while (!complete) {
    // Check PR status.
    const sttEl = await Promise.race([
      page.waitForXPath('//*[contains(text(), "Code owner review required")]', { timeout: infinite }),
      page.waitForXPath('//*[contains(text(), "Changes requested")]', { timeout: infinite }),
      page.waitForSelector('div[title="Test failed"]', { timeout: infinite }),
      page.waitForSelector('[data-disable-with="Updating branch…"]', { timeout: infinite }),
      page.waitForXPath('//*[contains(text(), "Squash and merge")]', { timeout: infinite }),
    ]);
    try {
      const status = await getStatus(sttEl, page)
      switch (status) {
        default:
        case Status.PENDING_REVIEW:
        case Status.CHANGE_REQUEST:
          throw new Error(`unexpected status ${status} of PR`);
        case Status.UPDATABLE:
          // Update branch.
          await sttEl.click();
          break;
        case Status.MERGABLE:
          const pr = await getPr();
          if (!pr) {
            throw new Error(`cannot get single pr with number ${argv.pr}`);
          }
          await sttEl.click();
          const title = `${pr.title} (#${pr.number})`;

          // Set merge title.
          const titleEl = await page.$('#merge_title_field');
          await page.evaluate(el => el.value = '', titleEl);
          await titleEl.type(title);

          // Set merge message.
          const msgEl = await page.$('#merge_message_field');
          await page.evaluate(el => el.value = '', msgEl)
          await msgEl.type(pr.body);

          // Merge branch.
          const cfmEl = await page.waitForXPath('//*[contains(text(), "Confirm squash and merge")]');
          await cfmEl.click();

          // Delete branch.
          const delEl = await page.waitForXPath('//*[contains(text(), "Delete branch")]');
          await delEl.click();
          complete = true;
          break;
      }
    } catch (err) {
      console.error(`${chalk.red('[error]')} ${err.message}`);
      return;
    }
    await page.waitFor(1000);
  }
  console.info(`${chalk.green('[success]')} PR ${argv.pr} merged`);
  await browser.close();
})();

async function getStatus(elementHandle, page) {
  return await page.evaluate((el, Status) => {
    if (el.innerText === 'Code owner review required') {
      return Status.PENDING_REVIEW;
    }
    if (el.innerText === 'Changes requested') {
      return Status.CHANGE_REQUEST;
    }
    if (el.getAttribute('title') === "Test failed") {
      return Status.TEST_FAILED;
    }
    if (el.getAttribute('data-disable-with') === "Updating branch…") {
      return Status.UPDATABLE;
    }
    if (el.innerText === 'Squash and merge') {
      return Status.MERGABLE;
    }
    return Status.UNKNOWN;
  }, elementHandle, Status);
}

async function getPr() {
  return new Promise((resolve, reject) => {
    request.get(getSinglePrURL, {
      headers: {
        Accept: 'application/vnd.github.shadow-cat-preview+json',
        Authorization: `token ${argv.token}`,
        'content-type': "application/json",
        'User-Agent': 'nodejs',
      }
    }, (err, _, body) => {
        if (err) {
          return reject(err);
        }
        let b = null;
        try {
          b = JSON.parse(body)
        } catch (err) {
          return reject(err);
        }
        return resolve(b);
    });
  })
}
