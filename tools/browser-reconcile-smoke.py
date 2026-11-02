import os
"""Offline in-memory synthetic browser acceptance: safe multi-device reconciliation.

The injected fetch mock intercepts requests without network access.
No production authentication, database or device is used.
"""
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
import copy,json
root=Path(__file__).resolve().parent.parent
html=(root/'hosted-dist/index.html').read_text().replace(r"if(!/^https:\/\//.test(location.origin))return;",'if(false)return;')
origin='http://127.0.0.1:8765'
empty={'version':1,'prefs':{'theme':'obsidian','accent':'cyan','density':'compact','motion':'system','contrast':'normal'},'drafts':[],'feedback':[],'outcomes':[],'history':[]}
state={'revision':0,'updatedAt':None,'exists':False,'state':copy.deepcopy(empty)}
logs=[]

def handle_backend(path,method,body):
    if path=='/api/state':
        if method=='GET':return {'status':200,'body':state}
        if method=='POST':
            obj=json.loads(body)
            if obj['expectedRevision']!=state['revision']:
                logs.append('conflict');return {'status':409,'body':{'error':'revision_conflict'}}
            state.update({'revision':state['revision']+1,'state':copy.deepcopy(obj['state']),'exists':True,'updatedAt':0})
            logs.append(f'write:{state["revision"]}')
            return {'status':200,'body':{'saved':True,'revision':state['revision'],'updatedAt':0}}
    if path=='/api/portfolio':return {'status':200,'body':{'configured':False,'projects':[],'notionWrites':False}}
    if path=='/api/notifications/config':return {'status':200,'body':{'configured':False,'publicKey':None}}
    return {'status':404,'body':{'error':'not_found'}}

def capture(page,name):
    page.locator('#capture-open').click()
    page.locator('#capture-text').fill(name)
    page.locator('#capture-form button[type=submit]').click()

def status(page,text):
    page.locator('#local-state').get_by_text(text,exact=False).wait_for(timeout=15000,state='attached')

page_counter=0
def page_for(ctx,seed=None,confirmed_tab=None):
    global page_counter
    page_counter+=1
    page=ctx.new_page()
    page.on('pageerror',lambda err: errors.append(str(err)))
    page.expose_function('__stationBackend',handle_backend)
    page.evaluate('''(input)=>{
      window.__store={...(input.storage||{})};
      window.__tabStore={...(input.tabStorage||{})};
      Object.defineProperty(window,'sessionStorage',{configurable:true,value:{
       getItem(k){return Object.hasOwn(window.__tabStore,k)?window.__tabStore[k]:null},
       setItem(k,v){window.__tabStore[k]=String(v)},removeItem(k){delete window.__tabStore[k]}
      }});
      let uid=1;crypto.randomUUID=()=>`12345678-1234-4123-8123-${String(input.prefix*100000+uid++).padStart(12,'0')}`;
      Object.defineProperty(window,'localStorage',{configurable:true,value:{
       getItem(k){return Object.hasOwn(window.__store,k)?window.__store[k]:null},
       setItem(k,v){window.__store[k]=String(v)},removeItem(k){delete window.__store[k]}
      }});
      window.fetch=async(path,options={})=>{
       const result=await window.__stationBackend(path,options.method||'GET',options.body||null);
       return new Response(JSON.stringify(result.body),{status:result.status,headers:{'Content-Type':'application/json'}});
      };
    }''',{'storage':seed or {},'prefix':page_counter,'tabStorage':{'devon-station:confirmed:tab:v2':confirmed_tab} if confirmed_tab else {}})
    page.set_content(html,wait_until='domcontentloaded')
    return page

errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('DS_CHROME','/usr/bin/chromium'),args=['--no-sandbox'])
    def context(**args):
        return browser.new_context(service_workers='block',**args)
    a=context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    pa=page_for(a);status(pa,'Private storage connected')
    capture(pa,'Original capture from phone')
    status(pa,'Private storage synced')
    assert state['revision']==1
    assert len(state['state']['drafts'])==1
    b=context(viewport={'width':1200,'height':900});pb=page_for(b)
    status(pb,'Private storage connected')
    pb.locator('button[data-go="inbox"]').first.click()
    pb.get_by_text('Original capture from phone',exact=True).first.wait_for(timeout=10000)
    capture(pb,'Independent desktop task')
    status(pb,'Private storage synced')
    assert state['revision']==2
    # Save the synchronized desktop session before editing, for clean-reload testing.
    clean_state=pb.evaluate('({...window.__store})')
    clean_confirmed=pb.evaluate("sessionStorage.getItem('devon-station:confirmed:tab:v2')")
    assert clean_confirmed, 'Synced tab should have its own confirmed revision'
    capture(pa,'Another phone task after desktop changed')
    status(pa,'Sync conflict')
    assert state['revision']==2
    assert not pa.locator('#cloud-import').is_hidden()
    pa.locator('#cloud-import').click()
    status(pa,'Device changes safely merged')
    assert state['revision']==3
    assert set(x['title'] for x in state['state']['drafts'])=={
       'Original capture from phone','Independent desktop task','Another phone task after desktop changed'}
    # An old clean device must accept a newer cloud revision without false import.
    clean=context(viewport={'width':1200,'height':900})
    pclean=page_for(clean,clean_state,clean_confirmed)
    status(pclean,'Private storage connected')
    pclean.locator('button[data-go="inbox"]').first.click()
    pclean.get_by_text('Another phone task after desktop changed',exact=True).first.wait_for(timeout=10000)
    assert pclean.locator('#cloud-import').is_hidden()
    # Concurrency: edit the same original item on two sessions, and block
    # reconciliation rather than silently overwriting remote edits.
    pb.locator('button[data-go="inbox"]').first.click()
    pb.locator('article.draft').filter(has_text='Original capture from phone').locator('button[data-edit-draft]').click()
    pb.locator('#capture-text').fill('Desktop divergent edit')
    # Keep it unsent until the remote phone has committed another edit.
    pa.locator('button[data-go="inbox"]').first.click()
    pa.locator('article.draft').filter(has_text='Original capture from phone').locator('button[data-edit-draft]').click()
    pa.locator('#capture-text').fill('Phone divergent edit')
    pa.locator('#capture-form button[type=submit]').click()
    status(pa,'Private storage synced')
    assert state['revision']==4
    pb.locator('#capture-form button[type=submit]').click()
    status(pb,'Sync conflict')
    pb.locator('#cloud-import').click()
    status(pb,'conflicting edit')
    assert state['revision']==4
    assert any(x['title']=='Phone divergent edit' for x in state['state']['drafts'])
    assert all(x['title']!='Desktop divergent edit' for x in state['state']['drafts'])
    assert not errors,errors
    pa.screenshot(path=str(root/'deployment'/'v044-reconcile-phone.png'),full_page=True)
    pb.screenshot(path=str(root/'deployment'/'v044-conflict-desktop.png'),full_page=True)
    print('PASS: separate-session persistence, clean rebase, safe automatic merge, conflicting edit rejection')
    print('Final synthetic revision:',state['revision'],'backend logs:',logs)
    browser.close()
