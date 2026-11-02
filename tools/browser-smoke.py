import os
"""Offline Chromium visual and simulated private-state sync QA. No network or live access."""
from playwright.sync_api import sync_playwright
from pathlib import Path
import json
root=Path(__file__).resolve().parent.parent
html=(root/'hosted-dist/index.html').read_text().replace(r"if(!/^https:\/\//.test(location.origin))return;",'if(false)return;')
seed={'revision':0,'updatedAt':None,'exists':False,'state':{'version':1,'prefs':{'theme':'obsidian','accent':'cyan','density':'compact','motion':'system','contrast':'normal'},'drafts':[],'feedback':[],'outcomes':[],'history':[]}}
script="""
window.__fakeDB=SEED;
window.__calls=[];
let count=1;
if(typeof crypto.randomUUID!=='function')crypto.randomUUID=()=>`12345678-1234-4123-8123-${String(count++).padStart(12,'0')}`;
window.fetch=async (path,options={})=>{
  if(path!='/api/state')return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});
  window.__calls.push({method:options.method||'GET'});
  if((options.method||'GET')==='GET')return new Response(JSON.stringify(window.__fakeDB),{status:200,headers:{'Content-Type':'application/json'}});
  const input=JSON.parse(options.body);
  if(input.expectedRevision!==window.__fakeDB.revision)return new Response('{"error":"revision_conflict"}',{status:409,headers:{'Content-Type':'application/json'}});
  window.__fakeDB={revision:window.__fakeDB.revision+1,state:input.state,exists:true,updatedAt:0};
  return new Response(JSON.stringify({saved:true,revision:window.__fakeDB.revision,updatedAt:0}),{status:200,headers:{'Content-Type':'application/json'}});
};
"""
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('DS_CHROME','/usr/bin/chromium'),args=['--no-sandbox'])
    for viewport in [{'width':390,'height':844},{'width':1200,'height':900}]:
        ctx=browser.new_context(viewport=viewport,is_mobile=(viewport['width']==390),has_touch=(viewport['width']==390))
        # Inject before the document's main inline script executes.
        ctx.add_init_script(script.replace('SEED',json.dumps(seed)))
        page=ctx.new_page()
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(html,wait_until='domcontentloaded')
        page.locator('#local-state').get_by_text('Private storage connected',exact=False).wait_for(timeout=15000,state='attached')
        assert not errors,errors
        page.screenshot(path=str(root/'deployment'/f'v04-smoke-{viewport["width"]}.png'),full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2')
        if viewport['width']==390:
            page.locator('#capture-open').click()
            page.locator('#capture-text').fill('Verify cloud sync across devices')
            page.locator('#capture-form button[type=submit]').click()
            page.locator('#local-state').get_by_text('Private storage synced',exact=False).wait_for(timeout=15000,state='attached')
            seed=page.evaluate('window.__fakeDB')
            assert len(seed['state']['drafts'])==1,seed
            assert seed['state']['drafts'][0]['title']=='Verify cloud sync across devices'
            print('iPhone capture persisted in simulated backend:',seed['revision'])
        else:
            page.locator('[data-go="inbox"]').first.click()
            page.get_by_text('Verify cloud sync across devices').wait_for(timeout=15000,state='attached')
            print('Desktop independent session loaded the saved draft:',seed['revision'])
        print('Viewport',viewport,'pageErrors',errors,'horizontalOverflow',page.evaluate('document.documentElement.scrollWidth-innerWidth'))
        ctx.close()
    browser.close()
print('Browser QA passed (offline, synthetic state).')
