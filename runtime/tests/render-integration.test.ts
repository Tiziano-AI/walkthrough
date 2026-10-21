import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderWalkthrough} from '../src/render/index.ts';
import {executeLocal} from '../src/render/media.ts';
import type {Timeline} from '../src/render/timeline.ts';
import {qualifiedBrowserPath} from '../src/core/environment.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';

const {ffmpegPath:ffmpeg,ffprobePath:ffprobe}=resolveLocalTools();

/** Isolate Remotion's temporary directory so observed spool bytes belong to
 * this render. The sample is a peak lower bound, not total-volume telemetry. */
async function observeStreamingScratch<T>(directory:string,render:()=>Promise<T>){
  const rendererTmp=join(directory,'renderer-tmp');await mkdir(rendererTmp);
  const originalTmp=process.env.TMPDIR;process.env.TMPDIR=rendererTmp;
  let pending:Promise<void>|undefined,preencodeObserved=false,maximumPngFiles=0,maximumPreencodeBytes=0,observationError:unknown;
  const sample=async()=>{
    for(const entry of await readdir(rendererTmp)){
      if(!entry.startsWith('react-motion-render'))continue;
      const root=join(rendererTmp,entry);
      const files=await readdir(root,{recursive:true}).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [] as string[];throw error;});
      maximumPngFiles=Math.max(maximumPngFiles,files.filter(file=>file.endsWith('.png')).length);
      if(files.includes('pre-encode.mkv')){
        preencodeObserved=true;
        const info=await stat(join(root,'pre-encode.mkv')).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
        maximumPreencodeBytes=Math.max(maximumPreencodeBytes,info?.size??0);
      }
    }
  };
  const timer=setInterval(()=>{if(!pending)pending=sample().catch(error=>{observationError=error;}).finally(()=>{pending=undefined;});},20);
  let result:T;
  try{result=await render();}finally{
    clearInterval(timer);await pending;
    if(originalTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=originalTmp;
  }
  if(observationError)throw observationError;
  const observation={preencodeObserved,maximumPngFiles,maximumPreencodeBytes,sampleIntervalMs:20,scope:'owned-react-motion-render-scratch'};
  await writeFile(join(directory,'streaming-scratch-observation.json'),JSON.stringify(observation,null,2));
  assert.equal(preencodeObserved,true,'native encoding creates its owned intermediate while frames render');
  assert.equal(maximumPngFiles,0,'native streaming must not accumulate an all-frame PNG directory');
  return result;
}
const browser=qualifiedBrowserPath();
test('a bounded preview renders one held source frame and never stages sources outside its absolute range',{skip:process.platform!=='darwin'||![ffmpeg,ffprobe,browser].every(existsSync),timeout:120000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-render-bounded-preview-'));
  // Remove only this attempt's synthetic fixtures after the test runner confirms
  // success; failed and cancelled attempts retain their complete diagnostics.
  t.after(async context=>{if(context.passed)await rm(directory,{recursive:true});else context.diagnostic(`Render test evidence retained at ${directory}`);});
  const sourcePath=join(directory,'cyan.mp4');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','color=c=cyan:s=3200x1800:r=60:d=0.05','-c:v','libx264','-preset','ultrafast','-qp','0','-bf','0',sourcePath],join(directory,'fixture.log'));
  const timeline:Timeline={sourceWidth:3200,sourceHeight:1800,sources:{unavailable:{pointer:[]},cyan:{pointer:[]}},narration:[],segments:[
    {id:'outside',sourceId:'unavailable',kind:'live',transition:'cut',sourceStartSeconds:0,sourceEndSeconds:1,outputStartSeconds:0,durationSeconds:1,zoom:1,target:null},
    {id:'held',sourceId:'cyan',kind:'hold',transition:'cut',sourceStartSeconds:2/60,sourceEndSeconds:2/60,outputStartSeconds:1,durationSeconds:1,zoom:1,target:null},
  ]};
  const result=await renderWalkthrough({timeline,frameRange:[119,119],sourcePaths:{cyan:sourcePath},directory:join(directory,'render'),browserPath:browser,ffmpegPath:ffmpeg,ffprobePath:ffprobe});
  const input=JSON.parse(await readFile(join(directory,'render/render-input.json'),'utf8'));
  assert.deepEqual(input.frameRange,[119,119]);assert.deepEqual(input.inputProps.frameRange,[119,119]);
  assert.deepEqual(input.inputProps.timeline,timeline,'the complete original timeline survives serialization');
  const cyanWindows=[{sourceStartFrame:2,frameCount:1,stagedStartFrame:0}];
  assert.deepEqual(input.inputProps.sourceFiles,{cyan:{file:'source-0.mp4',windows:cyanWindows}});
  const staging=JSON.parse(await readFile(join(directory,'render/source-staging.json'),'utf8'));
  assert.equal(staging.schemaVersion,3);
  assert.deepEqual(Object.keys(staging.sources),['cyan']);
  assert.deepEqual(staging.sources.cyan.windows,cyanWindows);assert.equal(staging.sources.cyan.frameCount,1);assert.equal(staging.sources.cyan.stagedStartSeconds,0);
  assert.equal(existsSync(join(directory,'render/assets/source-1.mp4')),false);
  assert.equal(result.metrics.expectedFrames,1);
  const pixelPath=join(directory,'pixel.rgb');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',result.videoPath,'-vf','scale=1:1','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo',pixelPath],join(directory,'decode.log'));
  const [red,green,blue]=await readFile(pixelPath);
  assert.ok(red<50&&green>200&&blue>200,'the actual delivered frame is the selected cyan hold');

  // Exercise the actual public Remotion refusal path against this retained
  // bundle, not a mock encoder or an artificially edited dependency. Explicit
  // nonparallel mode produces the same onStart=false as memory admission.
  const refusalWorker=join(directory,'refusal-worker.mjs'),refusalOutput=join(directory,'refused.mov'),refusalObservation=join(directory,'refusal.json');
  await writeFile(refusalWorker,`
import fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {loadCustodiedRenderer,enableBrowserGroupCustody} from ${JSON.stringify(new URL('../src/render/browser-custody.ts',import.meta.url).href)};
import {masterRenderOptions} from ${JSON.stringify(new URL('../src/render/worker.ts',import.meta.url).href)};
const {selectComposition,renderMedia}=await loadCustodiedRenderer();
await enableBrowserGroupCustody();
const common={serveUrl:${JSON.stringify(join(directory,'render/bundle'))},browserExecutable:${JSON.stringify(browser)},chromeMode:'chrome-for-testing',logLevel:'error',inputProps:${JSON.stringify(input.inputProps)},offthreadVideoThreads:1,onBrowserDownload:()=>{throw Error('download forbidden');}};
const composition=await selectComposition({...common,id:'Walkthrough'});
const options=masterRenderOptions(${JSON.stringify(directory)});
let maximumRenderedFrames=0,starts=[],error=null;
const record=()=>writeFileSync(${JSON.stringify(refusalObservation)},JSON.stringify({maximumRenderedFrames,starts,error}));
try{await renderMedia({...common,...options,composition,frameRange:[119,119],outputLocation:${JSON.stringify(refusalOutput)},disallowParallelEncoding:true,onStart:data=>{starts.push(data);try{options.onStart(data);}catch(caught){error=caught.message;record();throw caught;}},onProgress:data=>{maximumRenderedFrames=Math.max(maximumRenderedFrames,data.renderedFrames);record();}});}catch(caught){error=error??caught.message;record();process.exitCode=1;}
`);
  await assert.rejects(executeLocal('/usr/bin/sandbox-exec',['-f',fileURLToPath(new URL('../scripts/loopback-only.sb',import.meta.url)),process.execPath,refusalWorker],join(directory,'refusal.log'),120000,
    {PATH:'/usr/bin:/bin',HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8'},undefined,fileURLToPath(new URL('..',import.meta.url))),/render:local_process_failed/);
  const refusal=JSON.parse(await readFile(refusalObservation,'utf8'));
  assert.equal(refusal.error,'render:streaming_encoding_required');
  assert.equal(refusal.maximumRenderedFrames,0,'native onStart refusal precedes every rendered picture');
  assert.equal(refusal.starts.length,1);assert.equal(refusal.starts[0].parallelEncoding,false);
  assert.equal(existsSync(refusalOutput),false,'the rejected lane must not create a master');
  assert.match(await readFile(join(directory,'refusal.log'),'utf8'),/render:streaming_encoding_required/,'native cleanup cannot hide the required-encoding diagnostic');
});

test('streaming preserves exact frame identities across packed disjoint, reordered and repeated source use, with unchanged PCM cues',{skip:process.platform!=='darwin'||![ffmpeg,ffprobe,browser].every(existsSync),timeout:120000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-render-clocks-'));
  t.after(async context=>{if(context.passed)await rm(directory,{recursive:true});else context.diagnostic(`Render test evidence retained at ${directory}`);});
  const source=join(directory,'frame-codes.mp4'),voice=join(directory,'impulses.wav');
  // Each source frame has a distinct luma code. Decode the source below so
  // expected output is grounded in the actual retained input, not our renderer.
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','nullsrc=s=3200x1800:r=60:d=0.4,geq=lum=16+8*N:cb=128:cr=128','-c:v','libx264','-preset','ultrafast','-qp','0','-bf','0',source],join(directory,'source.log'));
  // Match the master's stereo layout in the retained fixture so exact PCM
  // equality tests picture packing rather than the native mono-to-stereo mix.
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','aevalsrc=if(eq(n\\,2400)\\,0.5\\,if(eq(n\\,8000)\\,-0.5\\,0)):s=48000:d=0.3','-ac','2','-c:a','pcm_s16le',voice],join(directory,'impulses.log'));
  const timeline:Timeline={sourceWidth:3200,sourceHeight:1800,sources:{codes:{pointer:[]}},narration:[{id:'cues',outputStartSeconds:0,durationSeconds:18/60,wavPath:voice,captions:[]}],segments:[
    {id:'later',sourceId:'codes',kind:'live',transition:'cut',sourceStartSeconds:16/60,sourceEndSeconds:20/60,outputStartSeconds:0,durationSeconds:4/60,zoom:1,target:null},
    {id:'earlier',sourceId:'codes',kind:'live',transition:'cut',sourceStartSeconds:3/60,sourceEndSeconds:7/60,outputStartSeconds:4/60,durationSeconds:4/60,zoom:1,target:null},
    {id:'repeat',sourceId:'codes',kind:'live',transition:'cut',sourceStartSeconds:16/60,sourceEndSeconds:20/60,outputStartSeconds:8/60,durationSeconds:4/60,zoom:1,target:null},
    {id:'hold',sourceId:'codes',kind:'hold',transition:'continuous',sourceStartSeconds:20/60,sourceEndSeconds:20/60,outputStartSeconds:12/60,durationSeconds:6/60,zoom:1,target:null},
  ]};
  const result=await renderWalkthrough({timeline,frameRange:[0,17],sourcePaths:{codes:source},directory:join(directory,'render'),browserPath:browser,ffmpegPath:ffmpeg,ffprobePath:ffprobe});
  const windows=[{sourceStartFrame:3,frameCount:4,stagedStartFrame:0},{sourceStartFrame:16,frameCount:5,stagedStartFrame:4}];
  const renderInput=JSON.parse(await readFile(join(directory,'render/render-input.json'),'utf8'));
  assert.deepEqual(renderInput.inputProps.timeline,{...timeline,narration:timeline.narration.map(({wavPath,...narration})=>narration)},'packing must not rewrite the picture or narration clocks; only private audio paths are omitted from browser props');
  assert.deepEqual(renderInput.inputProps.sourceFiles,{codes:{file:'source-0.mp4',windows}});
  const staging=JSON.parse(await readFile(join(directory,'render/source-staging.json'),'utf8'));
  assert.equal(staging.schemaVersion,3);
  assert.deepEqual(staging.sources.codes.windows,windows);
  assert.equal(staging.sources.codes.frameCount,9,'repeated uses share the same packed frames; omitted source gaps are not staged');
  assert.deepEqual((await readdir(join(directory,'render/assets'))).filter(file=>file.endsWith('.mp4')),['source-0.mp4'],'one packed derivative serves all uses of one source');
  const decodeFrames=async(name:string,mediaPath:string)=>{
    const output=join(directory,`${name}.gray`);
    await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',mediaPath,'-vf','crop=8:8:100:100,scale=1:1','-fps_mode','passthrough','-pix_fmt','gray','-f','rawvideo',output],join(directory,`${name}-frames.log`));
    return [...await readFile(output)];
  };
  const original=await decodeFrames('source',source);
  assert.equal(original.length,24);
  const expectedSourceFrames=[16,17,18,19,3,4,5,6,16,17,18,19,20,20,20,20,20,20];
  const expected=expectedSourceFrames.map(frame=>original[frame]);
  for(let frame=1;frame<original.length;frame++)assert.ok(original[frame]-original[frame-1]>=7,'every source frame code is distinguishable');
  assert.deepEqual(await decodeFrames('packed',join(directory,'render/assets/source-0.mp4')),[3,4,5,6,16,17,18,19,20].map(frame=>original[frame]),'the derivative preserves each selected source code once, without any gap');
  const masterFrames=await decodeFrames('master',result.masterPath),deliveryFrames=await decodeFrames('delivery',result.videoPath);
  for(const actual of [masterFrames,deliveryFrames]){
    assert.equal(actual.length,expected.length,'no frame may be dropped or duplicated');
    for(let frame=0;frame<expected.length;frame++)assert.ok(Math.abs(actual[frame]-expected[frame])<=3,`output frame ${frame} must retain source code ${expectedSourceFrames[frame]}: ${actual[frame]} vs ${expected[frame]}`);
    const identities=actual.map(code=>original.reduce((closest,candidate,index)=>Math.abs(candidate-code)<Math.abs(original[closest]-code)?index:closest,0));
    assert.deepEqual(identities,expectedSourceFrames,'every decoded output frame identifies the exact intended original frame across packing, cuts, repetition and holds');
  }
  const audioPath=join(directory,'master-audio.s16');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',result.masterPath,'-map','0:a:0','-ac','1','-c:a','pcm_s16le','-f','s16le',audioPath],join(directory,'decode-master-audio.log'));
  const pcm=await readFile(audioPath),cues:number[]=[];
  for(let sample=0;sample<pcm.length/2;sample++)if(Math.abs(pcm.readInt16LE(sample*2))>32)cues.push(sample);
  assert.equal(pcm.length/2,18*800,'the MOV master retains exactly 800 PCM samples per picture frame');
  assert.deepEqual(cues,[2400,8000],'PCM impulses retain their exact sample positions across picture cuts and holds');
  assert.ok(pcm.readInt16LE(2400*2)>0&&pcm.readInt16LE(8000*2)<0,'distinct cue identity survives mixing');
  const originalAudioPath=join(directory,'original-audio.s16');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',voice,'-map','0:a:0','-ac','1','-c:a','pcm_s16le','-f','s16le',originalAudioPath],join(directory,'decode-original-audio.log'));
  assert.deepEqual(pcm,await readFile(originalAudioPath),'picture packing and reordering leave the original PCM samples unchanged');
  const evidence={expectedSourceFrames,expectedCodes:expected,masterCodes:masterFrames,deliveryCodes:deliveryFrames,pcmSampleCount:pcm.length/2,pcmCueSamples:cues,audioTiming:result.metrics.audioTiming};
  await writeFile(join(directory,'clock-qualification.json'),JSON.stringify(evidence,null,2));
});

test('Remotion delivers full-frame captions, selected sources and a moving editorial camera over a hold',{skip:process.platform!=='darwin'||![ffmpeg,ffprobe,browser].every(existsSync),timeout:180000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-render-integration-'));
  t.after(async context=>{if(context.passed)await rm(directory,{recursive:true});else context.diagnostic(`Render test evidence retained at ${directory}`);});
  const red=join(directory,'red.mp4'),blue=join(directory,'blue.mp4'),voice=join(directory,'voice.wav');
  for(const [index,color] of ['red','blue'].entries())await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i',`color=c=${color}:s=3200x1800:r=60:d=0.5`,'-vf','drawbox=x=0:y=0:w=iw:h=24:color=yellow:t=fill,drawbox=x=0:y=ih-24:w=iw:h=24:color=lime:t=fill,drawbox=x=400:y=800:w=200:h=100:color=lime:t=fill','-c:v','libx264','-preset','ultrafast','-crf','18',index===0?red:blue],join(directory,`source-${index}.log`));
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=0.8','-c:a','pcm_s16le',voice],join(directory,'audio.log'));
  const timeline:Timeline={sourceWidth:3200,sourceHeight:1800,sources:{red:{pointer:[]},blue:{pointer:[]}},narration:[{id:'voice',outputStartSeconds:0,durationSeconds:1,wavPath:voice,captions:[{text:'A single phrase across the cut.',startSeconds:0,endSeconds:.8}]}],segments:[
    {id:'red',sourceId:'red',kind:'live',transition:'cut',sourceStartSeconds:0,sourceEndSeconds:.25,outputStartSeconds:0,durationSeconds:.25,zoom:1,target:null},
    {id:'blue',sourceId:'blue',kind:'live',transition:'cut',sourceStartSeconds:0,sourceEndSeconds:.25,outputStartSeconds:.25,durationSeconds:.25,zoom:1,target:null},
    {id:'blue-hold',sourceId:'blue',kind:'hold',transition:'continuous',sourceStartSeconds:.25,sourceEndSeconds:.25,outputStartSeconds:.5,durationSeconds:.5,zoom:1,target:null,cameraMove:{startSeconds:0,durationSeconds:.5,zoom:1.5,target:null}}
  ]};
  const result=await observeStreamingScratch(directory,()=>renderWalkthrough({timeline,sourcePaths:{red,blue},directory:join(directory,'render'),browserPath:browser,ffmpegPath:ffmpeg,ffprobePath:ffprobe}));
  const renderInput=JSON.parse(await readFile(join(directory,'render/render-input.json'),'utf8'));
  assert.equal(renderInput.inputProps.presentation,'full-frame-visible-captions');
  assert.equal(Object.hasOwn(renderInput.inputProps,'fontFile'),false);
  const staging=JSON.parse(await readFile(join(directory,'render/source-staging.json'),'utf8'));
  assert.equal(staging.schemaVersion,3);
  assert.equal(staging.sources.red.method,'causal-sample-and-hold');
  assert.deepEqual(staging.sources.red.windows,[{sourceStartFrame:0,frameCount:15,stagedStartFrame:0}]);
  assert.deepEqual(staging.sources.blue.windows,[{sourceStartFrame:0,frameCount:16,stagedStartFrame:0}]);
  assert.equal(staging.sources.red.frameCount,15);
  assert.equal(staging.sources.blue.frameCount,16);
  assert.equal(staging.sources.blue.sourceCadenceAcceptance,'owned-by-capture-qualification');
  assert.equal(result.metrics.expectedFrames,60);
  const pixels=join(directory,'pixels.rgb');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',result.videoPath,'-vf','select=eq(n\\,0)+eq(n\\,15)+eq(n\\,59),crop=100:100:500:400,scale=1:1','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo',pixels],join(directory,'decode.log'));
  const bytes=await readFile(pixels);
  assert.equal(bytes.length,9);
  assert.ok(bytes[0]>200&&bytes[2]<40,'First source is red');
  assert.ok(bytes[5]>200&&bytes[3]<40,'Cut selects blue source');
  assert.ok(bytes[8]>200&&bytes[6]<40,'Explicit hold stays on blue source');
  // Decode both source edges from the delivered H.264, not just the camera
  // transform. Neither edge may vanish behind a crop or a caption overlay.
  for(const [name,y,green] of [['top',2,false],['bottom',1070,true]] as const){
    const path=join(directory,`${name}-edge.rgb`);
    await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',result.videoPath,'-vf',`select=eq(n\\,0),crop=8:8:500:${y},scale=1:1`,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo',path],join(directory,`${name}-edge.log`));
    const edge=await readFile(path);
    assert.equal(edge.length,3);
    assert.ok(edge[1]>200&&edge[2]<50&&(green?edge[0]<50:edge[0]>200),`${name} source edge remains visible`);
  }
  const captionArea=join(directory,'caption-area.rgb');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',result.videoPath,'-vf','select=eq(n\\,0),crop=1400:100:260:930','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo',captionArea],join(directory,'caption-area.log'));
  const captionPixels=await readFile(captionArea);
  let white=0,backing=0;
  for(let pixel=0;pixel<captionPixels.length;pixel+=3){
    if(captionPixels[pixel]>200&&captionPixels[pixel+1]>200&&captionPixels[pixel+2]>200)white++;
    if(captionPixels[pixel]>40&&captionPixels[pixel]<130&&captionPixels[pixel+1]<30&&captionPixels[pixel+2]<30)backing++;
    if((pixel/3)%1400<100)assert.ok(captionPixels[pixel]>200&&captionPixels[pixel+1]<50&&captionPixels[pixel+2]<50,'outside the phrase-sized backing the product remains unobstructed');
  }
  assert.ok(white>100,'the delivered H.264 contains readable white caption glyphs');
  assert.ok(backing>1000,'the delivered H.264 contains a restrained dark caption backing');
  const silence=join(directory,'silence.rgb');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',result.videoPath,'-vf','select=eq(n\\,59),crop=1400:100:260:930','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo',silence],join(directory,'silence.log'));
  const silentPixels=await readFile(silence);
  for(let pixel=0;pixel<silentPixels.length;pixel+=3)assert.ok(silentPixels[pixel]<50&&silentPixels[pixel+1]<50&&silentPixels[pixel+2]>200,'caption backing disappears in the aligned gap');
  const marker=join(directory,'camera-marker.rgb');
  await executeLocal(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-n','-i',result.videoPath,'-vf','select=eq(n\\,30)+eq(n\\,59),crop=8:8:296:496,scale=1:1','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo',marker],join(directory,'camera-marker.log'));
  const motion=await readFile(marker);
  assert.equal(motion.length,6);
  assert.ok(motion[1]>200&&motion[2]<50,'the held source marker starts at its original full-frame position');
  assert.ok(motion[4]<50&&motion[5]>200,'the moving camera reframes the held source without advancing its source time');
});
