import {constants} from 'node:fs';
import {copyFile,writeFile,mkdir,stat,chmod,readFile,lstat,readdir,open,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createConnection} from 'node:net';
import {join} from 'node:path';
import {Failure,type LocalTools} from './contracts.ts';
import {fileDigest,sha256} from './files.ts';
import {runtimePaths} from './runtime-paths.ts';
import {localEnvironment,qualifiedNode} from './environment.ts';
import {qualifiedBrowserVersion} from './browser-qualification.ts';
import {resolveLocalTools} from './toolchain.ts';
import {verifyLicense} from './license.ts';
import {inspectAudioReadiness} from './audio-readiness.ts';
import {verifyBrowserCustodyPatch} from '../render/browser-custody.ts';
import {verifyFrameTransportPatch} from '../render/frame-transport.ts';
import {verifyStreamingEncodingStrategy,readStreamingEncodingRefusal,type MemoryAdmission} from '../render/memory-admission.ts';
import {renderWalkthrough} from '../render/index.ts';
import {LocalProcessFailure} from '../render/media.ts';
import {synthesizeNarration,type NarrationResult} from '../audio/index.ts';
import {inspectRetainedNarration} from '../audio/retained.ts';
import {readAudioProvision,resolveProvisionVoice} from '../audio/provision.ts';
import {loadSourceSet,readProject,projectDirectory,saveJson,createCompositionDirectory,checkedId} from '../project/store.ts';
import {buildFilmTimeline,filmTimelineVtt,validateFilmEdit,validateFilmSources,previewFrameRange,measureFilmNarrationFit,projectFilmNarrationFit,narrationPhraseConflicts,FilmCaptionFailure,FilmEditFailure,type FilmCaptionDiagnostic,type FilmNarrationFit} from './film-edit.ts';
import {filmEditorialObservations} from './film-editorial.ts';
import {beginPreview,compactPreviewScratch,publishPreview} from './film-preview-storage.ts';
import {pageItems} from '../project/inspection.ts';
import {qualifyTemporalVideo} from './quality.ts';
import {bundleFiles,observeBundle} from './bundle.ts';
import {validDeliveredArtifact,type DeliveredArtifact} from './deliverables.ts';
import {createReviewPage} from './review.ts';
import {compactFilmComposition,retainedCompositionStorage,type CompositionStorage} from './film-storage.ts';

interface FilmFailure {
  code:string;owner:string;recovery:string;caption?:FilmCaptionDiagnostic;location?:FilmEditFailure['location'];
  causeCode?:string;diagnosticPath?:string;
  child?:{exitCode:number|null;signal:NodeJS.Signals|null};
  memoryAdmission?:MemoryAdmission;
}
export interface FilmComposition {
  schemaVersion:1;kind:'composition';id:string;projectPath:string;createdAt:string;updatedAt:string;
  status:'running'|'failed'|'awaiting-human-review';stage:string;
  sourceSet:{id:string;sha256:string};paths:Record<string,string>;proof:Record<string,unknown>;
  error?:FilmFailure;
  narrationFit?:(Omit<FilmNarrationFit,'phrases'>&{diagnosticPath:string});
  storage?:CompositionStorage;
}
const localTools:LocalTools=resolveLocalTools();

export async function assertCompositionNetworkIsolation(){
  await new Promise<void>((accept,reject)=>{
    // UDP connect only associates an address on macOS: it sends no packet and
    // therefore does not exercise the sandbox's outbound-network decision.
    // TCP connect reaches that boundary without sending application content.
    const socket=createConnection({host:'192.0.2.1',port:9});let settled=false;
    const done=(error?:NodeJS.ErrnoException)=>{if(settled)return;settled=true;socket.destroy();if(error?.code==='EPERM'||error?.code==='EACCES')accept();else reject(new Failure('FILM_NETWORK_ISOLATION_REQUIRED','runtime','Compose through the installed Walkthrough launcher, which applies the local-only process boundary.'));};
    socket.once('error',done);socket.once('connect',()=>done());socket.setTimeout(1000,()=>done());
  });
}

/** Current installed tools, never executable paths supplied by a retained source. */
export async function filmPreflight(input:{narration:boolean;signal?:AbortSignal}){
  const paths=runtimePaths(),checks:Array<{name:string;ok:boolean;code?:string;detail?:unknown}>=[];
  const check=async(name:string,body:()=>Promise<unknown>)=>{input.signal?.throwIfAborted();try{checks.push({name,ok:true,detail:await body()});}catch(error){checks.push({name,ok:false,code:error instanceof Failure?error.code:'DEPENDENCY_UNAVAILABLE'});}};
  await check('network',async()=>{await assertCompositionNetworkIsolation();return 'external-network-denied';});
  await check('node',async()=>{if(!qualifiedNode(process.version))throw Error();return process.version;});
  await check('tools',async()=>{
    const version=(path:string,args:string[])=>execFileSync(path,args,{encoding:'utf8',timeout:10000,env:localEnvironment(),stdio:['ignore','pipe','pipe']}).split('\n')[0];
    const node=version(localTools.nodePath,['--version']),browser=version(localTools.browserPath,['--version']);
    if(!qualifiedNode(node)||!qualifiedBrowserVersion(browser))throw Error();
    return {node,browser,ffmpeg:version(localTools.ffmpegPath,['-version']),ffprobe:version(localTools.ffprobePath,['-version'])};
  });
  await check('renderer',async()=>{
    const pins:Record<string,string>={'remotion':'4.0.538','@remotion/bundler':'4.0.538','@remotion/renderer':'4.0.538','react':'19.3.1','react-dom':'19.3.1','playwright':'1.64.1'};
    for(const [name,version] of Object.entries(pins))if(JSON.parse(await readFile(join(paths.runtimeRoot,'node_modules',name,'package.json'),'utf8')).version!==version)throw Error();
    return {pins,custody:await verifyBrowserCustodyPatch(),frameTransport:await verifyFrameTransportPatch(),memoryAdmission:await verifyStreamingEncodingStrategy()};
  });
  await check('license',verifyLicense);
  if(input.narration)await check('audio',async()=>{
    const provision=await readAudioProvision(paths.audioProvisionPath);
    if(provision.cacheDirectory!==paths.audioCacheDirectory)throw new Failure('AUDIO_PROVISION_LOCATION_OR_VOICE','audio','Select the reviewed provision using the installed state audio cache.');
    const result=await inspectAudioReadiness(paths.audioProvisionPath,{signal:input.signal});if(result.status!=='provisioned')throw new Failure('AUDIO_NOT_READY','audio','Review the selected installed audio provision against the current Voices runtime.');return result;
  });
  return {schemaVersion:1,status:checks.every(check=>check.ok)?'provisioned' as const:'not-ready' as const,tools:localTools,checks,appAccess:false,downloads:false};
}

/** Works in an extracted release without Git, and detects mixed program bytes. */
async function filmRuntimeIdentity(){
  const {runtimeRoot}=runtimePaths(),files:Record<string,string>={};
  const visit=async(relative:string):Promise<void>=>{
    const path=join(runtimeRoot,relative),info=await lstat(path);
    if(info.isSymbolicLink())throw new Failure('FILM_RUNTIME_REDIRECT','runtime','Use the immutable installed runtime, without redirected program files.');
    if(info.isDirectory()){for(const name of (await readdir(path)).sort())if(name!=='__pycache__')await visit(`${relative}/${name}`);}
    else if(info.isFile())files[relative]=await fileDigest(path);
  };
  for(const path of ['bin','src','package.json','package-lock.json','scripts/loopback-only.sb'])await visit(path);
  let releaseSha256:string|null=null;
  try{releaseSha256=await fileDigest(join(runtimeRoot,'release.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return {kind:releaseSha256?'installed-release' as const:'development-source' as const,releaseSha256,digest:sha256(JSON.stringify({releaseSha256,files})),files};
}

const dependencies={loadSourceSet,readProject,createCompositionDirectory,filmPreflight,filmRuntimeIdentity,readAudioProvision,inspectRetainedNarration,synthesizeNarration,renderWalkthrough,qualifyTemporalVideo,fileDigest};
const transcriptionObservations=(audio:Pick<NarrationResult,'beats'>)=>audio.beats.map(beat=>({phraseId:beat.id,status:beat.transcription?.comparison.status??'not-recorded',differenceCount:beat.transcription?.comparison.differences.length??null,diagnosticPath:beat.transcription?.manifestPath??null}));

/** Finishing failures identify their retained evidence, not a fresh application
 * occurrence or an instruction to synthesize unchanged speech again. */
async function filmFailure(error:unknown,input:{directory:string;kind:'composition'|'preview';stage:string;aborted?:boolean}):Promise<FilmFailure>{
  if(error instanceof Failure)return {code:error.code,owner:error.owner,recovery:error.recovery,...(error instanceof FilmCaptionFailure?{caption:error.caption}:{}),...(error instanceof FilmEditFailure?{location:error.location}:{})};
  if(error instanceof LocalProcessFailure){
    // Preserve the primary streaming refusal even when native browser cleanup
    // supplies the process's later Target closed rejection. Only this owned log
    // can carry it; cancellation/timeout and other child logs keep their causes.
    if(!input.aborted&&error.code==='render:local_process_failed'&&error.diagnosticPath===join(input.directory,'render','renderer.log')){
      const refusal=await readStreamingEncodingRefusal(error.diagnosticPath).catch(()=>undefined);
      if(refusal){
        const next=refusal.memoryAdmission?.sampleValid===false?'The native available-memory sample was invalid; verify the selected qualified Node runtime before another offline attempt.':'If memory admission was insufficient, retry only when sufficient available memory is observed. Otherwise inspect the native encoder conditions.';
        return {code:'FILM_RENDER_STREAMING_ENCODING_REQUIRED',owner:'render',...refusal,diagnosticPath:error.diagnosticPath,
          ...(error.child?{child:error.child}:{}),recovery:'Inspect the retained streaming admission and renderer log. The native encoder was refused before picture rendering; no all-frame PNG fallback was used. '+next+' Reuse sealed sources and audio; do not repeat application work.'+(input.kind==='preview'?' The previous successful preview remains current.':'')};
      }
    }
    const codes:Record<LocalProcessFailure['code'],string>={
      'render:local_process_launch_failed':'FILM_RENDER_PROCESS_LAUNCH_FAILED',
      'render:local_process_timeout':'FILM_RENDER_PROCESS_TIMEOUT',
      'render:local_process_failed':'FILM_RENDER_PROCESS_FAILED',
      'render:cancelled':'FILM_ABORTED',
    };
    return {code:input.aborted?'FILM_ABORTED':codes[error.code],owner:'render',causeCode:error.code,diagnosticPath:error.diagnosticPath,
      ...(error.child?{child:error.child}:{}),recovery:'Inspect the retained child log before another offline attempt using the sealed sources. Do not repeat application work.'+(input.kind==='preview'?' The previous successful preview remains current.':'')};
  }
  const causeCode=error instanceof Error?error.message:'';
  const finishing:Record<string,{code:string;diagnostics:string[];recovery:string}>={
    'render:audio_loudness_unmeasurable':{code:'FILM_AUDIO_LOUDNESS_UNMEASURABLE',diagnostics:['finish-loudness-delivery.log','finish.log','finish-loudness-input.log'],recovery:'Inspect the retained loudness diagnostic. Integrated loudness could not be measured for the rendered audio; establish whether narration is audible in this range before another offline render. Do not repeat application work.'},
    'render:delivery_audio_loudness_nonconformant':{code:'FILM_DELIVERY_AUDIO_LOUDNESS_NONCONFORMANT',diagnostics:['media-metrics.json'],recovery:'Inspect audioLoudness in the retained media metrics: the encoded delivery missed the loudness or true-peak limit. Repair offline finishing against the retained audio and sealed sources; do not resynthesize unchanged speech or repeat application work.'},
    'render:delivery_audio_timing_nonconformant':{code:'FILM_DELIVERY_AUDIO_TIMING_NONCONFORMANT',diagnostics:['media-metrics.json'],recovery:'Inspect audioTiming in the retained media metrics: audio start or duration changed beyond the allowed tolerance. Repair offline finishing before treating this delivery as ready; preserve the edit, measured speech and sealed sources.'},
  };
  const known=Object.hasOwn(finishing,causeCode)?finishing[causeCode]:undefined;
  if(known){
    let diagnosticPath=join(input.directory,'render');
    for(const name of known.diagnostics){
      const path=join(diagnosticPath,name);
      try{const info=await lstat(path);if(info.isFile()&&!info.isSymbolicLink()&&await realpath(path)===path){diagnosticPath=path;break;}}catch{/* Report the retained render directory if the particular diagnostic is unavailable. */}
    }
    return {code:known.code,owner:'render',causeCode,diagnosticPath,recovery:known.recovery};
  }
  return {code:input.aborted?'FILM_ABORTED':/^(?:AUDIO_|FILM_)[A-Z0-9_]+$/.test(causeCode)?causeCode:input.kind==='preview'?'FILM_PREVIEW_FAILED':'FILM_COMPOSITION_FAILED',owner:input.stage,recovery:input.kind==='preview'?'Inspect this retained preview attempt. The previous successful preview remains current; repair from sealed sources without opening the app.':'Inspect this retained composition occurrence. Revise against its existing source set; do not repeat application work.'};
}

export async function validateFilm(input:{projectPath:string;edit:unknown}){
  const edit=validateFilmEdit(input.edit),retained=await loadSourceSet(input.projectPath,edit.sourceSetId);
  if(retained.sha256!==edit.sourceSetSha256)throw new Failure('FILM_SOURCE_DIGEST_MISMATCH','film-edit','Author the edit against this exact sealed source-set digest.');
  return {schemaVersion:1,valid:true,sourceSetId:retained.sourceSet.id,sourceSetSha256:retained.sha256,...validateFilmSources(edit,retained.sourceSet),objectiveErrors:[],editorialObservations:filmEditorialObservations(edit,retained.sourceSet),appAccess:false,synthesis:false,render:false};
}

async function retainedAudioDirectory(projectPath:string,compositionId?:string){
  if(!compositionId)return undefined;
  const directory=join(projectPath,'compositions',checkedId(compositionId)),audio=join(directory,'audio');
  for(const path of [join(projectPath,'compositions'),directory,audio]){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw new Failure('FILM_REUSE_AUDIO_UNSAFE','audio','Choose retained audio in this project’s exact composition directory.');}
  const manifestPath=join(directory,'composition.json'),info=await lstat(manifestPath);
  if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024||await realpath(manifestPath)!==manifestPath)throw new Failure('FILM_REUSE_AUDIO_UNSAFE','audio','Use the retained literal composition manifest, not a redirected file.');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  if(manifest.kind!=='composition'||manifest.id!==compositionId||manifest.projectPath!==projectPath)throw new Failure('FILM_REUSE_AUDIO_IDENTITY','audio','Choose this project’s retained composition ID.');
  return audio;
}

/** Inspect retained measurements only. Never reads sources, WAVs, model caches
 * or the live provision, and never infers that a rejected edit has been repaired. */
export async function inspectNarrationFit(compositionDirectory:string,options:{limit?:number;offset?:number;conflictsOnly?:boolean}={}){
  const limit=options.limit??20,offset=options.offset??0;
  pageItems([],limit,offset);
  const diagnosticPath=join(compositionDirectory,'narration-fit.json'),maximumBytes=16*1024*1024;
  let state:'recorded'|'not-recorded'|'invalid'|'unsafe'|'unreadable'='not-recorded',fit:FilmNarrationFit|null=null,handle;
  try{
    const directory=await lstat(compositionDirectory);
    if(!directory.isDirectory()||directory.isSymbolicLink()||await realpath(compositionDirectory)!==compositionDirectory)state='unsafe';
    else{
      handle=await open(diagnosticPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const info=await handle.stat();
      if(!info.isFile())state='unsafe';
      else if(info.size>maximumBytes)state='invalid';
      else{
        const bytes=Buffer.alloc(Math.min(info.size,maximumBytes)+1),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
        // A foreign append cannot turn the stat into an unbounded read.
        fit=bytesRead===info.size?projectFilmNarrationFit(JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'))):null;
        state=fit?'recorded':'invalid';
      }
    }
  }catch(error){state=error instanceof SyntaxError?'invalid':(error as NodeJS.ErrnoException).code==='ENOENT'?'not-recorded':(error as NodeJS.ErrnoException).code==='ELOOP'?'unsafe':'unreadable';}
  finally{await handle?.close();}
  const record=fit?(()=>{
    const {phrases,...summary}=fit;
    return {...summary,selection:options.conflictsOnly?'conflicts' as const:'all' as const,phrases:pageItems(options.conflictsOnly?phrases.filter(narrationPhraseConflicts):phrases,limit,offset)};
  })():null;
  return {state,statusBasis:'retained-narration-fit' as const,diagnosticPath,record};
}

/** Offline film production. The only picture inputs are verified retained bytes. */
export async function composeFilm(input:{projectPath:string;edit:unknown;reuseAudio?:string;signal?:AbortSignal},deps=dependencies){
  const edit=validateFilmEdit(input.edit),projectPath=await projectDirectory(input.projectPath),paths=runtimePaths();
  await deps.readProject(projectPath);
  const retained=await deps.loadSourceSet(projectPath,edit.sourceSetId);
  if(retained.sha256!==edit.sourceSetSha256)throw new Failure('FILM_SOURCE_DIGEST_MISMATCH','film-edit','Author the edit against this exact sealed source-set digest.');
  validateFilmSources(edit,retained.sourceSet);
  const reuseAudioDirectory=await retainedAudioDirectory(projectPath,input.reuseAudio);
  const occurrence=await deps.createCompositionDirectory(projectPath),{directory}=occurrence;
  const createdAt=new Date().toISOString();
  const manifest:FilmComposition={schemaVersion:1,kind:'composition',id:occurrence.id,projectPath,createdAt,updatedAt:createdAt,status:'running',stage:'preflight',sourceSet:{id:edit.sourceSetId,sha256:retained.sha256},paths:{},proof:{human:{watchedComplete:false,listenedComplete:false,comprehension:null}}};
  const save=async(stage?:string)=>{if(stage)manifest.stage=stage;manifest.updatedAt=new Date().toISOString();await saveJson(join(directory,'composition.json'),manifest);};
  await save();
  try{
    input.signal?.throwIfAborted();
    await saveJson(join(directory,'film-edit.json'),edit,true);
    const reuse=edit.narration.length&&reuseAudioDirectory?await deps.inspectRetainedNarration({directory:reuseAudioDirectory,beats:edit.narration,voiceId:edit.voiceId,language:edit.language??'English'}):undefined;
    const preflight=await deps.filmPreflight({narration:edit.narration.length>0&&!reuse?.complete,signal:input.signal});await saveJson(join(directory,'preflight.json'),preflight,true);
    if(preflight.status!=='provisioned')throw new Failure('FILM_PREFLIGHT_NOT_READY','runtime','Review preflight.json and provision the reported installed dependency. No application action or download was attempted.');
    const runtime=await deps.filmRuntimeIdentity();
    let audio:Pick<NarrationResult,'beats'>={beats:[]};let audioIdentity:Record<string,unknown>={voiceId:edit.voiceId,phrases:[]};let provisionDigest:string|undefined;
    if(edit.narration.length){
      const provision=reuse?.complete?reuse.provision:await deps.readAudioProvision(paths.audioProvisionPath);
      if(!reuse?.complete){provisionDigest=await deps.fileDigest(paths.audioProvisionPath);resolveProvisionVoice(provision,edit.voiceId);}
      await save('narration');
      audio=await deps.synthesizeNarration({runDirectory:directory,beats:edit.narration.map(({id,text})=>({id,text})),voiceId:edit.voiceId,language:edit.language??'English',reuseAudioDirectory,provisionManifestPath:paths.audioProvisionPath,signal:input.signal});
      audioIdentity={voiceId:edit.voiceId,language:edit.language??'English',reuseCompositionId:input.reuseAudio??null,mode:reuse?.complete?'retained-only':'provisioned-processing',provisionSha256:reuse?.complete?await deps.fileDigest(reuse.provisionPath):provisionDigest,runtime:provision.runtime,phrases:audio.beats.map(phrase=>({id:phrase.id,text:phrase.text,wavSha256:phrase.wavSha256,cacheHit:phrase.cacheHit}))};
      await save('narration-fit');
      const {phrases,...summary}=measureFilmNarrationFit(edit,audio,retained.sourceSet),diagnosticPath=join(directory,'narration-fit.json');
      await saveJson(diagnosticPath,{...summary,phrases},true);
      manifest.narrationFit={...summary,diagnosticPath};manifest.paths['narration-fit.json']=diagnosticPath;
    }
    const timeline=buildFilmTimeline(edit,audio,retained.sourceSet);await saveJson(join(directory,'edit-plan.json'),{edit,timeline},true);
    await saveJson(join(directory,'editorial-observations.json'),{objectiveErrors:[],editorialObservations:filmEditorialObservations(edit,retained.sourceSet,audio)},true);
    manifest.paths['editorial-observations.json']=join(directory,'editorial-observations.json');
    await save('rendering');
    const rendered=await deps.renderWalkthrough({timeline,sourcePaths:retained.sourcePaths,directory:join(directory,'render'),browserPath:preflight.tools.browserPath,ffmpegPath:preflight.tools.ffmpegPath,ffprobePath:preflight.tools.ffprobePath,signal:input.signal});
    await save('temporal-qa');
    const temporal=await deps.qualifyTemporalVideo({finalMP4:rendered.videoPath,sourceMP4s:retained.sourcePaths,timeline,presentation:'full-frame-visible-captions',ffmpegPath:preflight.tools.ffmpegPath,ffprobePath:preflight.tools.ffprobePath,directory:join(directory,'temporal-qa'),signal:input.signal});
    manifest.proof.frozenCamera=temporal.frozenCamera;
    if(temporal.frozenCamera.status==='fail')throw new Failure('FILM_FROZEN_LIVE_OUTPUT','render','Repair this composition against the retained source set. No app action or reacquisition is needed.');
    await save('bundling');
    const narration=edit.narration.map(phrase=>phrase.text).join('\n\n'),captionsVtt=filmTimelineVtt(timeline);
    await writeFile(join(directory,'captions.vtt'),captionsVtt,{flag:'wx',mode:0o600});
    await writeFile(join(directory,'narration.txt'),narration+(narration?'\n':''),{flag:'wx',mode:0o600});
    for(const [source,name] of [[rendered.videoPath,'walkthrough.mp4'],[rendered.posterPath,'poster.png']]){await copyFile(source,join(directory,name),constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);await chmod(join(directory,name),0o600);}
    const deliverables:DeliveredArtifact[]=[];
    for(const artifact of retained.sourceSet.artifacts.filter(artifact=>artifact.role==='deliverable')){
      const relativePath=`deliverables/${artifact.id}`,delivered:DeliveredArtifact={name:artifact.id,title:artifact.title,filename:artifact.filename,mediaType:artifact.mediaType,role:'deliverable',relativePath,sha256:artifact.sha256,bytes:artifact.bytes};
      if(!validDeliveredArtifact(delivered))throw new Failure('FILM_INVALID_DELIVERABLE','bundle','Restore valid retained artifact metadata.');
      if(!deliverables.length)await mkdir(join(directory,'deliverables'),{mode:0o700});
      const destination=join(directory,relativePath);await copyFile(retained.artifactPaths[artifact.id],destination,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);await chmod(destination,0o600);
      if((await stat(destination)).size!==artifact.bytes||await deps.fileDigest(destination)!==artifact.sha256)throw new Failure('FILM_DELIVERABLE_CHANGED','bundle','Restore the exact retained deliverable bytes.');deliverables.push(delivered);
    }
    await saveJson(join(directory,'deliverables.json'),{schemaVersion:1,artifacts:deliverables},true);
    await writeFile(join(directory,'review.html'),createReviewPage({presentation:'full-frame-visible-captions',runId:manifest.id,title:edit.title,goal:edit.brief,narration,captionsVtt,deliverables}),{flag:'wx',mode:0o600});
    manifest.proof.transcription=transcriptionObservations(audio);
    await saveJson(join(directory,'qa.json'),{automated:{videoConformance:true,frozenCamera:temporal.frozenCamera.status},temporal,audio:{unresolvedWordTimings:audio.beats.reduce((count,beat)=>count+beat.unresolvedWordCount,0),transcription:manifest.proof.transcription,spokenContentVerified:false},human:manifest.proof.human,limits:['Automated checks do not establish readable product text, natural speech, smooth motion or viewer comprehension.','ASR comparison is an independent observation, not proof of correct speech or authority to rewrite it.','Not-assessed motion is not a motion-quality pass.']},true);
    const current=await deps.loadSourceSet(projectPath,edit.sourceSetId);
    if(current.sha256!==retained.sha256)throw new Failure('FILM_SOURCE_CHANGED','sources','Restore the exact sealed source set before another composition.');
    if(provisionDigest&&await deps.fileDigest(paths.audioProvisionPath)!==provisionDigest)throw new Failure('FILM_AUDIO_PROVISION_CHANGED','audio','Retain this occurrence and compose using one reviewed audio provision.');
    if((await deps.filmRuntimeIdentity()).digest!==runtime.digest)throw new Failure('FILM_RUNTIME_CHANGED','runtime','Retain this occurrence and compose from one coherent installed runtime.');
    await saveJson(join(directory,'provenance.json'),{schemaVersion:1,kind:'composition',runtime,sourceSet:{id:edit.sourceSetId,sha256:retained.sha256},editSha256:await deps.fileDigest(join(directory,'film-edit.json')),audio:audioIdentity,renderer:'Remotion 4.0.538',appAccess:false,automaticReplay:false},true);
    const names:string[]=[...bundleFiles,'deliverables.json',...deliverables.map(artifact=>artifact.relativePath)];
    await saveJson(join(directory,'checksums.json'),Object.fromEntries(await Promise.all(names.map(async name=>[name,await deps.fileDigest(join(directory,name))]))),true);
    for(const name of [...names,'checksums.json','film-edit.json'])manifest.paths[name]=join(directory,name);
    manifest.proof.media={width:1920,height:1080,fps:60,frames:rendered.metrics.expectedFrames,durationSeconds:rendered.metrics.expectedFrames/60};
    manifest.status='awaiting-human-review';await save('complete-bundle-awaiting-review');
  }catch(error){
    manifest.status='failed';
    if(error instanceof FilmCaptionFailure)manifest.stage='film-edit';
    manifest.error=await filmFailure(error,{directory,kind:'composition',stage:manifest.stage,aborted:input.signal?.aborted});
    await save();
  }
  // Delivery is already complete. A storage problem must never relabel it failed.
  if(manifest.status==='awaiting-human-review')try{
    manifest.storage=await compactFilmComposition({projectPath,compositionId:manifest.id});
  }catch(error){
    manifest.storage=retainedCompositionStorage(error);
    try{await save();}catch{/* Keep the useful delivery and return the storage error. */}
  }
  const narrationFitDiagnostics=manifest.narrationFit?.status==='rejected'?await inspectNarrationFit(directory,{conflictsOnly:true}):undefined;
  return {...manifest,statusBasis:'recorded-lifecycle' as const,...(narrationFitDiagnostics?{narrationFitDiagnostics}:{}),bundle:await observeBundle(directory,manifest.status)};
}

/** A replaceable local viewing sample, never a permanent composition attempt.
 * The full picture clock reaches Remotion unchanged. Every phrase beginning
 * before `to` is measured: an unknown earlier duration might overlap `from`.
 */
export async function previewFilm(input:{projectPath:string;edit:unknown;from:number;to:number;reuseAudio?:string;signal?:AbortSignal},deps=dependencies){
  const edit=validateFilmEdit(input.edit),projectPath=await projectDirectory(input.projectPath),paths=runtimePaths();
  await deps.readProject(projectPath);const retained=await deps.loadSourceSet(projectPath,edit.sourceSetId);
  if(retained.sha256!==edit.sourceSetSha256)throw new Failure('FILM_SOURCE_DIGEST_MISMATCH','film-edit','Author the edit against this exact sealed source-set digest.');
  const validated=validateFilmSources(edit,retained.sourceSet),frameRange=previewFrameRange(input.from,input.to,validated.durationSeconds);
  const reuseAudioDirectory=await retainedAudioDirectory(projectPath,input.reuseAudio),attempt=await beginPreview(projectPath),{directory,id}=attempt;
  const selected={...edit,narration:edit.narration.filter(phrase=>phrase.outputStartSeconds<input.to)};
  const manifest:any={schemaVersion:1,kind:'preview',id,projectPath,status:'running',stage:'preflight',sourceSet:{id:edit.sourceSetId,sha256:retained.sha256},range:{fromSeconds:input.from,toSeconds:input.to,frameRange,fps:60},appAccess:false,createdAt:new Date().toISOString(),objectiveErrors:[],editorialObservations:[]};
  const save=async(stage?:string)=>{if(stage)manifest.stage=stage;await saveJson(join(directory,'preview.json'),manifest);};
  try{
    await save();
    input.signal?.throwIfAborted();await saveJson(join(directory,'film-edit.json'),edit,true);
    const reuse=selected.narration.length&&reuseAudioDirectory?await deps.inspectRetainedNarration({directory:reuseAudioDirectory,beats:selected.narration,voiceId:edit.voiceId,language:edit.language??'English'}):undefined;
    const preflight=await deps.filmPreflight({narration:selected.narration.length>0&&!reuse?.complete,signal:input.signal});await saveJson(join(directory,'preflight.json'),preflight,true);
    if(preflight.status!=='provisioned')throw new Failure('FILM_PREFLIGHT_NOT_READY','runtime','Review this preview’s preflight.json; no application was opened.');
    const runtime=await deps.filmRuntimeIdentity();let provisionDigest:string|undefined;
    let audio:Pick<NarrationResult,'beats'>={beats:[]};
    if(selected.narration.length){
      if(!reuse?.complete){const provision=await deps.readAudioProvision(paths.audioProvisionPath);resolveProvisionVoice(provision,edit.voiceId);provisionDigest=await deps.fileDigest(paths.audioProvisionPath);}
      await save('narration');audio=await deps.synthesizeNarration({runDirectory:directory,beats:selected.narration.map(({id,text})=>({id,text})),voiceId:edit.voiceId,language:edit.language??'English',reuseAudioDirectory,provisionManifestPath:paths.audioProvisionPath,signal:input.signal});
      await save('narration-fit');
      const {phrases,...summary}=measureFilmNarrationFit(selected,audio,retained.sourceSet),diagnosticPath=join(directory,'narration-fit.json');
      await saveJson(diagnosticPath,{...summary,phrases},true);
      manifest.narrationFit={...summary,diagnosticPath};
    }
    const timeline=buildFilmTimeline(selected,audio,retained.sourceSet);
    manifest.transcription=transcriptionObservations(audio);
    // Keep the full edit's narration occupancy. Phrases starting after this
    // preview were intentionally not measured, not removed from the film.
    manifest.editorialObservations=filmEditorialObservations(edit,retained.sourceSet,audio).filter(item=>item.outputStartSeconds<input.to&&item.outputEndSeconds>input.from);
    await saveJson(join(directory,'edit-plan.json'),{edit,timeline,frameRange,measuredPhraseIds:selected.narration.map(phrase=>phrase.id)},true);
    await save('rendering');
    const rendered=await deps.renderWalkthrough({timeline,frameRange,sourcePaths:retained.sourcePaths,directory:join(directory,'render'),browserPath:preflight.tools.browserPath,ffmpegPath:preflight.tools.ffmpegPath,ffprobePath:preflight.tools.ffprobePath,signal:input.signal});
    if(rendered.metrics.expectedFrames!==frameRange[1]-frameRange[0]+1)throw new Failure('FILM_PREVIEW_FRAME_COUNT','render','Retain this diagnostic: the renderer did not return the exact requested preview range.');
    manifest.audioLoudness=rendered.metrics.audioLoudness;
    manifest.limits=['A preview is an unmastered editorial sample without loudness normalization, not full-film acceptance. Final composition retains its delivery loudness and timing checks.'];
    if((await deps.loadSourceSet(projectPath,edit.sourceSetId)).sha256!==retained.sha256)throw new Failure('FILM_SOURCE_CHANGED','sources','Restore the exact sealed source set; do not repeat application work.');
    if(provisionDigest&&await deps.fileDigest(paths.audioProvisionPath)!==provisionDigest)throw new Failure('FILM_AUDIO_PROVISION_CHANGED','audio','Use one coherent provision for this preview.');
    if((await deps.filmRuntimeIdentity()).digest!==runtime.digest)throw new Failure('FILM_RUNTIME_CHANGED','runtime','Use one coherent runtime for this preview.');
    await copyFile(rendered.videoPath,join(directory,'preview.mp4'),constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);await chmod(join(directory,'preview.mp4'),0o600);
    await saveJson(join(directory,'provenance.json'),{schemaVersion:1,kind:'preview',runtime,sourceSet:manifest.sourceSet,editSha256:await deps.fileDigest(join(directory,'film-edit.json')),frameRange,absoluteCompositionClock:true,reuseCompositionId:input.reuseAudio??null,voiceId:edit.voiceId,language:edit.language??'English',measuredPhraseIds:selected.narration.map(phrase=>phrase.id),appAccess:false},true);
    manifest.videoPath=join(directory,'preview.mp4');manifest.videoSha256=await deps.fileDigest(manifest.videoPath);manifest.status='ready';
    await compactPreviewScratch(directory);await save('complete-preview-awaiting-review');
    const publication=await publishPreview(projectPath,id);
    return {...manifest,statusBasis:'recorded-lifecycle',publication};
  }catch(error){
    manifest.status='failed';manifest.error=await filmFailure(error,{directory,kind:'preview',stage:manifest.stage,aborted:input.signal?.aborted});
    if(manifest.error.owner==='film-edit')manifest.objectiveErrors=[manifest.error];
    await save();
    const narrationFitDiagnostics=manifest.narrationFit?.status==='rejected'?await inspectNarrationFit(directory,{conflictsOnly:true}):undefined;
    return {...manifest,statusBasis:'recorded-lifecycle',diagnosticPath:join(directory,'preview.json'),...(narrationFitDiagnostics?{narrationFitDiagnostics}:{})};
  }finally{await attempt.release();}
}

/** Recorded editorial observations are nonblocking and distinct from errors. */
export async function inspectFilmEditorial(directory:string,manifest:{error?:unknown},options:{limit?:number;offset?:number}={}){
  let observations:unknown[]=[];
  try{const path=join(directory,'editorial-observations.json'),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>16*1024*1024||await realpath(path)!==path)throw new Failure('FILM_EDITORIAL_DIAGNOSTIC_UNSAFE','film-edit','Inspect the retained editorial diagnostic without following redirects.');const value=JSON.parse(await readFile(path,'utf8'));if(Array.isArray(value.editorialObservations))observations=value.editorialObservations;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return {objectiveErrors:manifest.error?[manifest.error]:[],editorialObservations:pageItems(observations,options.limit??20,options.offset??0),statusBasis:'retained-editorial-diagnostics'};
}
