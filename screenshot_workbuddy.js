const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('http://127.0.0.1:41953', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'E:\\AIcut\\workbuddy_ui.png', fullPage: true });
  console.log('Screenshot saved to E:\\AIcut\\workbuddy_ui.png');
  const text = await page.evaluate(() => document.body.innerText.replace(/\\s+/g, ' ').substring(0, 5000));
  console.log('=== Page text ===');
  console.log(text);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
