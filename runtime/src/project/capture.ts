import {readFile,readdir,stat,realpath,lstat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import type {Page} from 'playwright';
import {analyzeTake,beginTake,sourceSeconds,type CaptureMap} from '../capture/take.ts';
import {asCaptureSurface,type CaptureSurface} from '../capture/surface.ts';
import type {InputEvent} from '../session/events.ts';
import {Failure} from '../core/contracts.ts';
import {fileDigest} from '../core/files.ts';
import type {Box,LocalTools,TakeRecord,SourceSet,SourceMark,FilmSource,FilmArtifact,MarkTargetObservation} from './contracts.ts';
import {newId,checkedId,readProject,saveJson,retainFile,saveSourceSet,retainedPath,projectDirectory,ownedDirectory,loadSourceSet,validateSourceSet} from './store.ts';

export type RawMark={id:string;title:string;atMs:number;target:Box|null;targetObservation?:MarkTargetObservation;settled?:{startMs:number;endMs:number}};
const scaled=(box:Box|null):Box|null=>box?{x:box.x*2,y:box.y*2,width:box.width*2,height:box.height*2}:null;
type CaptureWindow={startMs:number;endMs:number;basis:'recorded-capture-window'|'retained-event-and-mark-envelope'};

/** Map retained observation geometry once, alongside the take's original clock. */
export function sourceMarks(rawMarks:RawMark[],source:FilmSource,time:(ms:number)=>number):SourceMark[]{
  return rawMarks.map(m=>({id:m.id,title:m.title,sourceId:source.id,timeSeconds:time(m.atMs),target:scaled(m.target),
    ...(m.targetObservation?{targetObservation:structuredClone(m.targetObservation)}:{}),
    ...(m.settled?{settled:{startSeconds:Math.max(time(m.settled.startMs),source.usableRange.startSeconds),endSeconds:Math.min(time(m.settled.endMs),source.usableRange.endSeconds),method:'observed-stability' as const}}:{})}));
}

/** Normal stop and offline recovery use exactly the same clock mapping. */
async function finalizeTake(record:TakeRecord,map:CaptureMap,events:InputEvent[],rawMarks:RawMark[],window:CaptureWindow){
  const time=(ms:number)=>sourceSeconds(map,ms);
  if(![window.startMs,window.endMs].every(Number.isFinite)||window.endMs<=window.startMs)throw new Failure('CAPTURE_WINDOW_UNAVAILABLE','capture','A usable interval needs retained beginning and ending observations. Do not infer missing input times.');
  const pointer=events.filter(e=>e.source==='browser'&&['pointermove','pointerdown','pointerup'].includes(e.kind)).map(e=>({timeSeconds:time(e.atMs),x:e.x!*2,y:e.y!*2,type:({pointermove:'move',pointerdown:'down',pointerup:'up'} as const)[e.kind as 'pointermove'|'pointerdown'|'pointerup'],...(e.gesture?{gesture:e.gesture}:{})})).sort((a,b)=>a.timeSeconds-b.timeSeconds);
  const usableRange={startSeconds:Math.max(time(window.startMs),map.usableRasterRange.startSeconds),endSeconds:Math.min(time(window.endMs),map.usableRasterRange.endSeconds)};
  const source:FilmSource={id:record.id,media:{relativePath:'source.mp4',sha256:await fileDigest(map.sourcePath),bytes:(await stat(map.sourcePath)).size},width:map.width,height:map.height,durationSeconds:map.durationSeconds,frameCount:map.frameCount,clock:{offsetSeconds:map.offsetSeconds,uncertaintySeconds:map.uncertaintySeconds,driftSeconds:map.driftSeconds},pointer,usableRange};
  const marks=sourceMarks(rawMarks,source,time);
  if(marks.some(mark=>mark.settled&&mark.settled.endSeconds<mark.settled.startSeconds))throw new Failure('CAPTURE_SETTLEMENT_OUTSIDE_PRODUCT','capture','The retained stability observation has no interval inside the measured product raster. Keep its original evidence; do not admit a slate as a reading hold.');
  if(marks.some(mark=>mark.timeSeconds<usableRange.startSeconds||mark.timeSeconds>usableRange.endSeconds))throw new Failure('CAPTURE_MARK_OUTSIDE_PRODUCT','capture','A retained mark falls outside the measured product raster. Inspect its original timestamp rather than presenting calibration as application footage.');
  validateSourceSet({schemaVersion:1,kind:'source-set',id:'validation',projectId:'validation',createdAt:record.createdAt,state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[source],marks,artifacts:[]});
  return {...record,source,marks,state:'stopped' as const};
}

/** The selected surface and its input clock are injected; this owns no browser. */
export function createSessionCapture(input:{projectPath:string;sessionId:string;page:Page|CaptureSurface;pageId:string;tools:LocalTools;events:InputEvent[]}){
  const surface=asCaptureSurface(input.page);
  let current:{record:TakeRecord;directory:string;handle:Awaited<ReturnType<typeof beginTake>>;startMs:number;firstEvent:number;marks:RawMark[]}|undefined;
  let latest:TakeRecord|undefined,stopping:Promise<TakeRecord>|undefined;
  const inspect=()=>({state:current?'recording':'idle',take:current?.record??latest??null});
  return {inspect,async start(options:{title?:string}={}){
    if(current||stopping)throw new Failure('CAPTURE_ALREADY_ACTIVE','capture','Stop the current take before starting another.');
    if(options.title!==undefined&&(typeof options.title!=='string'||!options.title.trim()))throw new Failure('CAPTURE_TITLE_INVALID','capture','Provide a nonempty title for this take.');
    await readProject(input.projectPath);const id=newId('take'),directory=await ownedDirectory(input.projectPath,'takes',id);
    const record:TakeRecord={schemaVersion:1,id,sessionId:input.sessionId,pageId:input.pageId,title:options.title??'Untitled take',createdAt:new Date().toISOString(),state:'recording',marks:[],eventsPath:'input-events.json'};
    await saveJson(join(directory,'take.json'),record,true);
    try{const firstEvent=input.events.length,handle=await beginTake(surface,input.tools,directory);
      current={record,directory,handle,startMs:performance.now(),firstEvent,marks:[]};latest=record;return inspect();
    }catch(error){record.state='failed';record.error=error instanceof Failure?{code:error.code,recovery:error.recovery}:{code:'CAPTURE_START_FAILED',recovery:'Inspect this retained take. No new capture starts automatically.'};await saveJson(join(directory,'take.json'),record);latest=record;throw error;}
  },async mark(options:{id?:string;title:string;settled?:boolean;target?:Box;targetObservation?:Omit<MarkTargetObservation,'markId'>;verifyTarget?:()=>Promise<void>}){
    if(!current)throw new Failure('CAPTURE_NOT_ACTIVE','capture','Start a take before marking a moment.');
    const id=options.id??newId('mark');checkedId(id);if(current.marks.some(m=>m.id===id))throw new Failure('MARK_ID_EXISTS','capture','Use the already retained mark or a distinct moment identity.');
    if(typeof options.title!=='string'||!options.title.trim())throw new Failure('MARK_TITLE_REQUIRED','capture','Name the visible capability, response or subject.');
    if(options.settled!==undefined&&typeof options.settled!=='boolean')throw new Failure('MARK_SETTLED_INVALID','capture','Use settled true to request an observed stability check, or omit it for a live moment.');
    const target=options.target??null;
    if(target&&(![target.x,target.y,target.width,target.height].every(Number.isFinite)||target.x<0||target.y<0||target.width<=0||target.height<=0||target.x+target.width>1600||target.y+target.height>900))throw new Failure('MARK_TARGET_INVALID','capture','Use a rectangle in the 1600 by 900 observed CSS viewport.');
    const mark:RawMark={id,title:options.title,atMs:performance.now(),target,...(options.targetObservation?{targetObservation:{...structuredClone(options.targetObservation),markId:id}}:{})};
    if(options.settled){
      const startMs=performance.now();const baseline=await surface.screenshot();
      // Actual raster stability admits static canvas/SVG without pretending DOM
      // mutation quietness establishes visual stillness. Compare the native
      // capture raster: CSS-size screenshot downsampling can round an unchanged
      // antialiased edge differently between frames. Moving scenes stay live.
      for(const pause of [137,193,251]){
        await delay(pause);const frame=await surface.screenshot();
        if(!baseline.equals(frame)){
          await writeFile(join(current.directory,`settlement-${id}-baseline.png`),baseline,{mode:0o600});
          await writeFile(join(current.directory,`settlement-${id}-changed.png`),frame,{mode:0o600});
          await saveJson(join(current.directory,`settlement-${id}.json`),{startMs,changedMs:performance.now(),scale:'device'});
          throw new Failure('SCENE_NOT_SETTLED','capture','Keep this moving state as live footage, or observe the settled result before marking a reading hold. The differing native raster samples are retained with the take.');
        }
      }
      mark.settled={startMs,endMs:performance.now()};mark.atMs=mark.settled.endMs;
    }
    // Settlement is independent. Recheck the observed geometry after its raster
    // samples, without moving the page to recover a stale or hidden subject.
    await options.verifyTarget?.();
    current.marks.push(mark);await saveJson(join(current.directory,'raw-marks.json'),current.marks);return {id,title:mark.title,takeId:current.record.id,settled:!!mark.settled,...(mark.targetObservation?{target:scaled(target),targetObservation:mark.targetObservation}:{})};
  },async stop():Promise<TakeRecord>{
    if(stopping)return stopping;
    if(!current){if(latest)return latest;throw new Failure('CAPTURE_NOT_ACTIVE','capture','No take has been started in this page.');}
    const take=current;const endMs=performance.now();
    stopping=(async()=>{let failure:unknown;
      const events=input.events.slice(take.firstEvent).filter(event=>event.atMs>=take.startMs&&event.atMs<=endMs);
      const window:CaptureWindow={startMs:take.startMs,endMs,basis:'recorded-capture-window'};
      try{await saveJson(join(take.directory,'input-events.json'),events);await saveJson(join(take.directory,'raw-marks.json'),take.marks);await saveJson(join(take.directory,'capture-window.json'),window);}catch(error){failure=error;}
      try{
        const map=await take.handle.finish();if(failure)throw failure;
        take.record=await finalizeTake(take.record,map,events,take.marks,window);
      }catch(error){failure??=error;await take.handle.abort().catch(()=>{});take.record.state='failed';take.record.error={code:error instanceof Failure?error.code:'CAPTURE_STOP_FAILED',recovery:'Close the original session, then use capture recover --take with this take identity to qualify retained bytes offline. Missing ending calibration cannot be reconstructed; completed earlier takes remain usable.'};}
      finally{await saveJson(join(take.directory,'take.json'),take.record);latest=take.record;current=undefined;stopping=undefined;}
      if(failure)throw failure;return take.record;
    })();return stopping;
  }};
}

/** Adopt completed recording bytes after finalization failed. This neither opens
 * a browser nor retries capture stop. The original stop operation stays intact. */
export async function recoverTake(input:{projectPath:string;takeId:string;tools:LocalTools;signal?:AbortSignal}){
  const project=await readProject(input.projectPath),root=await projectDirectory(input.projectPath),id=checkedId(input.takeId),directory=join(root,'takes',id);
  const literal=async(name:string)=>{const path=join(directory,name);if(await realpath(path)!==path||!(await lstat(path)).isFile())throw new Failure('TAKE_PATH_REDIRECT','capture','Restore the exact project-owned take files.');return path;};
  const manifest=await literal('take.json'),record=JSON.parse(await readFile(manifest,'utf8')) as TakeRecord;
  if(record.id!==id)throw new Failure('TAKE_ID_MISMATCH','capture','Choose the original take identity.');
  if(record.state==='stopped'&&record.source){await retainedPath(directory,record.source.media);return record;}
  if(record.state!=='failed')throw new Failure('TAKE_NOT_RECOVERABLE','capture','Inspect and close the original session before recovering a failed finalization.');
  const sessionPath=join(root,'sessions',checkedId(record.sessionId));
  if(await realpath(sessionPath)!==sessionPath)throw new Failure('SESSION_PATH_REDIRECT','capture','Restore the original project session.');
  const {inspectSession}=await import('../session/index.ts'),{inspectWorker}=await import('../session/process.ts');
  const owner=await inspectSession(sessionPath),processes=await inspectWorker(owner.session);
  if(owner.session.sessionId!==record.sessionId||owner.session.projectId!==project.id||owner.session.projectPath!==root)throw new Failure('CAPTURE_SESSION_MISMATCH','capture','Restore the original take and its project session identity.');
  if(owner.live||owner.session.status!=='closed'||processes.worker!=='stopped'||processes.members.length)throw new Failure('CAPTURE_OWNER_NOT_STOPPED','capture','Close the original session and reconcile its worker and recorder before offline recovery. No process was stopped by this command.');
  const names=['source.mp4','capture-clock.json','input-events.json','raw-marks.json'];
  const inputs=[];
  for(const name of names){let path:string;try{path=await literal(name);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new Failure('CAPTURE_INPUT_MISSING','capture',`The original ${name} is missing. Restore those exact bytes; recovery cannot recreate calibration or application input.`);throw error;}inputs.push({relativePath:name,sha256:await fileDigest(path),bytes:(await stat(path)).size});}
  const events=JSON.parse(await readFile(join(directory,'input-events.json'),'utf8')) as InputEvent[],marks=JSON.parse(await readFile(join(directory,'raw-marks.json'),'utf8')) as RawMark[];
  if(!Array.isArray(events)||!Array.isArray(marks))throw new Failure('CAPTURE_RECORDS_INVALID','capture','Restore original input events and raw marks.');
  let window:CaptureWindow;
  try{const path=await literal('capture-window.json');window=JSON.parse(await readFile(path,'utf8'));inputs.push({relativePath:'capture-window.json',sha256:await fileDigest(path),bytes:(await stat(path)).size});}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    // Early releases retained events and marks, but not the in-memory stop
    // window. Admit only their measured envelope, not guessed lead/tail time.
    const times=[...events.map(e=>e.atMs),...marks.flatMap(m=>[m.atMs,...(m.settled?[m.settled.startMs,m.settled.endMs]:[])])];
    if(times.length<2||times.some(t=>!Number.isFinite(t)))throw new Failure('CAPTURE_WINDOW_UNAVAILABLE','capture','This older take lacks a recorded window and sufficient timestamped observations. Its missing boundaries cannot be recreated.');
    let startMs=Infinity,endMs=-Infinity;for(const t of times){startMs=Math.min(startMs,t);endMs=Math.max(endMs,t);}
    window={startMs,endMs,basis:'retained-event-and-mark-envelope'};
  }
  const originalPath=join(directory,'failed-take.json');
  try{await saveJson(originalPath,record,true);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(JSON.stringify(JSON.parse(await readFile(await literal('failed-take.json'),'utf8')))!==JSON.stringify(record))throw new Failure('CAPTURE_RECOVERY_CONFLICT','capture','The retained failed take changed. Inspect its original recovery before continuing.');}
  input.signal?.throwIfAborted();
  // Each analysis owns a fresh output. Failed/cancelled attempts and the
  // original diagnostics remain evidence, never a shared scratch file.
  const recoveryId=newId('recovery'),analysisName=`${recoveryId}-analysis.json`;
  const map=await analyzeTake(input.tools,directory,{signal:input.signal,diagnosticsPath:join(directory,analysisName)});
  const clock=JSON.parse(await readFile(join(directory,'capture-clock.json'),'utf8'));
  if(window.startMs<=clock.start.afterMs||window.endMs>=clock.end.beforeMs)throw new Failure('CAPTURE_WINDOW_INVALID','capture','Retained usable observations must lie between the original calibration anchors.');
  const recovered=await finalizeTake(record,map,events,marks,window);
  for(const file of inputs)await retainedPath(directory,file);
  input.signal?.throwIfAborted();
  if(JSON.stringify(JSON.parse(await readFile(manifest,'utf8')))!==JSON.stringify(record))throw new Failure('CAPTURE_RECOVERY_CONFLICT','capture','The original take changed during analysis. Inspect it before continuing; no finalization was overwritten.');
  // The recovery preserves the failed record and error, including when this
  // local analysis itself is interrupted. Only the final manifest admits seal.
  const analysis={relativePath:analysisName,sha256:await fileDigest(await literal(analysisName)),bytes:(await stat(join(directory,analysisName))).size};
  const recordPath=`${recoveryId}.json`;
  await saveJson(join(directory,recordPath),{schemaVersion:1,projectId:project.id,takeId:id,originalRecord:'failed-take.json',inputs,window,analysis,applicationSuccess:'not-attested'},true);
  recovered.recovery={recordPath,analysis,windowBasis:window.basis};delete recovered.error;
  await saveJson(manifest,recovered);return recovered;
}

export async function sealTakes(input:{projectPath:string;takeIds:string[];artifactPaths?:Array<{path:string;id:string;title:string;filename:string;mediaType:string;role:'deliverable'|'source'}>}){
  const project=await readProject(input.projectPath),projectPath=await projectDirectory(input.projectPath);
  if(!Array.isArray(input.takeIds)||!input.takeIds.length||new Set(input.takeIds).size!==input.takeIds.length)throw new Failure('TAKES_REQUIRED','capture','Select the exact completed takes to seal.');
  const takes: Array<{directory:string;record:TakeRecord}>=[];
  for(const id of input.takeIds){const directory=join(projectPath,'takes',checkedId(id));
    if(await realpath(directory)!==directory||(await lstat(join(directory,'take.json'))).isSymbolicLink())throw new Failure('TAKE_PATH_REDIRECT','capture','Restore the exact project-owned take before sealing.');
    const record=JSON.parse(await readFile(join(directory,'take.json'),'utf8')) as TakeRecord;
    if(record.id!==id||record.state!=='stopped'||!record.source)throw new Failure('TAKE_NOT_COMPLETE','capture','Only completed calibrated takes can be sealed. Inspect unfinished occurrences rather than repeating input.');
    if(record.marks.some(mark=>mark.sourceId!==record.source!.id||mark.targetObservation&&(mark.targetObservation.pageId!==record.pageId||mark.targetObservation.markId!==mark.id)))throw new Failure('MARK_SOURCE_MISMATCH','capture','Keep each mark with its original take, page and identity. Do not relabel observed framing from another source.');
    await retainedPath(directory,record.source.media);takes.push({directory,record});}
  const id=newId('sources'),directory=await ownedDirectory(projectPath,'sources',id);
  const set:SourceSet={schemaVersion:1,kind:'source-set',id,projectId:project.id,createdAt:new Date().toISOString(),state:'sealed',mediaReview:project.mandate.mediaReview,sources:[],marks:[],artifacts:[],records:[],provenance:{kind:'interactive-capture',sessionIds:[...new Set(takes.map(t=>t.record.sessionId))],takeIds:input.takeIds,applicationSuccess:'not-attested'}};
  for(const {directory:takeDir,record} of takes){
    set.sources.push({...record.source!,media:await retainFile(join(takeDir,record.source!.media.relativePath),directory,`${record.id}/source.mp4`)});
    set.marks.push(...record.marks);
    for(const name of ['take.json','input-events.json','raw-marks.json','capture-clock.json',...(!record.recovery?['capture-analysis.json']:[])])set.records!.push(await retainFile(join(takeDir,name),directory,`${record.id}/${name}`));
    for(const name of ['capture-window.json','failed-take.json',...(record.recovery?['capture-analysis.json']:[])]){try{await lstat(join(takeDir,name));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}set.records!.push(await retainFile(join(takeDir,name),directory,`${record.id}/${name}`));}
    if(record.recovery){
      await retainedPath(takeDir,record.recovery.analysis);
      for(const name of [checkedId(record.recovery.recordPath),record.recovery.analysis.relativePath])set.records!.push(await retainFile(join(takeDir,name),directory,`${record.id}/${name}`));
    }
  }
  for(const artifact of input.artifactPaths??[]){checkedId(artifact.id);set.artifacts.push({...await retainFile(artifact.path,directory,`artifacts/${artifact.id}`),id:artifact.id,title:artifact.title,filename:artifact.filename,mediaType:artifact.mediaType,role:artifact.role});}
  return {sourceSet:set,...await saveSourceSet(input.projectPath,set)};
}

export async function listProjectArtifacts(projectPath:string){
  await readProject(projectPath);const directory=await projectDirectory(projectPath),found:Array<FilmArtifact&{sourceSetId:string}>=[];
  const sources=join(directory,'sources');if(await realpath(sources)!==sources)throw new Failure('SOURCE_DIRECTORY_REDIRECT','sources','Restore the project-owned source directory.');
  for(const entry of await readdir(sources,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;const name=checkedId(entry.name);
    let set:SourceSet;try{set=(await loadSourceSet(directory,name)).sourceSet;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    for(const artifact of set.artifacts)found.push({...artifact,sourceSetId:name});
  }return found;
}

/** Called only after the session owner has observed the original worker and
 * recorder processes stopped. Preserve all bytes and identities; never encode
 * or promote an unfinished recording to a complete source. */
export async function interruptSessionTakes(projectPath:string,sessionId:string){
  checkedId(sessionId);await readProject(projectPath);const root=await projectDirectory(projectPath),directory=join(root,'takes'),interrupted:string[]=[];
  if(await realpath(directory)!==directory)throw new Failure('TAKE_PATH_REDIRECT','capture','Restore the project-owned takes directory.');
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    const id=checkedId(entry.name),path=join(directory,id,'take.json');
    let record:TakeRecord;
    try{if((await lstat(path)).isSymbolicLink())throw new Failure('TAKE_PATH_REDIRECT','capture','Restore the literal take manifest.');record=JSON.parse(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    if(record.id!==id||record.sessionId!==sessionId||record.state!=='recording')continue;
    record.state='failed';record.error={code:'CAPTURE_WORKER_INTERRUPTED',recovery:'The original session processes were observed stopped. This unfinished take is not a sealed source; earlier completed takes remain available. No input or recording was repeated.'};
    await saveJson(path,record);interrupted.push(id);
  }
  return interrupted;
}
