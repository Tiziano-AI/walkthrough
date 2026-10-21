import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {createContext,runInContext,type Context} from 'node:vm';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {Frame,Page} from 'playwright';
import {createSessionInput} from '../src/session/input.ts';
import {SessionRuntime} from '../src/session/runtime.ts';
import {SessionError,type SessionConfig,type SessionInfo,type ResolvedTarget} from '../src/session/contracts.ts';
import type {InputEvent} from '../src/session/events.ts';

/** Execute the production browser listener in separate document globals, but
 * drive protocol delivery explicitly. No Chromium or application is opened. */
function browserBoundary(options:{navigateOnUp?:boolean;suppressMove?:boolean;suppressUp?:boolean;suppressKeyUp?:boolean;navigateOnKeyDown?:boolean;deferKeyUpNumber?:number}={}){
  const bindings=new Map<string,(source:{frame:Frame},packet:unknown)=>unknown>();
  const pending:Array<()=>void>=[];
  let context:Context,listeners:Map<string,Set<(event:unknown)=>void>>,scope:Record<string,any>,evaluations=0;
  let down=0,up=0,moves=0,keyUps=0,typed='',inserted='',wheels=0,navigations=0,deferUp=false,deferDragMoves=false,dropUp=false,throwAfterDown:Error|undefined,forbidEvaluation=false;
  const frame={isDetached:()=>false,parentFrame:()=>null,
    evaluate:async(fn:Function,arg:unknown)=>{
      evaluations++;if(forbidEvaluation)throw new Error('frame.evaluate: Execution context was destroyed, most likely because of a navigation');
      return runInContext(`(${fn.toString()})(argument)`,Object.assign(context,{argument:arg}));
    },
  } as unknown as Frame;
  function attachBinding(name:string,callback:(source:{frame:Frame},packet:unknown)=>unknown){
    scope[name]=(packet:any)=>new Promise<void>((resolve,reject)=>{
      const deliver=()=>{try{Promise.resolve(callback({frame},structuredClone(packet))).then(()=>resolve(),reject);}catch(error){reject(error);}};
      if(packet.event.kind==='pointerup'&&dropUp){resolve();return;}
      if(packet.event.kind==='pointerup'&&deferUp||packet.event.kind==='pointermove'&&deferDragMoves&&down>0||packet.event.kind==='keyboard'&&packet.event.phase==='up'&&keyUps===options.deferKeyUpNumber)pending.push(deliver);else deliver();
    });
  }
  function newDocument(){
    listeners=new Map();scope={
      addEventListener:(kind:string,listener:(event:unknown)=>void)=>{if(!listeners.has(kind))listeners.set(kind,new Set());listeners.get(kind)!.add(listener);},
      removeEventListener:(kind:string,listener:(event:unknown)=>void)=>listeners.get(kind)?.delete(listener),
    };
    context=createContext({window:scope,performance:{timeOrigin:10000+navigations*1000,now:()=>10}});
    for(const [name,callback] of bindings)attachBinding(name,callback);
  }
  const event=(type:string)=>{for(const listener of [...listeners.get(type)??[]])listener({type,isTrusted:true,timeStamp:30,clientX:50,clientY:60,button:0,buttons:type==='pointerdown'?1:0,altKey:false,ctrlKey:false,metaKey:false,shiftKey:false});};
  const navigate=()=>{event('pagehide');navigations++;newDocument();forbidEvaluation=true;};
  const page={frames:()=>[frame],mainFrame:()=>frame,isClosed:()=>false,
    exposeBinding:async(name:string,callback:(source:{frame:Frame},packet:unknown)=>unknown)=>{
      bindings.set(name,callback);attachBinding(name,callback);return {dispose:async()=>{bindings.delete(name);delete scope[name];}};
    },
    mouse:{move:async()=>{moves++;if(!options.suppressMove)event('pointermove');},down:async()=>{down++;event('pointerdown');if(throwAfterDown)throw throwAfterDown;},up:async()=>{up++;if(!options.suppressUp)event('pointerup');if(!throwAfterDown&&options.navigateOnUp!==false)navigate();},wheel:async()=>{wheels++;}},
    keyboard:{down:async()=>{event('keydown');if(options.navigateOnKeyDown)navigate();},up:async()=>{keyUps++;if(!options.suppressKeyUp)event('keyup');},type:async(text:string)=>{typed+=text;event('keydown');event('keyup');},insertText:async(text:string)=>{inserted+=text;}},
  } as unknown as Page;
  newDocument();
  const target:ResolvedTarget={page,point:{x:50,y:60},verifyPointer:async()=>{},verifyKeyboard:async()=>{}};
  return {page,target,event,navigate,stats:()=>({down,up,moves,keyUps,typed,inserted,wheels,navigations,evaluations,bindings:bindings.size}),
    defer:()=>{deferUp=true;},drop:()=>{dropUp=true;},release:()=>{for(const deliver of pending.splice(0))deliver();},
    deferDragMoves:()=>{deferDragMoves=true;},
    failDown:(error:Error)=>{throwAfterDown=error;},allowEvaluation:()=>{forbidEvaluation=false;},
  };
}
const pacing={minimumApproachMs:0,distanceMsPerPixel:0,targetDwellMs:0,keyDelayMs:0};
function controlledClock(t:TestContext){
  t.mock.timers.enable({apis:['setTimeout']});syncBuiltinESMExports();
  t.after(()=>{t.mock.timers.reset();syncBuiltinESMExports();});
}
async function settle<T>(t:TestContext,promise:Promise<T>):Promise<T>{
  let completed=false;const result=promise.then(value=>({value}),error=>({error})).finally(()=>{completed=true;});
  for(let tick=0;!completed&&tick<2000;tick++){t.mock.timers.tick(100);await yieldTurn();}
  assert.ok(completed,'the controlled operation must settle');const outcome=await result;if('error'in outcome)throw outcome.error;return outcome.value;
}

test('native click evidence survives navigation without evaluating the departing document',async t=>{
  controlledClock(t);const f=browserBoundary(),events:InputEvent[]=[];
  const driver=createSessionInput(f.page,event=>{events.push(event);},pacing,{now:()=>1000});
  try{
    await driver.ready();const initial=f.stats().evaluations;
    await settle(t,driver.click(f.target));await driver.flush();
    assert.deepEqual(events.map(event=>event.kind),['pointermove','pointerdown','pointerup']);
    assert.deepEqual(events.map(event=>event.atMs),[1020,1020,1020]);
    assert.ok(events.every(event=>event.source==='browser'&&event.trusted));
    assert.equal(f.stats().evaluations,initial,'neither click completion nor evidence drain may evaluate the retired document');
    assert.equal(f.stats().navigations,1);assert.equal(f.stats().down,1);assert.equal(f.stats().up,1);
  }finally{await driver.dispose();}
});

test('input acknowledgement waits for a delayed native receipt after navigation',async t=>{
  controlledClock(t);const f=browserBoundary(),events:InputEvent[]=[];f.defer();
  const driver=createSessionInput(f.page,event=>{events.push(event);},pacing,{now:()=>1000});
  try{
    await driver.ready();let finished=false;const click=driver.click(f.target).finally(()=>{finished=true;});
    for(let step=0;f.stats().up===0&&step<20;step++){t.mock.timers.tick(100);await yieldTurn();}
    assert.equal(f.stats().navigations,1);assert.equal(finished,false);
    f.release();await settle(t,click);await driver.flush();
    assert.equal(events.filter(event=>event.kind==='pointerup').length,1);assert.equal(f.stats().up,1);
  }finally{await driver.dispose();}
});

test('a missing native receipt remains uncertain and never resends an acknowledged release',async t=>{
  controlledClock(t);const f=browserBoundary(),events:InputEvent[]=[];f.drop();
  const driver=createSessionInput(f.page,event=>{events.push(event);},pacing,{now:()=>1000,receiptTimeoutMs:200});
  try{
    await driver.ready();await assert.rejects(settle(t,driver.click(f.target)),{code:'SESSION_INPUT_EVIDENCE_LOST'});await driver.flush();
    assert.deepEqual(events.map(event=>event.kind),['pointermove','pointerdown']);
    assert.equal(f.stats().down,1);assert.equal(f.stats().up,1);
  }finally{await driver.dispose();}
});

test('sink failures do not erase later native events or replace an earlier input failure',async t=>{
  controlledClock(t);const f=browserBoundary(),events:InputEvent[]=[];
  f.failDown(new SessionError('ORIGINAL_INPUT_FAILURE','The native input response failed.'));
  const driver=createSessionInput(f.page,event=>{events.push(event);if(event.kind==='pointerdown')throw new Error('SINK_FAILED');},pacing,{now:()=>1000});
  try{
    await driver.ready();await assert.rejects(settle(t,driver.click(f.target,'left',1,['Shift'])),error=>{
      assert.equal((error as SessionError).code,'ORIGINAL_INPUT_FAILURE');assert.match((error as Error).message,/SINK_FAILED/);return true;
    });
    assert.ok(events.some(event=>event.kind==='pointerup'));assert.ok(events.some(event=>event.kind==='keyboard'&&event.phase==='up'));
    assert.equal(f.stats().down,1);assert.equal(f.stats().up,1);
  }finally{await driver.dispose();}
});

for(const failure of ['cancel','modifier','pointer'] as const)test(`rejected ${failure} click retains a delayed final modifier release before returning`,async t=>{
  controlledClock(t);const f=browserBoundary({navigateOnUp:false,deferKeyUpNumber:2}),events:InputEvent[]=[],abort=new AbortController();
  if(failure==='cancel'){
    const down=f.page.mouse.down.bind(f.page.mouse);f.page.mouse.down=async options=>{await down(options);abort.abort();};
  }else if(failure==='modifier'){
    const down=f.page.keyboard.down.bind(f.page.keyboard);f.page.keyboard.down=async key=>{await down(key);if(key==='Alt')throw new SessionError('ORIGINAL_INPUT_FAILURE');};
  }else f.failDown(new SessionError('ORIGINAL_INPUT_FAILURE'));
  const driver=createSessionInput(f.page,event=>{events.push(event);},pacing,{now:()=>1000,signal:abort.signal});
  let click:Promise<void>|undefined;
  try{
    await driver.ready();let completed=false;
    click=driver.click(f.target,'left',2,['Shift','Alt']).finally(()=>{completed=true;});void click.catch(()=>{});
    for(let step=0;f.stats().keyUps<2&&step<20;step++){t.mock.timers.tick(100);await yieldTurn();}
    assert.equal(f.stats().keyUps,2);await yieldTurn();
    assert.equal(events.filter(event=>event.kind==='keyboard'&&event.phase==='up').length,1);
    assert.equal(completed,false,'the rejected click must still retain its already-emitted final modifier release');
    f.release();await assert.rejects(settle(t,click),failure==='cancel'?{name:'AbortError'}:{code:'ORIGINAL_INPUT_FAILURE'});
    assert.equal(events.filter(event=>event.kind==='keyboard'&&event.phase==='up').length,2);
    assert.equal(f.stats().down,failure==='modifier'?0:1);assert.equal(f.stats().up,failure==='modifier'?0:1);
  }finally{f.release();await driver.dispose();await click?.catch(()=>{});}
});

test('modifier cleanup preserves arbitrary checkpoint evaluation errors',async t=>{
  controlledClock(t);const f=browserBoundary({navigateOnUp:false});
  const driver=createSessionInput(f.page,()=>{},pacing,{now:()=>1000});
  try{
    await driver.ready();f.page.mainFrame().evaluate=async()=>{throw new Error('CHECKPOINT_EVALUATION_FAILED');};
    await assert.rejects(settle(t,driver.click(f.target,'left',1,['Shift'])),/CHECKPOINT_EVALUATION_FAILED/);
    assert.equal(f.stats().keyUps,1);assert.equal(f.stats().up,1);
  }finally{await driver.dispose();}
});

test('disposal removes the binding and ignores evidence delivered after private handoff',async t=>{
  controlledClock(t);const f=browserBoundary(),events:InputEvent[]=[];f.defer();
  const driver=createSessionInput(f.page,event=>{events.push(event);},pacing,{now:()=>1000});
  await driver.ready();const click=driver.click(f.target),rejected=assert.rejects(click,{code:'SESSION_INPUT_DISABLED'});
  for(let step=0;f.stats().up===0&&step<20;step++){t.mock.timers.tick(100);await yieldTurn();}
  await driver.dispose();const count=events.length;f.release();await rejected;await yieldTurn();
  assert.equal(events.length,count);assert.equal(f.stats().bindings,0);
});

test('unchanged pointer, boundary wheel and suppressed modifier release need no invented native event',async t=>{
  controlledClock(t);const f=browserBoundary({navigateOnUp:false,suppressMove:true,suppressKeyUp:true}),events:InputEvent[]=[];
  const driver=createSessionInput(f.page,event=>{events.push(event);},pacing,{now:()=>1000,receiptTimeoutMs:200});
  try{
    await driver.ready();await settle(t,driver.hover(f.target));await settle(t,driver.wheel(f.target,0,120));
    await settle(t,driver.keys(undefined,'Shift+ArrowRight'));await driver.samplePointer();await settle(t,driver.click(f.target,'left',1,['Shift']));
    assert.equal(f.stats().moves,4);assert.equal(f.stats().wheels,1);assert.equal(f.stats().keyUps,3);
    assert.equal(events.filter(event=>event.kind==='pointermove'||event.kind==='wheel'||event.kind==='keyboard'&&event.phase==='up').length,0);
  }finally{await driver.dispose();}
});

test('prevented typing and readonly insertion complete without asserting a text mutation',async t=>{
  controlledClock(t);const f=browserBoundary({navigateOnUp:false}),events:InputEvent[]=[];
  const driver=createSessionInput(f.page,event=>{events.push(event);},pacing,{now:()=>1000,receiptTimeoutMs:200});
  try{
    await driver.ready();await settle(t,driver.text(f.target,'blocked'));await settle(t,driver.text(f.target,'readonly','insert'));
    assert.equal(f.stats().typed,'blocked');assert.equal(f.stats().inserted,'readonly');
    assert.equal(events.filter(event=>event.kind==='input').length,0);
    assert.ok(events.some(event=>event.source==='driver'&&event.kind==='paste'&&event.phase==='end'));
  }finally{await driver.dispose();}
});

test('native HTML drag may omit pointerup and delayed movement evidence never paces individual moves',async t=>{
  controlledClock(t);const f=browserBoundary({navigateOnUp:false,suppressUp:true}),events:InputEvent[]=[];f.deferDragMoves();
  const driver=createSessionInput(f.page,event=>{events.push(event);},pacing,{now:()=>1000});
  let drag:Promise<void>|undefined;
  try{
    await driver.ready();let completed=false;
    drag=driver.drag(f.target,{...f.target,point:{x:150,y:60}},{durationMs:4*1000/60}).finally(()=>{completed=true;});void drag.catch(()=>{});
    for(let step=0;f.stats().up===0&&step<20;step++){t.mock.timers.tick(100);await yieldTurn();}
    assert.equal(f.stats().up,1,'all movement and native drop must dispatch before waiting for the evidence watermark');
    assert.equal(f.stats().moves,6);assert.equal(completed,false,'completion still retains every actually emitted move');
    f.release();await settle(t,drag);
    assert.equal(events.filter(event=>event.kind==='pointermove'&&event.gesture==='drag').length,5);
    assert.equal(events.filter(event=>event.kind==='pointermove'&&!event.gesture).length,1);
    assert.equal(events.filter(event=>event.kind==='pointerup').length,0);
  }finally{f.release();await driver.dispose();await drag?.catch(()=>{});}
});

test('keyboard navigation still reports a missing original document without replaying the release',async t=>{
  controlledClock(t);const f=browserBoundary({navigateOnKeyDown:true}),events:InputEvent[]=[];
  const driver=createSessionInput(f.page,event=>{events.push(event);},pacing,{now:()=>1000});
  try{
    await driver.ready();await assert.rejects(settle(t,driver.keys(undefined,'Enter')),{code:'SESSION_INPUT_EVIDENCE_LOST'});
    assert.equal(f.stats().keyUps,1);assert.equal(f.stats().navigations,1);
    assert.equal(events.filter(event=>event.kind==='keyboard'&&event.phase==='down').length,1);
  }finally{await driver.dispose();}
});

async function runtimeBoundary(t:TestContext,driver:ReturnType<typeof createSessionInput>,page:Page,target:ResolvedTarget){
  const root=await mkdtemp('/private/tmp/wts-navigation-unit-'),directory=join(root,'session');await mkdir(join(directory,'actions'),{recursive:true});
  const config:SessionConfig={directory,projectId:'project',projectPath:root,startUrl:'http://127.0.0.1/',allowedOrigins:['http://127.0.0.1'],uploadRoots:[],network:'loopback-only'};
  const info:SessionInfo={version:1,sessionId:'navigation-unit',projectId:'project',projectPath:root,directory,status:'open',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),captureActive:false,socketPath:join(root,'unused.sock')};
  const runtime=new (SessionRuntime as any)(config,info,{}) as SessionRuntime,internals=runtime as any;
  // Only observation admission/browser ownership is replaced. The real execute,
  // dispatch journal and original-ID reconciliation remain inside this test.
  internals.page=()=>page;internals.input=()=>driver;internals.resolveTarget=async()=>target;internals.preflightAction=async()=>undefined;
  t.after(async()=>{clearTimeout(internals.idleTimer);await driver.dispose();await rm(root,{recursive:true,force:true});});
  return runtime;
}

test('the dispatched navigation click rejoins its original record without another application input',async t=>{
  const f=browserBoundary();
  const driver=createSessionInput(f.page,()=>{},pacing,{now:()=>1000}),runtime=await runtimeBoundary(t,driver,f.page,f.target);
  const request={actionId:'open-once',action:{kind:'click' as const,target:{ref:'observed-button'}}};
  const result=await runtime.dispatch(request);assert.equal(result.status,'input-completed',JSON.stringify(result.error));
  assert.deepEqual(await runtime.dispatch(request),result);assert.equal(f.stats().down,1);assert.equal(f.stats().up,1);
});

test('execute retains the original input error when its final evidence flush also fails',async t=>{
  const f=browserBoundary();
  f.failDown(new SessionError('ORIGINAL_INPUT_FAILURE','The native input response failed.'));
  const driver=createSessionInput(f.page,event=>{if(event.kind==='pointerup')throw new Error('FINAL_FLUSH_FAILED');},pacing,{now:()=>1000});
  const runtime=await runtimeBoundary(t,driver,f.page,f.target),request={actionId:'failed-once',action:{kind:'click' as const,target:{ref:'observed-button'}}};
  const result=await runtime.dispatch(request);assert.equal(result.status,'outcome-uncertain');assert.equal(result.error?.code,'ORIGINAL_INPUT_FAILURE');assert.match(result.error!.message,/FINAL_FLUSH_FAILED/);
  assert.deepEqual(await runtime.dispatch(request),result);assert.equal(f.stats().down,1);assert.equal(f.stats().up,1);
  const resolved=await runtime.resolveAction(request.actionId,{outcome:'effect-observed',note:'The synthetic application effect was observed.'});
  assert.equal(resolved.status,'outcome-uncertain');assert.equal(resolved.resolution?.outcome,'effect-observed');assert.equal(f.stats().down,1);
});
