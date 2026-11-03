import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
const version='20261102-glass-neon';
const expected=[
 ['icon-192.png',192,'d38cc1fac35c7cddca43be72786cff7fa244c4675eb044a774d1e6b6447c1421'],
 ['icon-512.png',512,'a833d91e707a76e80682bf3254fc454fd23b71caebc2c9f69604e22fca624926'],
 ['apple-touch-icon.png',180,'91744d784a7670e4f36291c015871ffd603c029b08de52ce1e9a0a56d18af926'],
];
const read=p=>readFileSync(new URL(p,root));
test('approved neon glass PWA icon PNGs match exact bytes and dimensions',()=>{
 for(const [name,size,sha256] of expected){
  const data=read('pwa/icons/'+name);
  assert.equal(data.subarray(0,8).toString('hex'),'89504e470d0a1a0a',name+' PNG signature');
  assert.equal(data.readUInt32BE(16),size,name+' width');
  assert.equal(data.readUInt32BE(20),size,name+' height');
  assert.equal(createHash('sha256').update(data).digest('hex'),sha256,name+' approved artwork digest');
 }
});
test('manifest and iOS icon links use the approved cache-busted assets',()=>{
 const manifest=JSON.parse(read('pwa/manifest.webmanifest').toString('utf8'));
 assert.equal(manifest.name,'Devon Station');
 assert.equal(manifest.id,'/');
 assert.equal(manifest.icons.length,2);
 assert.deepEqual(manifest.icons.map(x=>x.src),['/icons/icon-192.png?v='+version,'/icons/icon-512.png?v='+version]);
 assert.deepEqual(manifest.icons.map(x=>x.sizes),['192x192','512x512']);
 const page=read('src/index.html').toString('utf8');
 assert.ok(page.includes('href="/manifest.webmanifest?v='+version+'"'));
 assert.ok(page.includes('href="/icons/icon-192.png?v='+version+'"'));
 assert.ok(page.includes('href="/icons/apple-touch-icon.png?v='+version+'"'));
});
