const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');

(async () => {
  const { startDemo } = await import('../demo/server.mjs');
  const demo = await startDemo();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const errors=[];
  try {
    await fs.mkdir('browser-results', { recursive: true });
    for (const viewport of [{width:1440,height:900},{width:375,height:812},{width:320,height:720}]) {
      const page=await browser.newPage({viewport,deviceScaleFactor:1});
      page.on('pageerror', error=>errors.push(error.message));
      await page.goto(demo.origin);
      await page.getByRole('button',{name:/Creative Studio/}).waitFor();
      assert.equal(await page.title(),'DevonStation · Foundation Preview');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`horizontal overflow at ${viewport.width}`);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'Skip to workspace');
      const home=page.getByRole('button',{name:/Home Systems/});
      await home.focus(); await page.keyboard.press('Enter');
      assert.equal(await home.getAttribute('aria-pressed'),'true');
      assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-pressed')),'true','project selection retains keyboard focus');
      assert.equal(await page.locator('#project-title').innerText(),'Home Systems');
      await page.getByLabel('Propose a next action').fill(`Synthetic step ${viewport.width}`);
      await page.getByRole('button',{name:/Add proposal/}).click();
      await page.getByRole('button',{name:`Approve: Synthetic step ${viewport.width}`}).click();
      await page.getByText('Action approved. No external operation was performed.').waitFor();
      assert.equal(await page.locator('.badge').last().textContent(),'approved');
      const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
      assert.deepEqual(results.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>n.target)})),[],`accessibility violations at ${viewport.width}`);
      await page.screenshot({path:`browser-results/preview-${viewport.width}.png`,fullPage:true});
      console.log(`PASS ${viewport.width}x${viewport.height}: layout, keyboard, proposal, approval, WCAG automated checks`);
      await page.close();
    }
    assert.deepEqual(errors,[],'uncaught page errors');
  } finally { await browser.close(); await demo.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
