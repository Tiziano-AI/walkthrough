import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import type {Page} from 'playwright';
import {beginTake} from '../src/capture/take.ts';
import {pageCaptureSurface} from '../src/capture/surface.ts';

const tools={nodePath:process.execPath,browserPath:'/unused',ffmpegPath:'/unused',ffprobePath:'/unused'};
async function fixture(failure?:'start-slate'|'end-slate'|'end-dom'|'stop'){
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-take-custody-'));
  const events:string[]=[];let covers=0;
  const error=new Error(failure??'synthetic failure');
  const session={async send(name:string){events.push(name);if(name==='Page.stopScreenRecording'&&failure==='stop')throw error;if(name==='IO.read')return {data:'synthetic retained capture',eof:true};return {stream:'synthetic-stream'};},async detach(){events.push('detach');}};
  const page={context:()=>({newCDPSession:async()=>session}),async evaluateHandle(){
    covers++;events.push('cover-painted');
    return {async evaluate(_callback:unknown,value?:string){
      if(value===undefined){events.push('cover-removed');return;}
      if((failure==='start-slate'&&covers===1)||(failure==='end-slate'&&covers===2)||(failure==='end-dom'&&covers===2&&value==='#000'))throw error;
      events.push(`color:${value}`);
    },async dispose(){}};
  }} as unknown as Page;
  return {directory,page,error,events,stops:()=>events.filter(name=>name==='Page.stopScreenRecording').length,cleanup:()=>rm(directory,{recursive:true,force:true})};
}

test('failed opening slate stops the recorder even though no take handle was returned',async()=>{
  const f=await fixture('start-slate');try{
    await assert.rejects(beginTake(f.page,tools,f.directory),error=>error===f.error);
    assert.equal(f.stops(),1);
    assert.ok(f.events.indexOf('cover-painted')<f.events.indexOf('Page.startScreenRecording'));
    assert.ok(f.events.indexOf('Page.stopScreenRecording')<f.events.indexOf('cover-removed'));
    assert.equal(await readFile(join(f.directory,'source.mp4'),'utf8'),'synthetic retained capture');
    assert.ok(f.events.includes('detach'));
  }finally{await f.cleanup();}
});

test('a slate installation failure never starts recording an uncovered page',async()=>{
  const f=await fixture();
  f.page.evaluateHandle=async()=>{throw f.error;};
  try{
    await assert.rejects(beginTake(f.page,tools,f.directory),error=>error===f.error);
    assert.equal(f.events.includes('Page.startScreenRecording'),false);
    assert.equal(f.stops(),0);
  }finally{await f.cleanup();}
});

for(const failure of ['end-slate','end-dom'] as const)test(`failed ${failure} stops once and later abort shares settlement`,async()=>{
  const f=await fixture(failure);try{
    const take=await beginTake(f.page,tools,f.directory);
    await assert.rejects(take.finish(),error=>error===f.error);
    assert.equal(f.stops(),1);
    await take.abort();await take.abort();
    assert.equal(f.stops(),1);
    assert.ok(f.events.includes('detach'));
  }finally{await f.cleanup();}
});

test('clock write failure leaves a stopped recorder and does not repeat the stop command',async()=>{
  const f=await fixture();try{
    const take=await beginTake(f.page,tools,f.directory);
    await mkdir(join(f.directory,'capture-clock.json'));
    await assert.rejects(take.finish(),(error:any)=>error.code==='EISDIR');
    await take.abort();assert.equal(f.stops(),1);
  }finally{await f.cleanup();}
});

test('failed stop remains failed on abort without replaying its uncertain command',async()=>{
  const f=await fixture('stop');try{
    const take=await beginTake(f.page,tools,f.directory);
    await assert.rejects(take.finish(),error=>error===f.error);
    await assert.rejects(take.abort(),error=>error===f.error);
    await assert.rejects(take.abort(),error=>error===f.error);
    assert.equal(f.stops(),1);
    assert.equal(f.events.filter(event=>event==='cover-removed').length,1,'uncertain stop leaves the ending cover in place');
  }finally{await f.cleanup();}
});

test('opening slate and stop failures both remain available to the caller',async()=>{
  const f=await fixture('stop'),slateError=new Error('opening slate failed');
  const surface=pageCaptureSurface(f.page),cover=surface.cover;
  surface.cover=async()=>({...await cover(),async color(){throw slateError;}});
  try{
    await assert.rejects(beginTake(surface,tools,f.directory),error=>error instanceof AggregateError&&error.message==='CAPTURE_CLEANUP_FAILED'&&error.errors[0]===slateError&&error.errors[1]===f.error);
    assert.equal(f.stops(),1);
  }finally{await f.cleanup();}
});

test('abort during the ending slate stops once and cannot yield an accepted capture',async()=>{
  const f=await fixture(),entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
  try{
    const surface=pageCaptureSurface(f.page),cover=surface.cover;
    const take=await beginTake(surface,tools,f.directory);
    surface.cover=async()=>{
      const overlay=await cover();
      return {...overlay,async color(value){entered.resolve();await resume.promise;await overlay.color(value);}};
    };
    const result=assert.rejects(take.finish(),(error:any)=>error.code==='CAPTURE_ABORTED');
    await entered.promise;
    await Promise.all([take.abort(),take.abort()]);
    assert.equal(f.stops(),1);
    resume.resolve();await result;
    assert.equal(f.stops(),1);
  }finally{resume.resolve();await f.cleanup();}
});

test('successful stop retains both calibration anchors and timing before analysis errors',async()=>{
  const f=await fixture();try{
    const take=await beginTake(f.page,tools,f.directory);
    await assert.rejects(take.finish(),(error:any)=>error.code==='ENOENT');
    const clock=JSON.parse(await readFile(join(f.directory,'capture-clock.json'),'utf8'));
    assert.ok(clock.start.beforeMs<=clock.start.afterMs&&clock.start.afterMs<=clock.end.beforeMs&&clock.end.beforeMs<=clock.end.afterMs);
    assert.equal(clock.timing.destination,take.sourcePath);
    assert.equal(clock.timing.requestedStartIntervalMs.length,2);
    assert.equal(clock.timing.requestedStopIntervalMs.length,2);
    await take.abort();assert.equal(f.stops(),1);
    await assert.rejects(take.finish(),(error:any)=>error.code==='CAPTURE_ALREADY_STOPPED');
  }finally{await f.cleanup();}
});

test('abort during analysis drains the owned decoder without stopping the recorder twice',async()=>{
  const f=await fixture();
  const toolPath=join(f.directory,'analysis-tool.mjs');
  await writeFile(toolPath,`#!${process.execPath}
    import {writeFileSync} from 'node:fs';
    if(process.argv.includes('-show_streams'))process.stdout.write(JSON.stringify({streams:[{width:3200,height:1800,duration:2}]}));
    else if(process.argv.includes('-show_entries'))process.stdout.write('best_effort_timestamp_time=0\\nbest_effort_timestamp_time=1\\n');
    else{
      process.on('SIGTERM',()=>{});
      writeFileSync(new URL('decoder.pid',import.meta.url),String(process.pid));
      process.stdout.write(Buffer.alloc(576,80));
      setInterval(()=>process.stderr.write('decoding\\n'),10);
    }
  `,{mode:0o700});
  const take=await beginTake(f.page,{...tools,ffprobePath:toolPath,ffmpegPath:toolPath},f.directory);
  const rejected=assert.rejects(take.finish(),(error:any)=>error.code==='CAPTURE_ABORTED');
  try{
    let pid:number|undefined;
    for(let attempt=0;attempt<200&&!pid;attempt++){
      try{pid=Number(await readFile(join(f.directory,'decoder.pid'),'utf8'));}catch(error:any){if(error.code!=='ENOENT')throw error;await setTimeout(10);}
    }
    assert.ok(pid,'the decoder started after recorder settlement');
    await take.abort();
    assert.equal(f.stops(),1);
    assert.throws(()=>process.kill(pid!,0),(error:any)=>error.code==='ESRCH');
    await rejected;
    assert.ok(await readFile(join(f.directory,'capture-clock.json'),'utf8'));
    assert.equal(await readFile(join(f.directory,'source.mp4'),'utf8'),'synthetic retained capture');
  }finally{await take.abort();await rejected;await f.cleanup();}
});
