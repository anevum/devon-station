import os
"""Offline synthetic browser acceptance for passphrase-protected device recovery.

The private API is mocked. No credentials, production data, Cloudflare calls or
real Notion records are used. This test deliberately checks that restoration
never writes to cloud without an explicit review.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
from tempfile import TemporaryDirectory
from copy import deepcopy
import json

root=Path(__file__).resolve().parent.parent
hosted=(root/'hosted-dist/index.html').read_text().replace(r"if(!/^https:\/\//.test(location.origin))return;",'if(false)return;')
empty={'version':1,'prefs':{'theme':'obsidian','accent':'cyan','density':'compact','motion':'system','contrast':'normal'},'drafts':[],'feedback':[],'outcomes':[],'history':[]}
state={'revision':0,'state':deepcopy(empty),'exists':False,'updatedAt':None}
writes=[]
errors=[]

def backend(path,method,body):
    if path=='/api/state':
        if method=='GET':return {'status':200,'body':deepcopy(state)}
        if method=='POST':
            data=json.loads(body)
            if data['expectedRevision']!=state['revision']:
                return {'status':409,'body':{'error':'revision_conflict'}}
            state.update({'revision':state['revision']+1,'state':deepcopy(data['state']),'exists':True,'updatedAt':0})
            writes.append(state['revision'])
            return {'status':200,'body':{'saved':True,'revision':state['revision'],'updatedAt':0}}
    if path=='/api/portfolio':return {'status':200,'body':{'configured':False,'projects':[],'notionWrites':False}}
    return {'status':404,'body':{'error':'not_found'}}

with TemporaryDirectory(prefix='devon-backup-') as temp, sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('DS_CHROME','/usr/bin/chromium'),args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,accept_downloads=True,service_workers='block')
    page=context.new_page()
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.expose_function('__stationBackend',backend)
    # This browser sandbox blocks all top-level navigations, including localhost.
    # Simulate Web Crypto only for UI flow; real AES-GCM is verified in Node tests.
    page.evaluate('''() => {
      window.__store={};
      Object.defineProperty(window,'localStorage',{configurable:true,value:{
        getItem(k){return Object.hasOwn(window.__store,k)?window.__store[k]:null},
        setItem(k,v){window.__store[k]=String(v)},removeItem(k){delete window.__store[k]}
      }});
      const randomness=crypto.getRandomValues.bind(crypto);
      Object.defineProperty(window,'crypto',{configurable:true,value:{
        getRandomValues:randomness,randomUUID:()=>String(Date.now())+'-1234-4123-8123-123456789012',
        subtle:{
          importKey:async(_type,data)=>({word:new TextDecoder().decode(data)}),
          deriveKey:async(options,source)=>{return {word:source.word,salt:new Uint8Array(options.salt)};},
          encrypt:async(options,key,data)=>{
            const source=new Uint8Array(data),sig=(key.word.length*17+key.word.charCodeAt(0))%256;
            const packed=new Uint8Array(source.length+1);packed[0]=sig;
            for(let i=0;i<source.length;i++)packed[i+1]=source[i]^(sig||1);
            return packed.buffer;
          },
          decrypt:async(options,key,data)=>{
            const source=new Uint8Array(data),sig=(key.word.length*17+key.word.charCodeAt(0))%256;
            if(source[0]!==sig)throw Error('Wrong passphrase');
            const plain=new Uint8Array(source.length-1);
            for(let i=1;i<source.length;i++)plain[i-1]=source[i]^(sig||1);
            return plain.buffer;
          }
        }
      }});
      window.fetch=async(path,options={})=>{
        const r=await window.__stationBackend(path,options.method||'GET',options.body||null);
        return new Response(JSON.stringify(r.body),{status:r.status,headers:{'Content-Type':'application/json'}});
      }
    }''')
    page.set_content(hosted,wait_until='domcontentloaded')
    page.locator('#local-state').get_by_text('Private storage connected',exact=False).wait_for(timeout=15000,state="attached")
    assert page.evaluate('!!window.crypto?.subtle'), 'Synthetic browser crypto did not initialize'

    def capture(title):
        page.locator('#capture-open').click()
        page.locator('#capture-text').fill(title)
        page.locator('#capture-form button[type=submit]').click()
        page.locator('#local-state').get_by_text('Private storage synced',exact=False).wait_for(timeout=15000,state="attached")

    capture('First protected note')
    page.locator('button[data-go=settings]').click()
    page.locator('#backup-create').click()
    page.locator('#backup-passphrase').fill('A longer personal recovery passphrase')
    page.locator('#backup-repeat').fill('A longer personal recovery passphrase')
    with page.expect_download() as download_info:
        page.locator('#backup-submit').click()
    download=download_info.value
    backup_path=Path(temp)/download.suggested_filename
    download.save_as(backup_path)
    contents=backup_path.read_text()
    envelope=json.loads(contents)
    assert envelope['format']=='devon-station-owner-backup'
    assert 'First protected note' not in contents
    assert state['revision']==1

    capture('Second newer cloud note')
    assert state['revision']==2
    page.locator('button[data-go=settings]').click()
    page.locator('#backup-open').click()
    page.locator('#backup-file').set_input_files(str(backup_path))
    page.locator('#backup-passphrase').fill('A longer personal recovery passphrase')
    page.locator('#backup-submit').click()
    page.get_by_text('Decrypted 1 drafts',exact=False).wait_for(timeout=15000,state="attached")
    page.locator('#backup-submit').click()
    page.locator('#backup-dialog').wait_for(state='hidden')
    assert state['revision']==2,'Restore must not modify cloud without explicit review'
    assert len(writes)==2
    page.locator('#cloud-import').click()
    page.locator('#local-state').get_by_text('Device changes safely merged',exact=False).wait_for(timeout=15000,state="attached")
    assert state['revision']==3
    assert len(state['state']['drafts'])==2

    page.locator('#backup-open').click()
    page.locator('#backup-file').set_input_files(str(backup_path))
    page.locator('#backup-passphrase').fill('Another long wrong recovery passphrase')
    page.locator('#backup-submit').click()
    page.get_by_text('Passphrase is incorrect or this file was changed.',exact=True).wait_for(timeout=15000,state="attached")
    assert state['revision']==3
    assert len(writes)==3
    page.locator('#backup-cancel').click()
    # A quota/security error must not make an owner believe a restore succeeded.
    page.locator('#backup-open').click()
    page.locator('#backup-file').set_input_files(str(backup_path))
    page.locator('#backup-passphrase').fill('A longer personal recovery passphrase')
    page.locator('#backup-submit').click()
    page.get_by_text('Decrypted 1 drafts',exact=False).wait_for(timeout=15000,state='attached')
    page.evaluate('''() => {window.__originalSetItem=localStorage.setItem;localStorage.setItem=()=>{throw Error('Quota reached')}}''')
    page.locator('#backup-submit').click()
    page.get_by_text('Device storage could not save the restored copy.',exact=False).wait_for(timeout=15000,state='attached')
    assert state['revision']==3
    page.evaluate('''() => {localStorage.setItem=window.__originalSetItem}''')
    page.locator('#backup-submit').click()
    page.locator('#backup-dialog').wait_for(state='hidden')
    assert state['revision']==3
    assert not errors,errors
    overflow=page.evaluate('Math.max(0,document.documentElement.scrollWidth-window.innerWidth)')
    assert overflow==0,overflow
    page.screenshot(path=str(root/'deployment'/'v045-encrypted-backup-mobile.png'),full_page=True)
    browser.close()
    print('PASS: backup UI, staged restore, unchanged cloud, explicit review, wrong passphrase (synthetic crypto); real cryptography separately verified in Node tests')
