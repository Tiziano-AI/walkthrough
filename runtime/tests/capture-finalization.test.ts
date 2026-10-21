import assert from 'node:assert/strict';
import test from 'node:test';
import {link,lstat,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {analyzeTake,decodeCalibrationFrames} from '../src/capture/take.ts';

async function fixture(source:string){
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-finalization-'));
  const toolPath=join(directory,'media-tool.mjs');
  await writeFile(toolPath,`#!${process.execPath}\n${source}\n`,{mode:0o700});
  return {directory,toolPath,cleanup:()=>rm(directory,{recursive:true,force:true})};
}

test('decoding drains large stderr separately from fragmented raw frames without changing frame order',async()=>{
  const f=await fixture(`
    import assert from 'node:assert/strict';
    import {once} from 'node:events';
    const args=process.argv.slice(2);
    assert.equal(args[args.indexOf('-fflags')+1],'+nofillin');
    assert.ok(args.indexOf('-fflags')<args.indexOf('-i'),'native timestamp policy is an input option');
    assert.equal(args[args.indexOf('-map')+1],'0:v:0');
    assert.equal(args[args.indexOf('-fps_mode')+1],'passthrough');
    assert.equal(args[args.indexOf('-enc_time_base')+1],'demux');
    const output=Buffer.concat(Array.from({length:2111},(_,frame)=>Buffer.alloc(576,frame%256)));
    for(let offset=0;offset<output.length;offset+=997){
      if(!process.stderr.write(Buffer.alloc(4096,120)))await once(process.stderr,'drain');
      if(!process.stdout.write(output.subarray(offset,offset+997)))await once(process.stdout,'drain');
    }
  `);
  try{
    const samples=await decodeCalibrationFrames(f.toolPath,'retained-original.mp4',2111);
    assert.equal(samples.length,2111);
    samples.forEach((frame,index)=>assert.deepEqual(frame,{mean:index%256,min:index%256,max:index%256}));
  }finally{await f.cleanup();}
});

for(const bytes of [0,575,576,1153,1728])test(`decoding rejects ${bytes} output bytes for two probed frames with exact mismatch counts`,async()=>{
  const f=await fixture(`process.stdout.write(Buffer.alloc(${bytes},80));`);
  try{
    await assert.rejects(decodeCalibrationFrames(f.toolPath,'retained-original.mp4',2),(error:any)=>{
      assert.equal(error.code,'CAPTURE_TIMESTAMPS_INVALID');
      assert.match(error.recovery,/expected 2 frames \(1152 bytes\)/);
      assert.ok(error.recovery.includes(`received ${Math.floor(bytes/576)} complete frames and ${bytes%576} trailing bytes (${bytes} bytes)`));
      return true;
    });
  }finally{await f.cleanup();}
});

test('a failed decoder cannot be accepted even after it wrote every expected frame, and its error tail is bounded',async()=>{
  const f=await fixture(`
    import {once} from 'node:events';
    process.stdout.write(Buffer.alloc(1152,80));
    if(!process.stderr.write(Buffer.alloc(2*1024*1024,120)))await once(process.stderr,'drain');
    process.stderr.write('decoder terminal failure');
    process.exitCode=7;
  `);
  try{
    await assert.rejects(decodeCalibrationFrames(f.toolPath,'retained-original.mp4',2),(error:any)=>{
      assert.equal(error.code,'CAPTURE_DECODE_FAILED');
      assert.match(error.recovery,/exited with 7/);
      assert.match(error.recovery,/earlier stderr bytes omitted/);
      assert.match(error.recovery,/decoder terminal failure$/);
      assert.ok(error.recovery.length<17000);
      return true;
    });
  }finally{await f.cleanup();}
});

test('decoder launch errors remain distinct from malformed frame output',async()=>{
  await assert.rejects(decodeCalibrationFrames('/nonexistent-walkthrough-media-tool','source.mp4',2),(error:any)=>error.code==='ENOENT');
});

test('cancellation waits for a decoder that ignores SIGTERM to be killed and drained',async()=>{
  const f=await fixture(`
    import {writeFileSync} from 'node:fs';
    process.on('SIGTERM',()=>{});
    writeFileSync(new URL('decoder.pid',import.meta.url),String(process.pid));
    process.stdout.write(Buffer.alloc(576,80));
    setInterval(()=>process.stderr.write('still decoding\\n'),10);
  `);
  const controller=new AbortController();
  const rejected=assert.rejects(decodeCalibrationFrames(f.toolPath,'retained-original.mp4',2,{signal:controller.signal}),(error:any)=>error.code==='CAPTURE_ABORTED');
  try{
    let pid:number|undefined;
    for(let attempt=0;attempt<200&&!pid;attempt++){
      try{pid=Number(await readFile(join(f.directory,'decoder.pid'),'utf8'));}catch(error:any){if(error.code!=='ENOENT')throw error;await setTimeout(10);}
    }
    assert.ok(pid,'the child reached its controlled decoding state');
    controller.abort();
    await rejected;
    assert.throws(()=>process.kill(pid!,0),(error:any)=>error.code==='ESRCH','analysis only settles after its process is gone');
  }finally{controller.abort();await rejected;await f.cleanup();}
});

test('an already cancelled decode launches no media process',async()=>{
  const f=await fixture(`import {writeFileSync} from 'node:fs';writeFileSync(new URL('launched',import.meta.url),'bad');`);
  try{
    await assert.rejects(decodeCalibrationFrames(f.toolPath,'source.mp4',2,{signal:AbortSignal.abort()}),(error:any)=>error.code==='CAPTURE_ABORTED');
    await assert.rejects(readFile(join(f.directory,'launched')),(error:any)=>error.code==='ENOENT');
  }finally{await f.cleanup();}
});

test('analysis streams fragmented timestamp records and retains their original values with calibration diagnostics',async()=>{
  const pts=['0.000000','0.250000','0.500000','0.750000','1.000000','2.000000','2.250000','2.500000','2.750000'];
  const f=await fixture(`
    import assert from 'node:assert/strict';
    import {once} from 'node:events';
    const args=process.argv.slice(2);
    if(args.includes('-show_entries')){
      assert.equal(args[args.indexOf('-fflags')+1],'+nofillin');
      assert.ok(args.indexOf('-fflags')+1<args.length-1,'native timestamp policy precedes the source input');
    }
    const output=process.argv.includes('-show_streams')?Buffer.from(JSON.stringify({streams:[{width:3200,height:1800,duration:2.75}]})):
      process.argv.includes('-show_entries')?Buffer.from(${JSON.stringify(pts.map(t=>`best_effort_timestamp_time=${t}\n`).join(''))}):
      Buffer.concat([0,255,0,119,80,0,255,0,119].map(value=>Buffer.alloc(576,value)));
    for(let offset=0;offset<output.length;offset+=13)if(!process.stdout.write(output.subarray(offset,offset+13)))await once(process.stdout,'drain');
  `);
  try{
    await writeFile(join(f.directory,'capture-clock.json'),JSON.stringify({start:{beforeMs:245,afterMs:255},end:{beforeMs:2245,afterMs:2255}}));
    const map=await analyzeTake({nodePath:process.execPath,browserPath:'/unused',ffmpegPath:f.toolPath,ffprobePath:f.toolPath},f.directory);
    assert.equal(map.frameCount,9);
    assert.equal(map.offsetSeconds,0);
    assert.equal(map.driftSeconds,0);
    const analysis=JSON.parse(await readFile(join(f.directory,'capture-analysis.json'),'utf8'));
    assert.deepEqual(analysis.probe.frames.map((f:any)=>f.best_effort_timestamp_time),pts);
    assert.deepEqual(analysis.markerFrames,[1,6]);
    assert.deepEqual(map.usableRasterRange,{startSeconds:1,endSeconds:2});
  }finally{await f.cleanup();}
});

for(const [pts,index] of [
  [['N/A','0.250000'],0],
  [['0.000000','NaN'],1],
  [['0.000000','Infinity'],1],
  [['0.000000','-Infinity'],1],
  [['0.000000','0.010483','0.020967','0.031450','0.000000'],4],
  [['0.000000','0.000000','0.500000','0.250000'],3],
] as const)test(`invalid native timestamps identify the first offending frame (${pts.join(',')})`,async()=>{
  const f=await fixture(`
    import {writeFileSync} from 'node:fs';
    if(process.argv.includes('-show_streams'))process.stdout.write(JSON.stringify({streams:[{width:3200,height:1800,duration:1}]}));
    else if(process.argv.includes('-show_entries'))process.stdout.write(${JSON.stringify(pts.map(t=>`best_effort_timestamp_time=${t}\n`).join(''))});
    else writeFileSync(new URL('decoded',import.meta.url),'must not decode invalid clocks');
  `);
  try{
    await writeFile(join(f.directory,'capture-clock.json'),JSON.stringify({start:{beforeMs:0,afterMs:0},end:{beforeMs:1000,afterMs:1000}}));
    await assert.rejects(analyzeTake({nodePath:process.execPath,browserPath:'/unused',ffmpegPath:f.toolPath,ffprobePath:f.toolPath},f.directory),(error:any)=>{
      assert.equal(error.code,'CAPTURE_TIMESTAMPS_INVALID');
      assert.ok(error.recovery.includes(`frame ${index} (zero-based)`));
      assert.ok(error.recovery.includes(`current=${JSON.stringify(pts[index])}; previous=${index?JSON.stringify(pts[index-1]):'<none>'}`),'retain raw probe values, not rounded or coerced replacements');
      return true;
    });
    await assert.rejects(readFile(join(f.directory,'decoded')),(error:any)=>error.code==='ENOENT');
  }finally{await f.cleanup();}
});

async function calibratedFixture(pixels:number[]){
  const pts=pixels.map((_,i)=>i/4);
  const white=pixels.flatMap((value,i)=>value===255&&pixels[i-1]!==255?[i]:[]);
  const f=await fixture(`
    process.stdout.write(process.argv.includes('-show_streams')?JSON.stringify({streams:[{width:3200,height:1800,duration:${pixels.length/4}}]}):
      process.argv.includes('-show_entries')?${JSON.stringify(pts.map(t=>`best_effort_timestamp_time=${t}\n`).join(''))}:
      Buffer.concat(${JSON.stringify(pixels)}.map(value=>Buffer.alloc(576,value))));
  `);
  await writeFile(join(f.directory,'capture-clock.json'),JSON.stringify({start:{beforeMs:pts[white[0]]*1000-5,afterMs:pts[white[0]]*1000+5},end:{beforeMs:pts[white.at(-1)!]*1000-5,afterMs:pts[white.at(-1)!]*1000+5}}));
  return {...f,analyze:(options?:Parameters<typeof analyzeTake>[2])=>analyzeTake({nodePath:process.execPath,browserPath:'/unused',ffmpegPath:f.toolPath,ffprobePath:f.toolPath},f.directory,options)};
}

test('usable raster bounds exclude every repeated opening gray and ending black frame',async()=>{
  const f=await calibratedFixture([0,255,0,119,119,80,0,0,255,0,119,119]);
  try{
    const map=await f.analyze();
    assert.deepEqual(map.usableRasterRange,{startSeconds:1.25,endSeconds:1.5});
  }finally{await f.cleanup();}
});

for(const tail of [[255,0,0],[255,255,0,0,0],[255,0,119],[255,0,0,119,119]])test(`closing cover ${tail.join('/')} bounds the same product frames`,async()=>{
  // The boundary is the first closing black, not a later gray flush frame.
  // Every accepted return-black hold has a measured subsequent timestamp.
  const f=await calibratedFixture([0,255,0,119,80,80,0,0,...tail]);
  try{
    const map=await f.analyze();
    assert.deepEqual(map.usableRasterRange,{startSeconds:1,endSeconds:1.5});
  }finally{await f.cleanup();}
});

test('a single terminal black cannot establish the closing marker hold',async()=>{
  const f=await calibratedFixture([0,255,0,119,80,0,255,0]);
  try{await assert.rejects(f.analyze(),(error:any)=>error.code==='CAPTURE_CLOCK_MARKER_AMBIGUOUS');}
  finally{await f.cleanup();}
});

for(const [name,pixels] of [
  ['missing opening gray',[0,255,0,80,80,0,255,0,119]],
  ['product exposed after ending black',[0,255,0,119,80,0,255,0,0,80]],
  ['black reappears after ending gray',[0,255,0,119,80,0,255,0,119,0]],
  ['no product distinct from gray',[0,255,0,119,119,0,255,0,119]],
  ['product exposed after ending gray',[0,255,0,119,80,0,255,0,119,80]],
] as const)test(`usable raster qualification rejects ${name} and retains samples for diagnosis`,async()=>{
  const f=await calibratedFixture([...pixels]);
  try{
    await assert.rejects(f.analyze(),(error:any)=>error.code==='CAPTURE_USABLE_RANGE_INVALID');
    const analysis=JSON.parse(await readFile(join(f.directory,'capture-analysis.json'),'utf8'));
    assert.equal(analysis.markerFrames.length,2);
    assert.equal(analysis.calibrationSamples.length,pixels.length);
    assert.equal(analysis.map,undefined,'rejected raster bounds do not yield an accepted map');
  }finally{await f.cleanup();}
});

test('a recovery analysis writes one private independent attempt while preserving canonical diagnostics',async()=>{
  const f=await calibratedFixture([0,255,0,119,80,0,255,0,119]);
  const canonical=join(f.directory,'capture-analysis.json'),diagnosticsPath=join(f.directory,'recovery-analysis-new.json');
  const original='{"original":"failed diagnostic evidence"}\n';
  try{
    await writeFile(canonical,original);
    const map=await f.analyze({diagnosticsPath});
    assert.equal(await readFile(canonical,'utf8'),original);
    const analysis=JSON.parse(await readFile(diagnosticsPath,'utf8'));
    assert.deepEqual(analysis.map,map);
    assert.deepEqual(analysis.markerFrames,[1,6]);
    assert.equal((await lstat(diagnosticsPath)).mode&0o777,0o600);
    assert.deepEqual((await readdir(f.directory)).filter(name=>name.endsWith('.tmp')),[]);
  }finally{await f.cleanup();}
});

test('rejected recovery calibration retains new diagnostics without changing the original analysis',async()=>{
  const f=await calibratedFixture([0,255,0,80,80,0,255,0,119]);
  const canonical=join(f.directory,'capture-analysis.json'),diagnosticsPath=join(f.directory,'recovery-analysis-rejected.json');
  const original='original failure diagnostics';
  try{
    await writeFile(canonical,original);
    await assert.rejects(f.analyze({diagnosticsPath}),(error:any)=>error.code==='CAPTURE_USABLE_RANGE_INVALID');
    assert.equal(await readFile(canonical,'utf8'),original);
    const analysis=JSON.parse(await readFile(diagnosticsPath,'utf8'));
    assert.equal(analysis.calibrationSamples.length,9);
    assert.equal(analysis.map,undefined);
  }finally{await f.cleanup();}
});

for(const custom of [false,true])test(`${custom?'recovery':'canonical'} diagnostics reject an existing symlink and preserve its target`,async()=>{
  const f=await calibratedFixture([0,255,0,119,80,0,255,0,119]);
  const path=join(f.directory,custom?'recovery-analysis-linked.json':'capture-analysis.json'),target=join(f.directory,'protected.json');
  try{
    await writeFile(target,'protected evidence');
    await symlink(target,path);
    await assert.rejects(f.analyze(custom?{diagnosticsPath:path}:undefined),(error:any)=>error.code==='CAPTURE_ANALYSIS_PATH_INVALID');
    assert.equal(await readFile(target,'utf8'),'protected evidence');
    assert.equal((await lstat(path)).isSymbolicLink(),true);
    assert.deepEqual((await readdir(f.directory)).filter(name=>name.endsWith('.tmp')),[]);
  }finally{await f.cleanup();}
});

test('a named recovery diagnostic attempt cannot overwrite an existing regular file',async()=>{
  const f=await calibratedFixture([0,255,0,119,80,0,255,0,119]);
  const diagnosticsPath=join(f.directory,'recovery-analysis-existing.json');
  try{
    await writeFile(diagnosticsPath,'previous recovery attempt');
    await assert.rejects(f.analyze({diagnosticsPath}),(error:any)=>error.code==='CAPTURE_ANALYSIS_EXISTS');
    assert.equal(await readFile(diagnosticsPath,'utf8'),'previous recovery attempt');
    await assert.rejects(readFile(join(f.directory,'capture-analysis.json')),(error:any)=>error.code==='ENOENT');
  }finally{await f.cleanup();}
});

test('default analysis replaces its canonical entry without modifying another hard link to old evidence',async()=>{
  const f=await calibratedFixture([0,255,0,119,80,0,255,0,119]);
  const canonical=join(f.directory,'capture-analysis.json'),retained=join(f.directory,'retained-original-analysis.json');
  try{
    await writeFile(canonical,'retained original');
    await link(canonical,retained);
    const map=await f.analyze();
    assert.equal(await readFile(retained,'utf8'),'retained original');
    assert.deepEqual(JSON.parse(await readFile(canonical,'utf8')).map,map);
    assert.deepEqual((await readdir(f.directory)).filter(name=>name.endsWith('.tmp')),[]);
  }finally{await f.cleanup();}
});

test('an already aborted named analysis writes no diagnostic attempt and preserves canonical evidence',async()=>{
  const f=await calibratedFixture([0,255,0,119,80,0,255,0,119]);
  const canonical=join(f.directory,'capture-analysis.json'),diagnosticsPath=join(f.directory,'recovery-analysis-aborted.json');
  try{
    await writeFile(canonical,'original diagnostics');
    await assert.rejects(f.analyze({diagnosticsPath,signal:AbortSignal.abort()}),(error:any)=>error.code==='CAPTURE_ABORTED');
    assert.equal(await readFile(canonical,'utf8'),'original diagnostics');
    await assert.rejects(readFile(diagnosticsPath),(error:any)=>error.code==='ENOENT');
    assert.deepEqual((await readdir(f.directory)).filter(name=>name.endsWith('.tmp')),[]);
  }finally{await f.cleanup();}
});
