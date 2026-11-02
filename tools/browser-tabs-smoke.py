import os
"""Offline Chromium simulation of shared localStorage + isolated tab sessionStorage.
No browser navigation/network is permitted in this sandbox, so same-origin storage
notifications are injected explicitly. This is NOT a live-device acceptance test.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import copy,json

root=Path(__file__).resolve().parent.parent
html=(root/'hosted-dist/index.html').read_text().replace(r"if(!/^https:\/\//.test(location.origin))return;",'if(false)return;')
empty={'version':1,'prefs':{'theme':'obsidian','accent':'cyan','density':'compact','motion':'system','contrast':'normal'},'drafts':[],'feedback':[],'outcomes':[],'history':[]}
remote={'revision':0,'state':copy.deepcopy(empty),'exists':False,'updatedAt':None}
errors=[]

def backend(path,method,body):
    if path=='/api/state':
        if method=='GET':return {'status':200,'body':copy.deepcopy(remote)}
        if method=='POST':
            x=json.loads(body)
            if x['expectedRevision']!=remote['revision']:
                return {'status':409,'body':{'error':'revision_conflict'}}
            remote.update(revision=remote['revision']+1,state=copy.deepcopy(x['state']),exists=True,updatedAt=0)
            return {'status':200,'body':{'saved':True,'revision':remote['revision'],'updatedAt':0}}
    if path=='/api/portfolio':return {'status':200,'body':{'configured':False,'projects':[]}}
    if path=='/api/notifications/config':return {'status':200,'body':{'configured':False,'publicKey':None}}
    return {'status':404,'body':{'error':'not_found'}}

def wait(page,contains):
    page.locator('#local-state').get_by_text(contains,exact=False).wait_for(timeout=10000,state='attached')

def capture(page,text):
    page.locator('#capture-open').click()
    page.locator('#capture-text').fill(text)
    page.locator('#capture-form button[type=submit]').click()

page_index=0
def page_for(ctx,shared=None,tab=None):
    global page_index
    page_index+=1
    page=ctx.new_page();page.on('pageerror',lambda err:errors.append(str(err)))
    page.expose_function('__stationBackend',backend)
    page.evaluate('''(data)=>{
       window.__store={...data.shared};window.__tabStore={...data.tab};
       let uid=1;crypto.randomUUID=()=>`12345678-1234-4123-8123-${String(data.prefix*100000+uid++).padStart(12,'0')}`;
       Object.defineProperty(window,'localStorage',{configurable:true,value:{
         getItem(k){return Object.hasOwn(window.__store,k)?window.__store[k]:null},
         setItem(k,v){window.__store[k]=String(v)},removeItem(k){delete window.__store[k]}
       }});
       Object.defineProperty(window,'sessionStorage',{configurable:true,value:{
         getItem(k){return Object.hasOwn(window.__tabStore,k)?window.__tabStore[k]:null},
         setItem(k,v){window.__tabStore[k]=String(v)},removeItem(k){delete window.__tabStore[k]}
       }});
       window.fetch=async(path,opt={})=>{
         const response=await window.__stationBackend(path,opt.method||'GET',opt.body||null);
         return new Response(JSON.stringify(response.body),{status:response.status,headers:{'Content-Type':'application/json'}});
       };
    }''',{'shared':shared or {},'tab':tab or {},'prefix':page_index})
    page.set_content(html,wait_until='domcontentloaded')
    return page

def shared(page):return page.evaluate('({...window.__store})')
def tab(page):return page.evaluate('({...window.__tabStore})')

def external_write(source,destination):
    value=shared(source).get('devon-station:local:v1')
    assert value is not None
    destination.evaluate('''value=>{
      const key='devon-station:local:v1';const old=localStorage.getItem(key);
      if(old===value)return;
      window.__store[key]=value;
      const event=new Event('storage');
      Object.defineProperties(event,{key:{value:key},oldValue:{value:old},newValue:{value},storageArea:{value:localStorage}});
      window.dispatchEvent(event);
    }''',value)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('DS_CHROME','/usr/bin/chromium'),args=['--no-sandbox'])
    ctx=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,service_workers='block')
    a=page_for(ctx);wait(a,'Private storage connected')
    capture(a,'Tab A initial');wait(a,'Private storage synced');assert remote['revision']==1
    b=page_for(ctx,shared(a));wait(b,'Private storage connected')
    capture(b,'Tab B independent');wait(b,'Private storage synced');assert remote['revision']==2
    external_write(b,a);wait(a,'Another tab changed device storage')
    capture(a,'Tab A offline divergent');wait(a,'Device-only changes')
    external_write(a,b);wait(b,'Another tab changed device storage')
    capture(b,'Tab B offline divergent');wait(b,'Device-only changes')
    external_write(b,a)
    assert remote['revision']==2
    assert any(x['title']=='Tab A offline divergent' for x in json.loads(tab(a)['devon-station:tab-recovery:v1'])['state']['drafts'])
    # Simulated tab reload: shared storage was last written by B, but A's own
    # sessionStorage persists and must recover A's unsynced draft.
    a_reload=page_for(ctx,shared(b),tab(a));wait(a_reload,'Device changes require review')
    a_reload.locator('button[data-go="inbox"]').first.click()
    a_reload.get_by_text('Tab A offline divergent',exact=True).first.wait_for(timeout=5000)
    a_reload.locator('#cloud-import').click();wait(a_reload,'Device changes safely merged')
    assert remote['revision']==3
    assert a_reload.evaluate("sessionStorage.getItem('devon-station:tab-recovery:v1')") is None
    external_write(a_reload,b)
    assert any(x['title']=='Tab B offline divergent' for x in json.loads(tab(b)['devon-station:tab-recovery:v1'])['state']['drafts'])
    b.locator('#cloud-import').click();wait(b,'Device changes safely merged')
    assert remote['revision']==4
    expected={'Tab A initial','Tab B independent','Tab A offline divergent','Tab B offline divergent'}
    actual=[x['title'] for x in remote['state']['drafts']]
    assert set(actual)==expected and len(actual)==4,actual
    assert b.evaluate("sessionStorage.getItem('devon-station:tab-recovery:v1')") is None
    # Browser/storage clearing (newValue null) must also stage a recoverable
    # copy instead of losing it when the tab reloads.
    c=page_for(ctx,shared(b));wait(c,'Private storage connected')
    c.evaluate('''()=>{
      const key='devon-station:local:v1';const old=localStorage.getItem(key);
      localStorage.removeItem(key);
      const event=new Event('storage');
      Object.defineProperties(event,{key:{value:key},oldValue:{value:old},newValue:{value:null},storageArea:{value:localStorage}});
      window.dispatchEvent(event);
    }''')
    wait(c,'Another tab changed device storage')
    assert len(json.loads(tab(c)['devon-station:tab-recovery:v1'])['state']['drafts'])==4
    assert not errors,errors
    assert b.evaluate('document.documentElement.scrollWidth<=innerWidth+2')
    b.screenshot(path=str(root/'deployment'/'v047-tab-recovery-phone.png'),full_page=True)
    print('PASS: simulated cross-tab storage event, isolated recovery journal, reload, independent edits, reviewed revision sync; final revision',remote['revision'])
    browser.close()
