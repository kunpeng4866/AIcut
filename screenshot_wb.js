const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  
  // Navigate to WorkBuddy web UI
  await page.goto('http://127.0.0.1:41953', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  
  // Take full page screenshot
  await page.screenshot({ path: 'E:\\AIcut\\workbuddy_fullpage.png', fullPage: true });
  console.log('Full page screenshot saved');
  
  // Also take a viewport screenshot
  await page.screenshot({ path: 'E:\\AIcut\\workbuddy_viewport.png' });
  console.log('Viewport screenshot saved');
  
  // Get the page text content
  const text = await page.evaluate(() => {
    return document.body.innerText.replace(/\s+/g, ' ').substring(0, 8000);
  });
  console.log('=== Page Text Content ===');
  console.log(text);
  
  // Also check what's rendered inside #root
  const rootHtml = await page.evaluate(() => {
    const root = document.getElementById('root');
    return root ? root.innerHTML.substring(0, 5000) : 'No root found';
  });
  console.log('=== Root inner HTML (first 5000 chars) ===');
  console.log(rootHtml);
  
  await browser.close();
})().catch(e => { console.error('Error:', e.message || e); process.exit(1); });
