import os
"""Offline synthetic phone/desktop QA of content-free diagnostics export."""
from pathlib import Path
from tempfile import TemporaryDirectory
from copy import deepcopy
from playwright.sync_api import sync_playwright
import json
root=Path(__file__).resolve().parent.parent
hosted=(root/'hosted-dist/index.html').read_text().replace(r"if(!/^https:\/\//.test(location.origin))return;",'if(false)return;')
seed={'version':1,'prefs':{'theme':'obsidian','accent':'cyan','density':'compact','motion':'system','contrast':'normal'},'drafts':[],'feedback':[],'outcomes':[],'history':[]}
remote={'revision':0,'state':deepcopy(seed),'exists':False,'updatedAt':None}
errors=[]
def backend(path,method,body):
 if path=='/api/state':
  if method=='GET':return {'status':200,'body':deepcopy(remote)}
  data=json.loads(body)
  if data['expectedRevision']!=remote['revision']:return {'status':409,'body':{'error':'revision_conflict'}}
  remote.update(revision=remote['revision']+1,state=deepcopy(data['state']),exists=True,updatedAt=0)
  return {'status':200,'body':{'saved':True,'revision':remote['revision'],'updatedAt':0}}
 if path=='/api/portfolio':return {'status':200,'body':{'configured':False,'projects':[]}}
 return {'status':404,'body':{'error':'not_found'}}
with TemporaryDirectory(prefix='devon-diagnostics-') as temp,sync_playwright() as playwright:
 browser=playwright.chromium.launch(headless=True,executable_path=os.environ.get('DS_CHROME','/usr/bin/chromium'),args=['--no-sandbox'])
 context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,accept_downloads=True,service_workers='block')
 page=context.new_page()
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.expose_function('__backend',backend)
 page.evaluate('''()=>{window.__store={};Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>Object.hasOwn(window.__store,k)?window.__store[k]:null,setItem:(k,v)=>{window.__store[k]=String(v)},removeItem:k=>{delete window.__store[k]}}});crypto.randomUUID=()=> '12345678-1234-4123-8123-123456789012';window.fetch=async(path,opt={})=>{let r=await window.__backend(path,opt.method||'GET',opt.body||null);return new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}})}}''')
 page.set_content(hosted,wait_until='domcontentloaded')
 page.locator('#local-state').get_by_text('Private storage connected',exact=False).wait_for(timeout=10000,state='attached')
 secret='Synthetic-private-draft-TEXT-MUST-NOT-LEAK'
 page.locator('#capture-open').click();page.locator('#capture-text').fill(secret);page.locator('#capture-form button[type=submit]').click()
 page.locator('#local-state').get_by_text('Private storage synced',exact=False).wait_for(timeout=10000,state='attached')
 page.locator('button[data-go="settings"]').first.click()
 panel=page.locator('#recovery-health');panel.get_by_text('1 drafts',exact=False).wait_for(timeout=10000,state='attached')
 assert 'revision 1' in panel.inner_text(),panel.inner_text()
 assert secret not in panel.inner_text()
 with page.expect_download() as download:
  page.locator('button[data-export="diagnostics"]').click()
 file=Path(temp)/download.value.suggested_filename;download.value.save_as(file)
 contents=file.read_text();report=json.loads(contents)
 assert report['kind']=='devon-station-device-diagnostics'
 assert report['device']['draftCount']==1
 assert report['privateSync']['revision']==1
 assert secret not in contents
 assert 'devon@anevum.com' not in contents
 assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2')
 assert not errors,errors
 page.screenshot(path=str(root/'deployment'/'v048-device-health-phone.png'),full_page=True)
 browser.close()
 print('PASS: real browser Settings device-health panel and downloaded diagnostics contain counts, revision, no draft text; synthetic private API')
