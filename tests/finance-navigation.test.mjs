import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {SECTIONS} from '../src/core.mjs';

const app = readFileSync(new URL('../src/app.js', import.meta.url),'utf8');
const hotkeyDeclaration=app.match(/^const FINANCE_HOTKEYS=\[[^\n]+\];$/m)?.[0];
const shortcutFunction=app.match(/^function sectionShortcut\(s\)\{[^\n]+\}$/m)?.[0];

function shortcutFixture(){
  assert(hotkeyDeclaration,'explicit pre-finance section hotkey map is required');
  assert(shortcutFunction,'navigation must share one hotkey label formatter');
  const fixture={};
  runInNewContext(hotkeyDeclaration+'\n'+shortcutFunction+'\n'+
    'globalThis.keys=FINANCE_HOTKEYS;globalThis.shortcut=sectionShortcut;',fixture);
  return fixture;
}

test('original Alt 1-9 and Alt 0 shortcuts remain stable when Finance is inserted',()=>{
  const {keys,shortcut}=shortcutFixture();
  assert.deepEqual(Array.from(keys),['command','workspace','inbox','portfolio','works',
    'infrastructure','writing','anevum','reviews','settings']);
  assert(SECTIONS.includes('finance'));
  assert.equal(SECTIONS.length,keys.length+1);
  assert.equal(new Set(keys).size,keys.length);
  for(let index=0;index<keys.length;index++){
    const section=keys[index];
    assert(SECTIONS.includes(section),'orphaned hotkey '+section);
    assert.equal(shortcut(section),'Alt '+(index===9?'0':String(index+1)));
  }
  assert.equal(shortcut('finance'),'','Finance has no misleading duplicate keyboard shortcut');
});

test('Finance navbar uses true shortcut map, accessible hints, not reordered index',()=>{
  assert.match(app,/function nav\(\)\{[\s\S]*?const shortcut=sectionShortcut\(s\)/);
  assert.match(app,/aria-keyshortcuts=/);
  assert.match(app,/go\(FINANCE_HOTKEYS\[e\.key==='0'\?9:Number\(e\.key\)-1\]\)/);
  assert.doesNotMatch(app,/title="\$\{labels\[s\]\} · Alt \$\{\(i\+1\)%10\}"/);
});
