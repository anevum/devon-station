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
      const context=await browser.newContext({viewport,deviceScaleFactor:1});
      const page=await context.newPage();
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
      await page.screenshot({path:`browser-results/preview-${viewport.width}.png`,fullPage:true});
      const results=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
      assert.deepEqual(results.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>n.target)})),[],`accessibility violations at ${viewport.width}`);
      console.log(`PASS ${viewport.width}x${viewport.height}: layout, keyboard, proposal, approval, WCAG automated checks`);
      await context.close();
    }
    // Approved portfolio preview: only fabricated, explicitly granted metadata.
    // This validates the *same existing UI* with a real integration contract,
    // without using client, household, business, or production source data.
    const { approvedProjectsForIdentity } = await import('../interop/approved-portfolio.mjs');
    const identity={principalId:'demo-owner',role:'owner',scopeKind:'personal',scopeId:'demo-scope'};
    const notionUrl='https://app.notion.com/p/'+'a'.repeat(32);
    const projection=approvedProjectsForIdentity({
      identity,
      portfolio:{
        source:'Notion project portfolio',mode:'read_only_cache',
        notionWrites:false,cachedAt:Date.parse('2026-10-31T18:00:00.000Z'),
        projects:[
          {id:'DS-011',area:'Devon Works',name:'Synthetic Approved Project',record:notionUrl,
            next:'private synthetic note that must stay excluded'},
          {id:'SH-011',area:'Shinewell',name:'Unapproved Business Project',record:notionUrl}
        ]
      },
      projectGrants:[{...identity,projectId:'DS-011',area:'Devon Works',role:undefined}]
        .map(({principalId,scopeKind,scopeId,projectId,area})=>({principalId,scopeKind,scopeId,projectId,area}))
    });
    const approvedDemo=await startDemo({approvedSyntheticProjects:projection.projects});
    try {
      for(const viewport of [{width:1440,height:900},{width:375,height:812},{width:320,height:720}]) {
        const context=await browser.newContext({viewport,deviceScaleFactor:1});
        const page=await context.newPage();
        page.on('pageerror', error=>errors.push(error.message));
        await page.goto(approvedDemo.origin);
        await page.getByRole('button',{name:/Synthetic Approved Project/}).waitFor();
        assert.equal(await page.locator('#project-title').innerText(),'Synthetic Approved Project');
        assert.equal(await page.locator('#projects .project').count(),1);
        assert.equal(await page.locator('#source-info a').getAttribute('href'),notionUrl);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),
          true,'approved projection must not overflow viewport '+viewport.width);
        assert(!((await page.locator('body').innerText()).includes('Unapproved Business Project')));
        assert(!((await page.locator('body').innerText()).includes('private synthetic note')));
        const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
        assert.deepEqual(axe.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),
          [],'approved project UI accessibility at '+viewport.width);
        await page.screenshot({path:`browser-results/approved-project-${viewport.width}.png`,fullPage:true});
        console.log(`PASS approved projection ${viewport.width}x${viewport.height}: scoped source, privacy, layout, automated WCAG checks`);
        await context.close();
      }
    } finally { await approvedDemo.close(); }
    assert.deepEqual(errors,[],'uncaught page errors');
  } finally { await browser.close(); await demo.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
