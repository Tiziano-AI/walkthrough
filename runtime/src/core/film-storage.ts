import {constants,type Stats} from 'node:fs';
import {createHash} from 'node:crypto';
import {lstat,open,readdir,realpath,rmdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {Failure} from './contracts.ts';
import {observeBundle} from './bundle.ts';
import {buildFilmTimeline,validateFilmEdit,validateFilmSources,previewFrameRange,type FilmEdit} from './film-edit.ts';
import {checkedId,loadSourceSet,projectDirectory,readProject,saveJson} from '../project/store.ts';
import type {SourceSet} from '../project/contracts.ts';
import {stableJson,audioLanguage,validateAudioProvision,resolveProvisionVoice,synthesisIdentity,alignmentIdentity,transcriptionIdentity} from '../audio/provision.ts';
import {inspectRetainedNarration} from '../audio/retained.ts';
import {runtimePaths} from './runtime-paths.ts';
import {checkedPreviewId,previewOwnership} from './film-preview-storage.ts';

export interface CompositionStorage {
  status:'compacted'|'already-compact'|'retained'|'partial';
  removedFiles:number;
  /** Sum of removed regular-file sizes, not physical/APFS space reclaimed. */
  removedLogicalBytes:number;
  error?:{code:string;owner:string;recovery:string};
}
const failure=(code:string,recovery:string)=>new Failure(code,'storage',recovery);
const unsafe=()=>failure('FILM_COMPACT_UNSAFE_PATH','Keep this occurrence intact and inspect its unexpected or redirected scratch path. Only known regular generated files can be compacted.');
const missing=(error:unknown)=>(error as NodeJS.ErrnoException).code==='ENOENT';

async function literalDirectory(path:string,optional=false){
  let info:Stats;try{info=await lstat(path);}catch(error){if(optional&&missing(error))return false;throw error;}
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw unsafe();return true;
}
async function regular(path:string){
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||await realpath(path)!==path)throw unsafe();return info;
}
async function json(path:string){
  await regular(path);const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{if(!(await handle.stat()).isFile()||(await handle.stat()).size>16*1024*1024)throw unsafe();return JSON.parse(await handle.readFile('utf8'));}finally{await handle.close();}
}
async function digest(path:string){
  await regular(path);const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);return hash.digest('hex');}finally{await handle.close();}
}
export function retainedCompositionStorage(error:unknown):CompositionStorage{
  return {status:'retained',removedFiles:0,removedLogicalBytes:0,error:error instanceof Failure?{code:error.code,owner:error.owner,recovery:error.recovery}:{code:'FILM_COMPACT_FAILED',owner:'storage',recovery:'Inspect this occurrence and retry project compact with its exact identity; do not reopen the application. Original inputs and any delivered film remain retained.'}};
}

/** A failed coordinator can leave a renderer alive. Observe its existing custody
 * records; compaction never signals processes or retires their markers. */
async function assertFailedRenderIdle(projectPath:string){
  const blocked=()=>failure('FILM_COMPACT_ACTIVE_WORK','Let this project’s commands settle and close or recover its browser session before compacting failed render scratch. No activity record was changed.');
  const {activeRoot}=runtimePaths();
  if(!await literalDirectory(activeRoot,true))return;
  for(const name of await readdir(activeRoot)){
    let record:any;try{record=await json(join(activeRoot,name));}catch(error){if(missing(error))continue;throw blocked();}
    if(record.schemaVersion!==1||!['command','session'].includes(record.kind)||!Number.isInteger(record.pid)||record.pid<1)throw blocked();
    if(typeof record.projectPath==='string'&&record.projectPath!==projectPath)continue;
    const ids=[record.pid,...(record.coordinatorPid===undefined?[]:[record.coordinatorPid])],groups=record.processGroupIds??[];
    if(!Array.isArray(groups)||[...ids,...groups].some(pid=>!Number.isInteger(pid)||pid<1))throw blocked();
    if(record.kind==='command'&&record.projectPath===projectPath&&record.pid===process.ppid&&record.coordinatorPid===process.pid&&Array.isArray(record.processGroupIds)&&!groups.length&&record.status==='running')continue;
    if(record.kind==='session'&&record.status!=='closed')throw blocked();
    for(const pid of [...ids,...groups.map((pid:number)=>-pid)]){
      try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')continue;throw blocked();}
      throw blocked();
    }
  }
}

/** The staged WAVs are disposable only while the occurrence still owns the
 * original speech and its reusable timing/provenance. Never consult cache paths
 * or follow the locators inside audio metadata: derive every file from edit IDs.
 */
async function verifyRetainedNarration(directory:string,edit:FilmEdit,provenance:any,plan:any,sourceSet:SourceSet){
  if(!edit.narration.length)return;
  const invalid=()=>failure('FILM_COMPACT_AUDIO_UNVERIFIED','Restore this occurrence’s exact retained narration WAVs, alignment, synthesis and provision metadata before compacting. All render scratch remains available.');
  try{
    const audioDirectory=join(directory,'audio');await literalDirectory(audioDirectory);
    const narration=await json(join(audioDirectory,'narration.json')),provision=validateAudioProvision(await json(join(audioDirectory,'provision.json')));
    const language=audioLanguage(edit.language),voice=resolveProvisionVoice(provision,edit.voiceId);
    const audio=provenance?.audio,provisionHash=await digest(join(audioDirectory,'provision.json'));
    if(narration.schemaVersion!==1||narration.voiceId!==edit.voiceId||narration.language!==language||narration.spokenContentVerified!==false||narration.humanListeningRequired!==true
      ||narration.manifestPath!==join(audioDirectory,'narration.json')||narration.provisionManifestPath!==join(audioDirectory,'provision.json')
      ||narration.provisionManifestSha256!==provisionHash||stableJson(narration.runtime)!==stableJson(provision.runtime)
      ||!Array.isArray(narration.beats)||narration.beats.length!==edit.narration.length)throw invalid();
    // A retained-only revision has no new aggregate generation owner. The
    // shared offline verifier checks each original receipt and measured WAV;
    // its per-phrase identities remain authoritative across runtime revisions.
    if(narration.reuseOnly!==true&&(narration.synthesisIdentity!==synthesisIdentity(provision,language,edit.voiceId)||narration.alignmentIdentity!==alignmentIdentity(provision,language)
      ||provision.schemaVersion===3&&narration.transcriptionIdentity!==transcriptionIdentity(provision,language)))throw invalid();
    const retained=await inspectRetainedNarration({directory:audioDirectory,beats:edit.narration,voiceId:edit.voiceId,language,match:'id-and-text'});
    if(!retained.complete)throw invalid();
    // Final provenance is written only after rendering and QA succeed. A failed
    // occurrence verifies the original audio receipts instead, without inventing
    // a final delivery record or weakening the completed-bundle cross-checks.
    if(provenance&&(audio?.voiceId!==edit.voiceId||audioLanguage(audio.language)!==language||audio.provisionSha256!==provisionHash
      ||stableJson(narration.runtime)!==stableJson(audio.runtime)||!Array.isArray(audio.phrases)||audio.phrases.length!==edit.narration.length))throw invalid();
    for(const [index,phrase] of edit.narration.entries()){
      const phraseDirectory=join(audioDirectory,phrase.id);await literalDirectory(phraseDirectory);
      const wavPath=join(phraseDirectory,'narration.wav'),beat=narration.beats[index],verified=retained.beats[index].beat,recorded=audio?.phrases?.[index];
      if(beat?.id!==phrase.id||beat.text!==phrase.text||beat.wavPath!==wavPath||!/^[a-f0-9]{64}$/.test(beat.wavSha256)||await digest(wavPath)!==beat.wavSha256)throw invalid();
      if(provenance&&(recorded?.id!==phrase.id||recorded.text!==phrase.text||beat.wavSha256!==recorded.wavSha256||beat.cacheHit!==recorded.cacheHit))throw invalid();
      const alignment=await json(join(phraseDirectory,'alignment.json')),synthesis=await json(join(phraseDirectory,'synthesis.json'));
      // Reused WAV/alignment retain the provision that generated each one. The
      // current run's provision may own only independent transcription, not TTS.
      const synthesisProvision=synthesis.generationProvision?validateAudioProvision(synthesis.generationProvision):provision;
      const generatedIdentity=verified.synthesisIdentity,alignedIdentity=verified.alignmentIdentity;
      if(alignment.schemaVersion!==2||alignment.text!==phrase.text||synthesis.text!==phrase.text||alignment.wavSha256!==beat.wavSha256||synthesis.wavSha256!==beat.wavSha256
        ||alignment.identity!==generatedIdentity||synthesis.identity!==generatedIdentity||alignment.alignmentIdentity!==alignedIdentity
        ||(beat.synthesisIdentity??narration.synthesisIdentity)!==generatedIdentity||(beat.alignmentIdentity??narration.alignmentIdentity)!==alignedIdentity
        ||audioLanguage(beat.language??narration.language)!==language||audioLanguage(synthesis.language??synthesis.artifact?.language)!==language||audioLanguage(alignment.language??alignment.provider?.language)!==language
        ||stableJson(resolveProvisionVoice(synthesisProvision,edit.voiceId).files)!==stableJson(voice.files)
        ||alignment.spokenContentVerified!==false||alignment.timingBasis!=='qwen-forced-aligner-estimator-adjusted'||alignment.timingDiagnostics!==null
        ||beat.durationSeconds!==verified.durationSeconds||stableJson(beat.metrics)!==stableJson(verified.metrics)
        ||alignment.metrics?.durationSeconds!==beat.durationSeconds||stableJson(alignment.metrics)!==stableJson(beat.metrics))throw invalid();
      const {words,captions}=verified;
      if(stableJson(words)!==stableJson(alignment.words)||stableJson(words)!==stableJson(beat.words)||stableJson(captions)!==stableJson(alignment.captions)||stableJson(captions)!==stableJson(beat.captions)
        ||beat.unresolvedWordCount!==words.filter(word=>!word.timingResolved).length)throw invalid();
      if(provision.schemaVersion===3||beat.transcription){
        const transcriptionPath=join(phraseDirectory,'transcription.json'),transcription=await json(transcriptionPath),observed=beat.transcription;
        if(!verified.transcription)throw invalid();
        const {identity,comparison}=verified.transcription;
        if(transcription.identity!==identity||transcription.language!==language||transcription.wavSha256!==beat.wavSha256||transcription.transcript!==transcription.provider.transcript
          ||stableJson(transcription.comparison)!==stableJson(comparison)||observed?.identity!==identity||observed.language!==language||observed.transcript!==transcription.transcript
          ||observed.manifestPath!==transcriptionPath||typeof observed.cacheHit!=='boolean'||stableJson(observed.comparison)!==stableJson(comparison)||stableJson(observed.provider)!==stableJson(transcription.provider))throw invalid();
      }
    }
    if(stableJson(buildFilmTimeline(edit,narration,sourceSet))!==stableJson(plan.timeline))throw invalid();
  }catch{throw invalid();}
}

/** Compact one completed or settled failed occurrence, never manifest paths.
 * Sealed originals, narration/cache, edit, delivery and compact diagnostics remain.
 * All candidates are checked before the first unlink. Failed production keeps
 * its diagnostics and sole encoded outputs; its inputs can regenerate scratch.
 */
export async function compactFilmComposition(input:{projectPath:string;compositionId:string}):Promise<CompositionStorage>{
  const projectPath=await projectDirectory(input.projectPath),id=checkedId(input.compositionId);
  await readProject(projectPath);
  await literalDirectory(join(projectPath,'compositions'));
  const directory=join(projectPath,'compositions',id);await literalDirectory(directory);
  const manifestPath=join(directory,'composition.json'),manifest=await json(manifestPath);
  const failed=manifest.status==='failed'&&Boolean(manifest.error);
  if(manifest.schemaVersion!==1||manifest.kind!=='composition'||manifest.id!==id||manifest.projectPath!==projectPath||!failed&&(manifest.status!=='awaiting-human-review'||manifest.stage!=='complete-bundle-awaiting-review'||manifest.error))
    throw failure('FILM_COMPACT_NOT_COMPLETE','Compact a completed composition or a failed occurrence after its processes settle. Running occurrences cannot be compacted.');
  if(failed){
    await assertFailedRenderIdle(projectPath);
    // Failures before rendering have no render intermediates and may not yet
    // have an edit plan or complete narration. Do not manufacture those inputs.
    if(!await literalDirectory(join(directory,'render'),true)&&!await literalDirectory(join(directory,'temporal-qa'),true))return {status:'already-compact',removedFiles:0,removedLogicalBytes:0};
  }else{
    const bundle=await observeBundle(directory,manifest.status);
    if(bundle.availability!=='complete'||bundle.integrity!=='verified')throw failure('FILM_COMPACT_BUNDLE_NOT_VERIFIED','Restore the exact complete delivery before removing its render scratch. No material was removed.');
  }
  const edit=validateFilmEdit(await json(join(directory,'film-edit.json'))),provenance=failed?undefined:await json(join(directory,'provenance.json')),plan=await json(join(directory,'edit-plan.json'));
  if(!failed&&(!provenance||typeof provenance!=='object'||Array.isArray(provenance)))throw failure('FILM_COMPACT_INPUT_MISMATCH','Restore this completed composition’s final provenance before compacting.');
  if(manifest.sourceSet?.id!==edit.sourceSetId||manifest.sourceSet?.sha256!==edit.sourceSetSha256||provenance&&(provenance.sourceSet?.id!==edit.sourceSetId||provenance.sourceSet?.sha256!==edit.sourceSetSha256||provenance.editSha256!==await digest(join(directory,'film-edit.json')))||JSON.stringify(plan.edit)!==JSON.stringify(edit))
    throw failure('FILM_COMPACT_INPUT_MISMATCH','Restore this composition’s exact edit and source-set identity before compacting.');
  const retained=await loadSourceSet(projectPath,edit.sourceSetId);
  if(retained.sha256!==edit.sourceSetSha256)throw failure('FILM_COMPACT_INPUT_MISMATCH','Restore the original sealed source set before removing regenerable scratch.');
  validateFilmSources(edit,retained.sourceSet);
  await verifyRetainedNarration(directory,edit,provenance,plan,retained.sourceSet);
  return compactVerifiedScratch({projectPath,directory,manifestPath,manifest,edit,failed});
}

/** Failed previews keep the full edit but measure only narration beginning
 * before the requested range ends. Verify that selection, not missing phrases
 * that were deliberately outside the preview's audio work. */
export async function compactFilmPreview(input:{projectPath:string;previewId:string}):Promise<CompositionStorage>{
  const projectPath=await projectDirectory(input.projectPath),id=checkedPreviewId(input.previewId);
  await readProject(projectPath);
  const root=join(projectPath,'previews');await literalDirectory(root);
  const ownership=await previewOwnership(root);
  try{
    const directory=join(root,id);await literalDirectory(directory);
    const manifestPath=join(directory,'preview.json'),manifest=await json(manifestPath);
    if(manifest.schemaVersion!==1||manifest.kind!=='preview'||manifest.id!==id||manifest.projectPath!==projectPath||manifest.status!=='failed'||!manifest.error)
      throw failure('FILM_COMPACT_NOT_FAILED_PREVIEW','Inspect the exact failed preview and settle its processes before compacting. Running and ready previews cannot be compacted with this command.');
    let current:any;try{current=await json(join(root,'current.json'));}catch(error){if(!missing(error))throw error;}
    if(current){
      if(current.schemaVersion!==1||current.kind!=='current-preview')throw unsafe();checkedPreviewId(current.id);
      if(current.id===id)throw failure('FILM_COMPACT_CURRENT_PREVIEW','Keep the current viewing sample intact. Only a failed non-current preview can be compacted.');
    }
    await assertFailedRenderIdle(projectPath);
    if(!await literalDirectory(join(directory,'render'),true)&&!await literalDirectory(join(directory,'temporal-qa'),true))return {status:'already-compact',removedFiles:0,removedLogicalBytes:0};
    const edit=validateFilmEdit(await json(join(directory,'film-edit.json'))),plan=await json(join(directory,'edit-plan.json'));
    if(manifest.sourceSet?.id!==edit.sourceSetId||manifest.sourceSet?.sha256!==edit.sourceSetSha256||stableJson(plan.edit)!==stableJson(edit))
      throw failure('FILM_COMPACT_INPUT_MISMATCH','Restore this preview’s exact edit and source-set identity before compacting.');
    const retained=await loadSourceSet(projectPath,edit.sourceSetId);
    if(retained.sha256!==edit.sourceSetSha256)throw failure('FILM_COMPACT_INPUT_MISMATCH','Restore the original sealed source set before removing regenerable scratch.');
    const validated=validateFilmSources(edit,retained.sourceSet),range=manifest.range;
    const frameRange=previewFrameRange(range?.fromSeconds,range?.toSeconds,validated.durationSeconds);
    const selected={...edit,narration:edit.narration.filter(phrase=>phrase.outputStartSeconds<range.toSeconds)};
    if(range.fps!==60||stableJson(range.frameRange)!==stableJson(frameRange)||stableJson(plan.frameRange)!==stableJson(frameRange)
      ||stableJson(plan.measuredPhraseIds)!==stableJson(selected.narration.map(phrase=>phrase.id)))
      throw failure('FILM_COMPACT_INPUT_MISMATCH','Restore this preview’s exact range, frame range and measured narration selection before compacting.');
    await verifyRetainedNarration(directory,selected,undefined,plan,retained.sourceSet);
    if(!selected.narration.length&&stableJson(buildFilmTimeline(selected,{beats:[]},retained.sourceSet))!==stableJson(plan.timeline))
      throw failure('FILM_COMPACT_INPUT_MISMATCH','Restore this preview’s exact retained timeline before compacting.');
    return await compactVerifiedScratch({projectPath,directory,manifestPath,manifest,edit:selected,failed:true});
  }finally{await ownership.close();}
}

async function compactVerifiedScratch({projectPath,directory,manifestPath,manifest,edit,failed}:{projectPath:string;directory:string;manifestPath:string;manifest:any;edit:FilmEdit;failed:boolean}):Promise<CompositionStorage>{
  const candidates:Array<{relative:string;info:Stats}>=[],directories:string[]=[];
  const file=async(relative:string,remove:boolean)=>{const info=await regular(join(directory,relative));if(remove)candidates.push({relative,info});};
  const assets=new Set([...new Set(edit.pictures.map(p=>p.sourceId))].map((_,index)=>`source-${index}.mp4`));
  edit.narration.forEach((_,index)=>assets.add(`beat-${index}.wav`));
  const assetDirectory=async(relative:string)=>{
    await literalDirectory(join(directory,relative));
    for(const name of await readdir(join(directory,relative))){if(!assets.has(name))throw unsafe();await file(`${relative}/${name}`,true);}
    directories.push(relative);
  };
  if(await literalDirectory(join(directory,'render'),true))for(const name of await readdir(join(directory,'render'))){
    if(name==='assets')await assetDirectory('render/assets');
    else if(name==='bundle'){
      await literalDirectory(join(directory,'render/bundle'));
      for(const name of await readdir(join(directory,'render/bundle'))){
        if(name==='public')await assetDirectory('render/bundle/public');
        else if(/^(?:(?:\d+\.)?bundle\.js(?:\.map)?|index\.html|favicon\.ico)$/.test(name))await file(`render/bundle/${name}`,true);
        else throw unsafe();
      }
      directories.push('render/bundle');
    }else if(['master.mov','walkthrough.mp4','poster.png'].includes(name)){
      await file(`render/${name}`,name==='master.mov'||!failed);
      if(!failed&&name!=='master.mov'&&await digest(join(directory,'render',name))!==await digest(join(directory,name)))throw failure('FILM_COMPACT_DUPLICATE_MISMATCH','Keep the differing renderer output. Restore or inspect its relationship to the final delivery before compacting.');
    }else if(/^progress\.json\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(name)){
      // Process termination can interrupt the writer before rename or cleanup.
      // Keep its bounded bytes as diagnostics, even when empty or partial; never
      // adopt an incomplete atomic write as the canonical progress observation.
      if((await regular(join(directory,'render',name))).size>4096)throw unsafe();
    }else if(/^(?:(?:source|audio)-\d+|renderer|finish|finish-loudness-(?:input|delivery)|poster)\.log$/.test(name)||['source-staging.json','render-input.json','media-metrics.json','progress.json'].includes(name))await file(`render/${name}`,false);
    else throw unsafe();
  }
  if(await literalDirectory(join(directory,'temporal-qa'),true))for(const name of await readdir(join(directory,'temporal-qa'))){
    if(name==='camera-samples.gray'||/^source-\d+(?:-\d+)?-samples\.gray$/.test(name))await file(`temporal-qa/${name}`,true);
    else if(['camera-evidence.json','temporal-summary.json','final-probe.json','decode.log'].includes(name)||/^source-\d+-pts\.json$/.test(name)||/^source-\d+(?:-\d+)?-decode\.log$/.test(name))await file(`temporal-qa/${name}`,false);
    else throw unsafe();
  }

  if(failed)await assertFailedRenderIdle(projectPath);
  const result:CompositionStorage={status:candidates.length||directories.length?'compacted':'already-compact',removedFiles:0,removedLogicalBytes:0};
  try{
    for(const candidate of candidates){
      const path=join(directory,candidate.relative);let info:Stats;
      try{info=await regular(path);}catch(error){if(missing(error))continue;throw error;}
      if(info.dev!==candidate.info.dev||info.ino!==candidate.info.ino||info.size!==candidate.info.size||info.mtimeMs!==candidate.info.mtimeMs)throw unsafe();
      await unlink(path);result.removedFiles++;result.removedLogicalBytes+=info.size;
    }
    // No recursive deletion: an added or unrecognized file leaves its directory.
    for(const relative of directories){const path=join(directory,relative);if(await literalDirectory(path,true))await rmdir(path);}
  }catch(error){Object.assign(result,{status:result.removedFiles?'partial':'retained',error:retainedCompositionStorage(error).error});}
  // This record is outside checksums: compaction never rewrites delivery evidence.
  // A receipt-write failure must not turn a useful finished film into a failure.
  if(result.status!=='already-compact')try{manifest.storage=result;await saveJson(manifestPath,manifest);}catch{result.error={code:'FILM_COMPACT_RECORD_FAILED',owner:'storage',recovery:'The returned removal counts are observed, but could not be saved in the occurrence manifest. Inspect the exact occurrence before retrying.'};}
  return result;
}
