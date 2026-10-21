import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createSessionCapture,sealTakes,interruptSessionTakes,recoverTake} from '../src/project/capture.ts';
import {createProject,loadSourceSet,ownedDirectory,saveJson} from '../src/project/store.ts';
import {openSessionBrowser} from '../src/session/browser.ts';
import {qualifiedBrowserPath} from '../src/core/environment.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';

const tools={...resolveLocalTools(),nodePath:process.execPath,browserPath:qualifiedBrowserPath()};
const brief={title:'Synthetic native capture qualification',brief:'Exercise observed raster stability and native motion without application adapters.',audience:'Test',mandate:{applicationUrl:'http://127.0.0.1/',navigationOrigins:['http://127.0.0.1'],network:'loopback-only' as const,allowedEffects:'Native input on a synthetic fixture only.',dataDescription:'Generated synthetic raster',inputRoots:[],mediaReview:'agent-reviewable-synthetic' as const,delivery:'local' as const}};

test('static canvas settles, moving canvas is rejected, and native motion survives capture and sealing',async()=>{
  const root=await mkdtemp('/private/tmp/wt-project-capture-'),projectPath=join(root,'project');
  await createProject(projectPath,brief);
  // The public supervisor deliberately does not inherit discovery PATH. Keep
  // this fixture's selected tools and operation state independent of user setup.
  const configRoot=join(root,'settings'),stateRoot=join(root,'state');
  await mkdir(configRoot,{mode:0o700});
  await saveJson(join(configRoot,'toolchain.json'),{schemaVersion:1,tools});
  const context=await openSessionBrowser({profileDirectory:join(root,'profile'),headless:true,network:'loopback-only'});
  let capture:ReturnType<typeof createSessionCapture>|undefined,passed=false;
  try{
    const page=await context.newPage();
    await page.route('http://127.0.0.1/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><style>body{margin:0;background:#123}canvas{position:absolute;left:0;top:300px;width:80px;height:80px}button{position:fixed;left:20px;top:20px}</style><canvas width="80" height="80"></canvas><button>Start motion</button><script>
      const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),button=document.querySelector('button');let running=false;
      ctx.fillStyle='#fff';ctx.fillRect(0,0,80,80);
      const animation=canvas.animate([{transform:'translateX(100px)'},{transform:'translateX(1200px)'}],{duration:4000,iterations:Infinity});animation.pause();
      button.onclick=()=>{running=!running;button.textContent=running?'Stop motion':'Start motion';if(running)animation.play();else animation.pause()};
      </script>`}));
    await page.goto(brief.mandate.applicationUrl);
    capture=createSessionCapture({projectPath,sessionId:'synthetic',page,pageId:'synthetic-page',tools,events:[]});
    await capture.start({title:'Native canvas movement'});
    await capture.mark({id:'static-before',title:'Static canvas',settled:true});
    await page.getByRole('button',{name:'Start motion'}).click();
    await capture.mark({id:'motion-start',title:'Native animation begins'});
    await page.waitForTimeout(3000);
    await capture.mark({id:'motion-end',title:'Native animation observed'});
    await assert.rejects(capture.mark({id:'moving-hold',title:'Must remain live',settled:true}),(error:any)=>error.code==='SCENE_NOT_SETTLED');
    await page.getByRole('button',{name:'Stop motion'}).click();
    await capture.mark({id:'static-after',title:'Stopped canvas',settled:true});
    const take=await capture.stop();assert.equal(take.state,'stopped');
    assert.deepEqual(take.marks.filter(mark=>mark.settled).map(mark=>mark.id),['static-before','static-after']);
    assert.ok(!take.marks.some(mark=>mark.id==='moving-hold'),'a failed stability check must not create a hold');
    const sealed=await sealTakes({projectPath,takeIds:[take.id]});
    const loaded=await loadSourceSet(projectPath,sealed.sourceSet.id);assert.equal(loaded.sourceSet.sources[0].id,take.id);
    const analysis=JSON.parse(await readFile(join(projectPath,'takes',take.id,'capture-analysis.json'),'utf8'));
    const start=take.marks.find(mark=>mark.id==='motion-start')!.timeSeconds,end=take.marks.find(mark=>mark.id==='motion-end')!.timeSeconds;
    const pts:number[]=analysis.probe.frames.map((frame:any)=>Number(frame.best_effort_timestamp_time));
    // Decode original VFR samples, without an FPS filter. The moving white
    // square gives a measured spatial position, so repeated/held encodes cannot
    // qualify merely by carrying 60 Hz timestamps or a nominal frame-rate tag.
    const pixels=execFileSync(tools.ffmpegPath,['-v','error','-i',loaded.sourcePaths[take.id],'-vf','crop=3200:2:0:640,scale=1600:1:flags=area','-fps_mode','passthrough','-f','rawvideo','-pix_fmt','gray','pipe:1'],{maxBuffer:4*1024*1024});
    assert.equal(pixels.length,pts.length*1600);
    const motion=pts.flatMap((at,index)=>{
      if(at<start||at>end)return [];
      const row=pixels.subarray(index*1600,(index+1)*1600),x=row.findIndex(value=>value>240);
      assert.ok(x>=0&&x<1280,'every motion sample must actually contain the moving subject');
      return [{at,x}];
    });
    const changes=motion.slice(1).filter((frame,index)=>frame.x!==motion[index].x),span=motion.at(-1)!.at-motion[0].at;
    const measurement={samples:motion.length,changedPositions:changes.length,spanSeconds:span,changedPositionsPerSecond:changes.length/span,maxSampleGapSeconds:Math.max(...motion.slice(1).map((frame,index)=>frame.at-motion[index].at))};
    await saveJson(join(root,'native-motion-measurement.json'),measurement);
    assert.ok(measurement.changedPositionsPerSecond>=57,JSON.stringify(measurement));
    assert.ok(measurement.maxSampleGapSeconds<0.04,JSON.stringify(measurement));
    assert.equal(analysis.markerFrames.length,2);
    // Model loss after recorder stop/analysis, before take manifest commit.
    // Recover through the public command, without a live application owner.
    await context.close();capture=undefined;
    const sessionDir=await ownedDirectory(projectPath,'sessions','synthetic');
    await saveJson(join(sessionDir,'session.json'),{version:1,sessionId:'synthetic',projectId:sealed.sourceSet.projectId,projectPath,directory:sessionDir,status:'closed',captureActive:false,socketPath:join(root,'closed.sock'),createdAt:take.createdAt,updatedAt:take.createdAt,processIdentity:{pid:2147483647,pgid:2147483647,startedAt:'0:0',commandSha256:'a'.repeat(64)}});
    const failed={...take,state:'failed',source:undefined,marks:[],error:{code:'CAPTURE_STOP_FAILED',recovery:'Test original failed finalization'}};
    const takeDir=join(projectPath,'takes',take.id);await saveJson(join(takeDir,'take.json'),failed);
    const originalMedia=await readFile(join(takeDir,'source.mp4')),originalAnalysis=await readFile(join(takeDir,'capture-analysis.json'));
    const response=JSON.parse(execFileSync(process.execPath,[join(import.meta.dirname,'../bin/walkthrough.mjs'),'capture','recover','--project',projectPath,'--take',take.id,'--json'],{encoding:'utf8',timeout:30000,env:{...process.env,WALKTHROUGH_CONFIG_ROOT:configRoot,WALKTHROUGH_STATE_ROOT:stateRoot}}));
    assert.equal(response.status,'ok',JSON.stringify(response));
    const recovered=JSON.parse(await readFile(join(takeDir,'take.json'),'utf8'));
    assert.equal(recovered.state,'stopped');assert.equal(recovered.recovery?.windowBasis,'recorded-capture-window');
    assert.deepEqual(recovered.source,take.source);assert.deepEqual(recovered.marks,take.marks);
    assert.equal(JSON.parse(await readFile(join(takeDir,'failed-take.json'),'utf8')).error.code,'CAPTURE_STOP_FAILED');
    const again=await recoverTake({projectPath,takeId:take.id,tools:{...tools,ffmpegPath:'/does-not-exist'}});assert.deepEqual(again,recovered,'same take is returned without repeating decode');
    const recoveredSet=await sealTakes({projectPath,takeIds:[take.id]});
    assert.ok(recoveredSet.sourceSet.records!.some(ref=>ref.relativePath.endsWith('/failed-take.json')));
    assert.ok(recoveredSet.sourceSet.records!.some(ref=>ref.relativePath.endsWith('/'+recovered.recovery.recordPath)));
    assert.ok(recoveredSet.sourceSet.records!.some(ref=>ref.relativePath.endsWith('/'+recovered.recovery.analysis.relativePath)));
    assert.deepEqual(await readFile(join(takeDir,'capture-analysis.json')),originalAnalysis,'recovery never overwrites original diagnostics');
    assert.deepEqual(await readFile(join(takeDir,'source.mp4')),originalMedia,'recovery never rewrites footage');
    assert.equal((await loadSourceSet(projectPath,sealed.sourceSet.id)).sourceSet.sources[0].media.sha256,take.source!.media.sha256,'earlier sealed source remains intact');
    // Older real captures lack the in-memory capture window. Keep only their
    // observation envelope, never fabricate the preceding/following footage.
    await saveJson(join(takeDir,'take.json'),failed);await unlink(join(takeDir,'capture-window.json'));
    await unlink(join(takeDir,'capture-analysis.json'));
    const legacy=await recoverTake({projectPath,takeId:take.id,tools});
    assert.equal(legacy.recovery?.windowBasis,'retained-event-and-mark-envelope');
    assert.ok(legacy.source!.usableRange.startSeconds>=take.source!.usableRange.startSeconds);
    assert.ok(legacy.source!.usableRange.endSeconds<=take.source!.usableRange.endSeconds);
    await sealTakes({projectPath,takeIds:[take.id]});
    await saveJson(join(takeDir,'take.json'),failed);await unlink(join(takeDir,'capture-clock.json'));
    await assert.rejects(recoverTake({projectPath,takeId:take.id,tools}),/capture-clock|CAPTURE_INPUT_MISSING/);
    assert.equal(JSON.parse(await readFile(join(takeDir,'take.json'),'utf8')).state,'failed','missing calibration never becomes a stopped take');
    passed=true;
    if(process.env.WALKTHROUGH_RETAIN_CAPTURE_TEST==='1')console.error(JSON.stringify({retained:root,sourceSet:sealed.path,measurement}));
  }finally{
    await capture?.stop().catch(()=>{});await context.close();
    if(passed&&process.env.WALKTHROUGH_RETAIN_CAPTURE_TEST!=='1')await rm(root,{recursive:true,force:true});
    else if(!passed)console.error(`Retained project capture diagnostics: ${root}`);
  }
});

test('dead-session reconciliation fails only original unfinished takes and preserves retained bytes',async()=>{
  const root=await mkdtemp('/private/tmp/wt-interrupted-capture-');
  try{
    await createProject(root,brief);
    for(const [id,sessionId,state] of [['unfinished','original','recording'],['complete','original','stopped'],['other','other-session','recording']] as const){
      const directory=await ownedDirectory(root,'takes',id);
      await saveJson(join(directory,'take.json'),{schemaVersion:1,id,sessionId,pageId:'page',title:id,createdAt:'2026-10-03T00:00:00Z',state,marks:[],eventsPath:'input-events.json'});
      await saveJson(join(directory,'original-bytes.json'),{id,state});
    }
    assert.deepEqual(await interruptSessionTakes(root,'original'),['unfinished']);
    const read=async(id:string)=>JSON.parse(await readFile(join(root,'takes',id,'take.json'),'utf8'));
    assert.equal((await read('unfinished')).error.code,'CAPTURE_WORKER_INTERRUPTED');
    assert.equal((await read('complete')).state,'stopped');assert.equal((await read('other')).state,'recording');
    assert.deepEqual(JSON.parse(await readFile(join(root,'takes','unfinished','original-bytes.json'),'utf8')),{id:'unfinished',state:'recording'});
    assert.deepEqual(await interruptSessionTakes(root,'original'),[],'reconciliation is idempotent and never reopens a capture');
  }finally{await rm(root,{recursive:true,force:true});}
});
