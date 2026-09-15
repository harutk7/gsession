import { chromium } from 'playwright';
import path from 'path';
import os from 'os';

const baseDir = path.join(process.cwd(), 'diag-inspect');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDownloadsPath = path.join(os.homedir(), 'Downloads');

async function run(headless) {
  console.log(`\n######## headless=${headless} ########`);
  
  const userDataDir = `${baseDir}-${headless}`;
  const extensionsDir = path.join(baseDir, 'extensions'); 

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless,
    channel: 'chromium', 
    acceptDownloads: true,
    downloadsPath: userDownloadsPath, // Kept as a fallback
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      `--disable-extensions-except=${extensionsDir}`,
      `--load-extension=${extensionsDir}`,
    ],
  });

  const page = ctx.pages()[0] || (await ctx.newPage());

  // -> CRITICAL ADDITION: Intercepts downloads and explicitly saves them to user's real Downloads folder
  page.on('download', async (download) => {
    const fileName = download.suggestedFilename();
    const targetPath = path.join(userDownloadsPath, fileName);
    
    try {
      await download.saveAs(targetPath);
      console.log(`Successfully downloaded and saved to: ${targetPath}`);
    } catch (err) {
      console.error(`Failed to save download ${fileName}:`, err);
    }
  });

  // Track extension loading
  let [serviceWorker] = ctx.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await ctx.waitForEvent('serviceworker').catch(() => null);
  }
  if (serviceWorker) {
    const extensionId = serviceWorker.url().split('/')[2];
    console.log(`Extension loaded successfully with ID: ${extensionId}`);
  }

  console.log(`Downloads monitor active. Target folder: ${userDownloadsPath}`);

  await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);
  
  console.log('flow URL:', page.url().slice(0, 90));
  
  await ctx.close();
}

await run(true);
await run(false);
process.exit(0);