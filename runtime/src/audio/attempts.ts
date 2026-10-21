import {constants} from 'node:fs';
import {readFile,writeFile,mkdir,lstat,realpath,rename,copyFile,readdir,open} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {Failure} from '../core/contracts.ts';
import {processTable,retainLaunchIdentity} from '../session/process.ts';
import type {ProcessIdentity} from '../session/contracts.ts';
import {validateAudioProvision,digestFile,synthesisIdentity,alignmentIdentity,transcriptionIdentity,stableJson,type CurrentAudioProvision,type AudioLanguage} from './provision.ts';
import {verifyRenderedArtifact,verifyAlignedArtifact,verifyTranscribedArtifact} from './artifacts.ts';
import {canonicalWords} from './captions.ts';
import {audioMetrics} from './wav.ts';

export type AudioStage='render'|'align'|'transcribe';
export interface AudioAttemptInput {stage:AudioStage;identity:string;text:string;language:AudioLanguage;voiceId:string;provision:CurrentAudioProvision;wavPath?:string;wavSha256?:string}
interface AudioAttempt extends AudioAttemptInput {schemaVersion:1;kind:'audio-attempt';id:string;key:string;cachedPath:string;owner:ProcessIdentity;createdAt:string}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const roots={render:'segments',align:'alignments',transcribe:'transcriptions'} as const;
const receipts={render:'segment.json',align:'alignment.json',transcribe:'transcription.json'} as const;
const fail=(code:string,recovery:string,attemptPath?:string):never=>{throw Object.assign(new Failure(code,'audio',recovery),attemptPath?{attemptPath}:{});};
const canonical=(path:string)=>isAbsolute(path)&&resolve(path)===path;
const save=(path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
async function literalFile(path:string,maximum=4*1024*1024){
  if(!canonical(path))return fail('AUDIO_ATTEMPT_UNSAFE','Use the literal absolute attempt.json path returned by the retained audio failure.');
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>maximum||await realpath(path)!==path)return fail('AUDIO_ATTEMPT_UNSAFE','Keep this attempt and inspect its original literal files; redirected or oversized state was not followed.');
  return path;
}
async function readJson(path:string){await literalFile(path);return JSON.parse(await readFile(path,'utf8'));}
async function optionalJson(path:string){try{return await readJson(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}}
function resolutionRecord(value:any,attemptId:string){
  if(value===undefined)return undefined;
  if(!value||value.schemaVersion!==1||value.kind!=='audio-attempt-resolution'||value.attemptId!==attemptId
    ||!['adopt','retry'].includes(value.resolution)||typeof value.note!=='string'||!value.note.trim()||value.note.length>2000
    ||typeof value.at!=='string'||value.at.length>64||!Number.isFinite(Date.parse(value.at)))return fail('AUDIO_ATTEMPT_RESOLUTION_INVALID','Preserve this attempt and its original resolution: the recorded decision does not validate. No stage was retried or released.');
  return {schemaVersion:1,kind:'audio-attempt-resolution',attemptId,resolution:value.resolution as 'adopt'|'retry',note:value.note,at:value.at};
}
/** The same macOS descriptor lock used by preview ownership. It covers only
 * cache reservation and recovery, never model execution. Process death releases
 * the kernel lock; its inode remains, so there is no stale lock to delete. */
async function cacheOwnership(cacheDirectory:string){
  await mkdir(cacheDirectory,{recursive:true,mode:0o700});
  const path=join(cacheDirectory,'attempts.lock'),handle=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  try{
    const expected=await handle.stat(),literal=await lstat(await literalFile(path));
    if(!expected.isFile()||literal.nlink!==1||expected.dev!==literal.dev||expected.ino!==literal.ino)return fail('AUDIO_CACHE_OWNERSHIP_UNSAFE','Preserve the audio cache: its reservation lock changed. No model stage was dispatched or released.');
    const result=spawnSync('/usr/bin/lockf',['-s','-t','0','3'],{stdio:['ignore','ignore','ignore',handle.fd],env:{PATH:'/usr/bin:/bin'},timeout:5000});
    if(result.status===75)return fail('AUDIO_CACHE_BUSY','Another command is reserving or resolving an audio stage. Inspect that command before retrying this operation; no model stage was dispatched by this call.');
    if(result.error||result.status!==0)return fail('AUDIO_CACHE_LOCK_UNAVAILABLE','Restore the macOS /usr/bin/lockf prerequisite. Keep attempts.lock and all retained products; no model stage was dispatched or released.');
    const current=await lstat(await literalFile(path));
    if(expected.dev!==current.dev||expected.ino!==current.ino)return fail('AUDIO_CACHE_OWNERSHIP_UNSAFE','Preserve the audio cache: its reservation lock changed. No model stage was dispatched or released.');
    return handle;
  }catch(error){await handle.close();throw error;}
}
async function attemptRecord(attemptPath:string){
  if(basename(attemptPath)!=='attempt.json')return fail('AUDIO_ATTEMPT_PATH','Use --attempt with the retained stage’s absolute attempt.json path.');
  let located=attemptPath,raw:unknown,movedId:string|undefined;
  try{raw=await readJson(located);}catch(error){
    if(error instanceof SyntaxError)return fail('AUDIO_ATTEMPT_INVALID','The retained attempt record is not valid JSON. Preserve it and its stage diagnostic; no model was dispatched.');
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    const moved=basename(dirname(attemptPath)).match(/^([a-f0-9]{64})\.partial-([a-f0-9-]{36})$/);
    if(!moved)return fail('AUDIO_ATTEMPT_RECORD_MISSING','No retained attempt record exists at this path. Inspect the original audio failure for paths.attempt; no cache entry was deleted or replayed.');
    located=join(dirname(dirname(attemptPath)),moved[1],'attempt.json');movedId=moved[2];
    try{raw=await readJson(located);}catch{return fail('AUDIO_ATTEMPT_RECORD_MISSING','Neither the original partial attempt nor its adopted cache identity exists. Inspect the original audio failure; no inference or deletion was attempted.');}
  }
  const a=raw as AudioAttempt,directory=dirname(located);
  if(!a||a.schemaVersion!==1||a.kind!=='audio-attempt'||!['render','align','transcribe'].includes(a.stage)||typeof a.id!=='string'||!/^[a-f0-9-]{36}$/.test(a.id))return fail('AUDIO_ATTEMPT_INVALID','Preserve this attempt and inspect its retained diagnostic; no retry was authorized.');
  const provision=validateAudioProvision(a.provision);if(provision.schemaVersion!==3)throw Error('AUDIO_ASR_PROVISION_REQUIRED');
  canonicalWords(a.text);
  const identity=a.stage==='render'?synthesisIdentity(provision,a.language,a.voiceId):a.stage==='align'?alignmentIdentity(provision,a.language):transcriptionIdentity(provision,a.language);
  const key=hash(identity+'\0'+(a.stage==='render'?a.text:a.stage==='align'?a.wavSha256+'\0'+a.text:a.wavSha256));
  if(a.identity!==identity||a.key!==key||a.cachedPath!==join(provision.cacheDirectory,roots[a.stage],key)
    ||dirname(directory)!==dirname(a.cachedPath)||![key,`${key}.partial-${a.id}`].includes(basename(directory))
    ||movedId&&movedId!==a.id||!Number.isSafeInteger(a.owner?.pid)||a.owner.pid<1||!Number.isSafeInteger(a.owner.pgid)||a.owner.pgid<1||!/^\d+:\d+$/.test(a.owner.startedAt)||!/^[a-f0-9]{64}$/.test(a.owner.commandSha256))return fail('AUDIO_ATTEMPT_INVALID','The attempt inputs, cache identity or original process identity do not agree. No stage was adopted or released.');
  return {a,directory,attemptPath:located};
}
async function processState(a:AudioAttempt){
  const table=await processTable(),owner=table.find(row=>row.pid===a.owner.pid),active=owner&&owner.state!=='Z'&&owner.startedAt===a.owner.startedAt;
  // Even when the original worker is gone, an orphaned Voices child can still
  // write. A group number is absence evidence only, never signal authority.
  const members=table.filter(row=>row.pgid===a.owner.pgid&&row.state!=='Z');
  return {status:active||members.length?'running-or-unsettled' as const:'stopped' as const,originalWorkerPresent:!!active,remainingGroupMembers:members.length};
}
async function contained(directory:string,path:unknown){
  if(typeof path!=='string'||!canonical(path)||!path.startsWith(directory+sep))throw Error('AUDIO_OUTPUT_PATH_ESCAPE');
  return literalFile(path,128*1024*1024);
}
async function products(a:AudioAttempt,directory:string){
  const provision=a.provision;
  if(a.stage==='render'){
    const output=await readJson(join(directory,'render.stdout.json'));
    verifyRenderedArtifact(output.artifact,a.text,provision,a.language,a.voiceId);
    const located=(path:unknown)=>typeof path==='string'&&directory===a.cachedPath&&path.startsWith(`${a.cachedPath}.partial-${a.id}/`)?directory+path.slice(`${a.cachedPath}.partial-${a.id}`.length):path;
    const source=await contained(directory,located(output.paths?.wav)),sidecar=await contained(directory,located(output.paths?.sidecar));
    if(basename(source)!==output.artifact.output_audio||stableJson(await readJson(sidecar))!==stableJson(output.artifact))throw Error('AUDIO_GENERATION_PROVENANCE_MISMATCH');
    const wavSha256=await digestFile(source);audioMetrics(await readFile(source),a.text);
    return {source,wavSha256,synthesis:{identity:a.identity,text:a.text,language:a.language,wavSha256,artifact:output.artifact,generationProvision:provision},receipt:{schemaVersion:3,identity:a.identity,text:a.text,language:a.language,wavSha256}};
  }
  if(typeof a.wavPath!=='string'||!canonical(a.wavPath))throw Error('AUDIO_ATTEMPT_INVALID');
  await literalFile(a.wavPath,128*1024*1024);
  if(await digestFile(a.wavPath)!==a.wavSha256)throw Error('AUDIO_CACHE_CORRUPTION');
  const duration=audioMetrics(await readFile(a.wavPath),a.text).durationSeconds,provider=await readJson(join(directory,`${a.stage}.stdout.json`));
  if(a.stage==='align')verifyAlignedArtifact(provider,a.text,a.wavSha256!,duration,provision,a.language);
  else verifyTranscribedArtifact(provider,a.wavSha256!,duration,provision,a.language);
  return {receipt:{identity:a.identity,...(a.stage==='align'?{text:a.text}:{}),language:a.language,wavSha256:a.wavSha256,provider}};
}

/** Reserve identity and process custody before dispatching a single model stage. */
export async function createAudioCacheWork(input:AudioAttemptInput){
  const ownership=await cacheOwnership(input.provision.cacheDirectory);
  try{
  const root=join(input.provision.cacheDirectory,roots[input.stage]),receipt=receipts[input.stage];await mkdir(root,{recursive:true});
  const key=hash(input.identity+'\0'+(input.stage==='render'?input.text:input.stage==='align'?input.wavSha256+'\0'+input.text:input.wavSha256)),cached=join(root,key);
  try{await literalFile(join(cached,receipt));return {work:cached,cached,reused:true};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  for(const name of await readdir(root))if(name===key||name.startsWith(`${key}.partial-`)){
    const path=join(root,name),storedResolution=await optionalJson(join(path,'resolution.json'));
    if(storedResolution){
      const prior=await attemptRecord(join(path,'attempt.json'));
      const resolution=resolutionRecord(storedResolution,prior.a.id);
      if(prior.a.identity!==input.identity||prior.a.stage!==input.stage)throw Error('AUDIO_ATTEMPT_RESOLUTION_CONFLICT');
      if(resolution?.resolution==='retry')continue;
    }
    const code=input.stage==='render'?'AUDIO_PARTIAL_SEGMENT_REQUIRES_RECONCILIATION':input.stage==='align'?'AUDIO_PARTIAL_ALIGNMENT_REQUIRES_RECONCILIATION':'AUDIO_PARTIAL_TRANSCRIPTION_REQUIRES_RECONCILIATION';
    return fail(code,`Run audio attempt inspect --attempt ${join(path,'attempt.json')}; resolve that stopped attempt before retrying. Its products and diagnostics remain retained.`,join(path,'attempt.json'));
  }
  const id=randomUUID(),work=`${cached}.partial-${id}`,owner=await retainLaunchIdentity();await mkdir(work);
  const attempt:AudioAttempt={...input,schemaVersion:1,kind:'audio-attempt',id,key,cachedPath:cached,owner,createdAt:new Date().toISOString()};
  await save(join(work,'attempt.json'),attempt);return {work,cached,reused:false};
  }finally{await ownership.close();}
}

export async function inspectAudioAttempt(input:{attemptPath:string}){
  const {a,directory,attemptPath}=await attemptRecord(input.attemptPath),processes=await processState(a),resolution=resolutionRecord(await optionalJson(join(directory,'resolution.json')),a.id);
  let adoptable=false,productError:string|null=null;
  try{
    const output=await products(a,directory),retained=await optionalJson(join(directory,receipts[a.stage]));
    if(retained&&stableJson(retained)!==stableJson(output.receipt))throw Error('AUDIO_CACHE_CORRUPTION');
    if(basename(directory)===a.key&&!retained)throw Error('AUDIO_CACHE_CORRUPTION');
    if(a.stage==='render'&&basename(directory)===a.key){
      const synthesis=await readJson(join(directory,'synthesis.json'));if(stableJson(synthesis)!==stableJson(output.synthesis)||await digestFile(await literalFile(join(directory,'narration.wav')))!==output.wavSha256)throw Error('AUDIO_CACHE_CORRUPTION');
    }
    adoptable=true;
  }catch(error){productError=error instanceof Error&&/^AUDIO_[A-Z0-9_]+$/.test(error.message)?error.message:'AUDIO_STAGE_OUTPUT_INCOMPLETE';}
  return {schemaVersion:1,kind:'audio-attempt',id:a.id,attemptPath,stage:a.stage,identity:a.identity,input:{textSha256:hash(a.text),wavSha256:a.wavSha256??null,language:a.language,voiceId:a.voiceId},processes,
    status:basename(directory)===a.key?(adoptable?'completed':'invalid-product'):resolution?.resolution==='retry'?'retry-authorized':'incomplete',adoptable,productError,resolution:resolution??null,
    nextAction:processes.status!=='stopped'?'Inspect this same attempt after its original worker and process group have stopped.':basename(directory)===a.key?'The verified stage is available to the next composition.':adoptable?'Resolve this attempt with adopt to retain its verified product without model execution.':'Resolve this attempt with retry, then compose again; only this incomplete stage is released.',inference:false};
}

/** Never executes a model. Retry releases this stage only; the next ordinary
 * composition keeps using all independently sealed upstream products. */
export async function resolveAudioAttempt(input:{attemptPath:string;resolution:'adopt'|'retry';note:string}){
  if(!['adopt','retry'].includes(input.resolution)||typeof input.note!=='string'||!input.note.trim()||input.note.length>2000)return fail('AUDIO_ATTEMPT_RESOLUTION_INVALID','Supply --resolution adopt|retry and a nonempty --note describing the observed reason.');
  const observed=await attemptRecord(input.attemptPath),ownership=await cacheOwnership(observed.a.provision.cacheDirectory);
  try{
  const {a,directory}=await attemptRecord(input.attemptPath),state=await inspectAudioAttempt(input);
  if(state.processes.status!=='stopped')return fail('AUDIO_ATTEMPT_PROCESS_UNSETTLED',state.nextAction+' No model was dispatched and no process was signalled.');
  if(state.status==='completed')return state;
  if(basename(directory)===a.key)return fail('AUDIO_CACHE_CORRUPTION','This sealed cache entry no longer validates. Preserve it and its diagnostics; it was not released or overwritten.');
  if(input.resolution==='retry'&&state.adoptable)return fail('AUDIO_ATTEMPT_VALID_PRODUCT_RETAINED','This stage already has a valid product. Resolve with adopt rather than rerunning the model.');
  if(input.resolution==='adopt'&&!state.adoptable)return fail('AUDIO_ATTEMPT_OUTPUT_INCOMPLETE','Inspect the retained stage diagnostic; adopt requires a fully verified original product. Resolve retry only after accepting that this incomplete stage must run again.');
  const path=join(directory,'resolution.json'),prior=resolutionRecord(await optionalJson(path),a.id);
  if(prior&&(prior.resolution!==input.resolution||prior.note!==input.note))return fail('AUDIO_ATTEMPT_RESOLUTION_CONFLICT','Keep the original resolution; no competing decision or inference was applied.');
  if(!prior)await save(path,{schemaVersion:1,kind:'audio-attempt-resolution',attemptId:a.id,resolution:input.resolution,note:input.note,at:new Date().toISOString()});
  if(input.resolution==='adopt'){
    const output=await products(a,directory);
    const verifiedSave=async(name:string,value:unknown)=>{const old=await optionalJson(join(directory,name));if(old){if(JSON.stringify(old)!==JSON.stringify(value))throw Error('AUDIO_CACHE_CORRUPTION');}else await save(join(directory,name),value);};
    if(a.stage==='render'){
      const target=join(directory,'narration.wav');
      try{await literalFile(target);if(await digestFile(target)!==output.wavSha256)throw Error('AUDIO_CACHE_CORRUPTION');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await copyFile(output.source!,target,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);}
      await verifiedSave('synthesis.json',output.synthesis);
    }
    await verifiedSave(receipts[a.stage],output.receipt);
    await rename(directory,a.cachedPath);
    return inspectAudioAttempt({attemptPath:join(a.cachedPath,'attempt.json')});
  }
  return inspectAudioAttempt(input);
  }finally{await ownership.close();}
}
