import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as delay,setImmediate as yieldTurn} from 'node:timers/promises';
import type {Page} from 'playwright';
import {createSessionInput} from '../src/session/input.ts';

/** Pure driver boundary: no browser, recorder or application is launched. */
async function controlledDrag(t:TestContext,options:{acknowledgementMs?:(index:number)=>number;eventLoopStallMs?:number;cancelAtMove?:number;durationMs?:number}={}){
  t.mock.timers.enable({apis:['setTimeout','Date'],now:0});syncBuiltinESMExports();
  const moves:Array<{x:number;y:number;atMs:number}>=[],modifiers=new Set<string>(),abort=new AbortController();
  let held=false,inFlight=0,maxInFlight=0,downs=0,ups=0,stalled=false;
  const page={frames:()=>[],mainFrame:()=>undefined,
    mouse:{
      move:async(x:number,y:number)=>{
        const index=moves.length;if(held)moves.push({x,y,atMs:Date.now()});
        inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
        await delay(held?(options.acknowledgementMs?.(index)??1):0);inFlight--;
        if(held&&options.cancelAtMove===index)abort.abort();
      },
      down:async()=>{held=true;downs++;},up:async()=>{held=false;ups++;},
    },
    keyboard:{down:async(key:string)=>{modifiers.add(key);},up:async(key:string)=>{modifiers.delete(key);}},
  } as unknown as Page;
  const driver=createSessionInput(page,()=>{},{minimumApproachMs:0,distanceMsPerPixel:0,targetDwellMs:0},{now:()=>Date.now(),signal:abort.signal});
  try{
    const point=(x:number,y:number)=>({page,point:{x,y},verifyPointer:async()=>{},verifyKeyboard:async()=>{}});let finished=false;
    const operation=driver.drag(point(180,220),point(420,268),{durationMs:options.durationMs??240,modifiers:['Shift','Alt']});
    const result=operation.then(()=>{finished=true;},error=>{finished=true;return error;});
    for(let ticks=0;!finished&&ticks<2000;ticks++){
      // Advance past the next scheduled wake-up only once its preceding move
      // has acknowledged. This isolates scheduler lateness from receiver delay.
      if(options.eventLoopStallMs&&!stalled&&moves.length===3&&inFlight===0){stalled=true;t.mock.timers.tick(options.eventLoopStallMs);}
      else t.mock.timers.tick(1);
      await yieldTurn();
    }
    assert.ok(finished);const error:unknown=await result;
    return {moves,pointer:driver.currentPointer(),held,modifiers:[...modifiers],maxInFlight,downs,ups,stalled,error};
  }finally{await driver.dispose();t.mock.timers.reset();syncBuiltinESMExports();}
}
const positions=(moves:Array<{x:number;y:number}>)=>moves.map(({x,y})=>({x,y}));

test('nominal movement retains minimum-jerk samples and its exact endpoint',async t=>{
  const result=await controlledDrag(t,{durationMs:4*1000/60});assert.ifError(result.error);
  assert.deepEqual(positions(result.moves),[
    {x:180,y:220},{x:204.84375,y:224.96875},{x:300,y:244},{x:395.15625,y:263.03125},{x:420,y:268},
  ]);
});

test('slow acknowledgement sets movement cadence without adding a second interval',async t=>{
  const {moves,maxInFlight,held,error}=await controlledDrag(t,{acknowledgementMs:()=>18});assert.ifError(error);
  const gaps=moves.slice(1).map((event,index)=>event.atMs-moves[index].atMs);
  assert.ok(gaps.length>=10);assert.ok(gaps.every(gap=>gap>=18&&gap<=20),JSON.stringify(gaps));
  assert.equal(maxInFlight,1);assert.equal(held,false);
});

for(const stall of ['acknowledgement','event loop'] as const)test(`movement preserves every trajectory sample after a stalled ${stall}`,async t=>{
  const baseline=await controlledDrag(t),interrupted=await controlledDrag(t,stall==='acknowledgement'?{acknowledgementMs:index=>index===2?120:1}:{eventLoopStallMs:120});
  assert.ifError(baseline.error);assert.ifError(interrupted.error);
  assert.deepEqual(positions(interrupted.moves),positions(baseline.moves),'a late receiver or scheduler must not skip ahead on the trajectory');
  assert.ok(interrupted.moves[3].atMs-interrupted.moves[2].atMs>=120);
  assert.ok(interrupted.moves.at(-1)!.atMs-baseline.moves.at(-1)!.atMs>=100,'preserving the path extends the movement instead of catching up');
  assert.ok(interrupted.moves.slice(4).every((event,index)=>event.atMs-interrupted.moves[index+3].atMs>=15));
  assert.deepEqual(interrupted.pointer,{x:420,y:268});assert.equal(interrupted.maxInFlight,1);
  assert.equal(interrupted.downs,1);assert.equal(interrupted.ups,1);assert.equal(interrupted.held,false);assert.deepEqual(interrupted.modifiers,[]);
  if(stall==='event loop')assert.equal(interrupted.stalled,true);
});

test('cancelling a stalled movement releases input without dispatching its remaining trajectory',async t=>{
  const result=await controlledDrag(t,{acknowledgementMs:index=>index===2?120:1,cancelAtMove:2});
  assert.ok(result.error instanceof Error);assert.equal(result.error.name,'AbortError');
  assert.equal(result.moves.length,3);assert.notDeepEqual(result.pointer,{x:420,y:268});
  assert.equal(result.maxInFlight,1);assert.equal(result.downs,1);assert.equal(result.ups,1);
  assert.equal(result.held,false);assert.deepEqual(result.modifiers,[]);
});
