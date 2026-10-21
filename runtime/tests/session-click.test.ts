import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {openSessionBrowser} from '../src/session/browser.ts';
import {createSessionInput} from '../src/session/input.ts';
import type {ResolvedTarget} from '../src/session/contracts.ts';
import type {InputEvent} from '../src/session/events.ts';

const html=`<!doctype html><style>button{margin:30px;width:120px;height:60px}</style>
<button id="first">First</button><button id="second">Second</button>
<script>
window.nativeEvents=[];window.selected=[];
for(const kind of ['pointerdown','pointerup','click','keydown','keyup'])window.addEventListener(kind,event=>{
 window.nativeEvents.push({kind,target:event.target.id,button:event.button,buttons:event.buttons,detail:event.detail,key:event.key,
  altKey:event.altKey,ctrlKey:event.ctrlKey,metaKey:event.metaKey,shiftKey:event.shiftKey,trusted:event.isTrusted});
},true);
for(const button of document.querySelectorAll('button'))button.onclick=event=>{
 window.selected=event.shiftKey||event.metaKey?[...new Set([...window.selected,button.id])]:[button.id];
};
</script>`;
const pacing={minimumApproachMs:0,distanceMsPerPixel:0,targetDwellMs:0,keyDelayMs:0};
const bare={altKey:false,ctrlKey:false,metaKey:false,shiftKey:false};
type ModifierFlags=Pick<InputEvent,'altKey'|'ctrlKey'|'metaKey'|'shiftKey'>;
type NativeEvent=ModifierFlags&{kind:string;key?:string;detail?:number;buttons?:number;trusted:boolean};
const flags=({altKey,ctrlKey,metaKey,shiftKey}:ModifierFlags)=>({altKey,ctrlKey,metaKey,shiftKey});

async function setup(t:TestContext){
  const root=await mkdtemp('/private/tmp/wts-click-');
  const context=await openSessionBrowser({profileDirectory:join(root,'profile'),headless:true,network:'loopback-only'});
  t.after(async()=>{try{await context.close();}finally{await rm(root,{recursive:true,force:true});}});
  const page=await context.newPage();await page.setContent(html);
  return page;
}
async function target(page:Page,selector='#first'):Promise<ResolvedTarget>{
  const element=await page.locator(selector).elementHandle();assert.ok(element);
  const box=await element.boundingBox();assert.ok(box);
  return {page,element,point:{x:box.x+box.width/2,y:box.y+box.height/2},verifyPointer:async()=>{},verifyKeyboard:async()=>{}};
}
async function nativeEvents(page:Page){return page.evaluate(()=>(window as any).nativeEvents as NativeEvent[]);}

test('native Shift and Meta clicks extend selection and later bare clicks retain no modifier state',async t=>{
  const page=await setup(t),events:InputEvent[]=[],driver=createSessionInput(page,event=>{events.push(event);},pacing);
  t.after(()=>driver.dispose());await driver.ready();const first=await target(page),second=await target(page,'#second');
  await driver.click(first);
  for(const modifier of ['Shift','Meta'] as const){
    await driver.click(second,'left',1,[modifier]);
    assert.deepEqual(await page.evaluate(()=>(window as any).selected),['first','second']);
    await driver.click(first);
    assert.deepEqual(await page.evaluate(()=>(window as any).selected),['first']);
  }
  await driver.flush();
  const expected=[bare,{...bare,shiftKey:true},bare,{...bare,metaKey:true},bare];
  const observed=await nativeEvents(page);
  for(const kind of ['pointerdown','pointerup','click'])assert.deepEqual(observed.filter(event=>event.kind===kind).map(flags),expected);
  assert.ok(observed.every(event=>event.trusted));
  assert.deepEqual(events.filter(event=>event.kind==='pointerdown').map(flags),expected);
  assert.deepEqual(events.filter(event=>event.kind==='pointerup').map(flags),expected);
  assert.deepEqual(events.filter(event=>event.kind==='keyboard').map(event=>event.phase),['down','up','down','up']);
  assert.ok(events.every(event=>event.source==='browser'&&event.trusted));
});

test('native double clicks retain the whole modifier chord through both releases',async t=>{
  const page=await setup(t),events:InputEvent[]=[],driver=createSessionInput(page,event=>{events.push(event);},pacing);
  t.after(()=>driver.dispose());await driver.ready();const first=await target(page);
  await driver.click(first,'left',2,['Alt','Shift']);
  await driver.click(first,'left',1,['Control']);
  await driver.click(first);await driver.flush();
  const observed=await nativeEvents(page),modified={...bare,altKey:true,shiftKey:true};
  for(const kind of ['pointerdown','pointerup'])assert.deepEqual(observed.filter(event=>event.kind===kind).map(flags),[modified,modified,{...bare,ctrlKey:true},bare],kind);
  // macOS interprets Control-click as a context-menu gesture. Preserve native
  // behavior rather than requiring a synthetic left-click event as well.
  const clicks=observed.filter(event=>event.kind==='click'&&!event.ctrlKey);
  assert.deepEqual(clicks.map(flags),[modified,modified,bare]);
  assert.deepEqual(clicks.map(event=>event.detail),[1,2,1]);
  assert.deepEqual(observed.filter(event=>event.kind==='keydown'||event.kind==='keyup').map(event=>[event.kind,event.key]),[
    ['keydown','Alt'],['keydown','Shift'],['keyup','Shift'],['keyup','Alt'],
    ['keydown','Control'],['keyup','Control'],
  ]);
  assert.equal(events.filter(event=>event.kind==='pointerup').length,4);
});

test('cancellation after native pointer-down releases the click and modifiers without another click attempt',async t=>{
  const page=await setup(t),events:InputEvent[]=[],abort=new AbortController(),originalDown=page.mouse.down.bind(page.mouse);
  // Cancel exactly after Chromium accepts the first down, before its promise
  // returns to the driver. The input and its release still use the real browser.
  page.mouse.down=async options=>{await originalDown(options);abort.abort();};
  t.after(()=>{page.mouse.down=originalDown;});
  const driver=createSessionInput(page,event=>{events.push(event);},pacing,{signal:abort.signal});
  t.after(()=>driver.dispose());await driver.ready();const first=await target(page);
  await assert.rejects(driver.click(first,'left',2,['Shift','Alt']),{name:'AbortError'});
  assert.equal(events.filter(event=>event.kind==='pointerdown').length,1);
  assert.equal(events.filter(event=>event.kind==='pointerup'&&event.buttons===0).length,1);
  assert.equal(events.filter(event=>event.kind==='keyboard'&&event.phase==='up').length,2);
  assert.equal((await nativeEvents(page)).filter(event=>event.kind==='click').length,1);
  page.mouse.down=originalDown;
  await page.mouse.click(first.point.x,first.point.y);
  const observed=await nativeEvents(page);
  assert.deepEqual(flags(observed.filter(event=>event.kind==='pointerdown').at(-1)!),bare);
  assert.equal(observed.filter(event=>event.kind==='pointerup').at(-1)!.buttons,0);
});

for(const failedInput of ['modifier','pointer'] as const)test(`a ${failedInput}-down error after native dispatch releases every attempted input`,async t=>{
  const page=await setup(t),events:InputEvent[]=[],originalKeyDown=page.keyboard.down.bind(page.keyboard),originalMouseDown=page.mouse.down.bind(page.mouse);
  if(failedInput==='modifier')page.keyboard.down=async key=>{await originalKeyDown(key);if(key==='Alt')throw new Error('SYNTHETIC_DOWN_FAILURE');};
  else page.mouse.down=async options=>{await originalMouseDown(options);throw new Error('SYNTHETIC_DOWN_FAILURE');};
  t.after(()=>{page.keyboard.down=originalKeyDown;page.mouse.down=originalMouseDown;});
  const driver=createSessionInput(page,event=>{events.push(event);},pacing);
  t.after(()=>driver.dispose());await driver.ready();const first=await target(page);
  await assert.rejects(driver.click(first,'left',2,['Shift','Alt']),/SYNTHETIC_DOWN_FAILURE/);
  assert.equal(events.filter(event=>event.kind==='pointerdown').length,failedInput==='pointer'?1:0);
  assert.equal(events.filter(event=>event.kind==='pointerup').length,failedInput==='pointer'?1:0);
  assert.equal(events.filter(event=>event.kind==='keyboard'&&event.phase==='up').length,2);
  page.keyboard.down=originalKeyDown;page.mouse.down=originalMouseDown;
  await driver.click(first);await driver.flush();
  assert.deepEqual(flags(events.filter(event=>event.kind==='pointerdown').at(-1)!),bare);
  assert.equal(events.filter(event=>event.kind==='pointerup').at(-1)!.buttons,0);
});
