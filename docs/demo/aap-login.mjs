/**
 * Mint a Playwright storage-state file for ansible-ui local dev.
 * Run from the ansible-ui clone root after `npm start` is up on port 4100.
 *
 * Never commit the output (.usabl-session.json) or your credentials.
 */
import { chromium } from 'playwright';

const baseUrl = process.env.AUI_BASE_URL?.replace(/\/+$/, '');
const username = process.env.AAP_USER;
const password = process.env.AAP_PASSWORD;
const storageStatePath = process.env.AUI_STORAGE_STATE;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!baseUrl) fail('Set AUI_BASE_URL (for example http://localhost:4100).');
if (!username) fail('Set AAP_USER.');
if (!password) fail('Set AAP_PASSWORD.');
if (!storageStatePath) fail('Set AUI_STORAGE_STATE (for example ./.usabl-session.json).');

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

const loginUrl = `${baseUrl}/login`;
await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
await page.locator('#pf-login-username-id').waitFor({ state: 'visible', timeout: 60_000 });
await page.fill('#pf-login-username-id', username);
await page.fill('#pf-login-password-id', password);
await page.click('button[type="submit"]');
await page
  .getByTestId('toolbar')
  .getByRole('button', { name: username })
  .waitFor({ state: 'visible', timeout: 30_000 });

await context.storageState({ path: storageStatePath });
await browser.close();

console.log(`Wrote ${storageStatePath}`);
