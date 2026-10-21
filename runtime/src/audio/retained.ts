import {constants} from 'node:fs';
import {readFile,writeFile,mkdir,lstat,realpath,copyFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {digestFile,validateAudioProvision,synthesisIdentity,alignmentIdentity,transcriptionIdentity,audioLanguage,type AudioLanguage} from './provision.ts';
import {verifyRenderedArtifact,verifyAlignedArtifact,verifyTranscribedArtifact} from './artifacts.ts';
import {audioMetrics} from './wav.ts';
import {captionCues,vttTime} from './captions.ts';
import {compareTranscript} from './transcription.ts';
import {Failure} from '../core/contracts.ts';
import type {NarrationBeatInput,NarrationBeat,NarrationResult} from './index.ts';

export interface RetainedNarrationInput {
  directory:string;beats:NarrationBeatInput[];voiceId?:string;language?:AudioLanguage;
  /** Editorial reuse may rename phrases. Integrity checks of a concrete
   * composition must instead verify each exact ID's retained receipt directory. */
  match?:'text'|'id-and-text';
}
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
async function literal(path:string,maximum=128*1024*1024){
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>maximum||await realpath(path)!==path)throw Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
  return path;
}
const receipt=async(path:string)=>json(await literal(path,4*1024*1024));

/** Pure offline verification. Historical locators are provenance, not tools to
 * execute. Neither model/reference files nor the selected provision are read. */
export async function inspectRetainedNarration(input:RetainedNarrationInput){
  try{return await verifiedRetainedNarration(input);}
  catch(error){
    if(error instanceof Failure)throw error;
    const missing=['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'');
    const code=missing?'AUDIO_RETAINED_PRODUCT_MISSING':error instanceof Error&&/^AUDIO_[A-Z0-9_]+$/.test(error.message)?error.message:'AUDIO_RETAINED_PROVENANCE_MISMATCH';
    throw new Failure(code,'audio',missing?'The selected composition is missing a declared retained audio product. Inspect its audio directory and restore the exact original bytes, or select a complete retained composition. No Voices command ran and no missing speech was regenerated.':'The selected composition’s retained audio or original receipts did not verify. Preserve it and inspect its audio directory; restore the exact original bytes rather than deleting cache or regenerating unchanged speech. No Voices command ran.');
  }
}
async function verifiedRetainedNarration(input:RetainedNarrationInput){
  if(!isAbsolute(input.directory)||resolve(input.directory)!==input.directory||await realpath(input.directory)!==input.directory)throw Error('AUDIO_ABSOLUTE_REUSE_DIRECTORY_REQUIRED');
  const narration=await receipt(join(input.directory,'narration.json')),provisionPath=await literal(join(input.directory,'provision.json'));
  if(narration.schemaVersion!==1||!Array.isArray(narration.beats)||narration.spokenContentVerified!==false||await digestFile(provisionPath)!==narration.provisionManifestSha256)throw Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
  const provision=validateAudioProvision(await json(provisionPath)),language=audioLanguage(input.language),voiceId=input.voiceId??narration.voiceId;
  if(narration.voiceId!==voiceId||audioLanguage(narration.language)!==language)return {complete:false as const,voiceId,language,beats:[],narration,provision,provisionPath};
  const beats:Array<{beat:NarrationBeat;directory:string}>=[];
  for(const wanted of input.beats){
    const beat=narration.beats.find((beat:any)=>beat.text===wanted.text&&(input.match!=='id-and-text'||beat.id===wanted.id));
    if(!beat)return {complete:false as const,voiceId,language,beats:[],narration,provision,provisionPath};
    if(typeof beat.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(beat.id))throw Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
    const directory=join(input.directory,beat.id),wavPath=await literal(join(directory,'narration.wav'));
    const synthesis=await receipt(join(directory,'synthesis.json')),alignment=await receipt(join(directory,'alignment.json'));
    const synthesisProvision=validateAudioProvision(synthesis.generationProvision??provision),alignProvision=validateAudioProvision(alignment.generationProvision??provision);
    const wavSha256=await digestFile(wavPath),metrics=audioMetrics(await readFile(wavPath),wanted.text),identity=synthesisIdentity(synthesisProvision,language,voiceId),alignIdentity=alignmentIdentity(alignProvision,language);
    if(beat.wavSha256!==wavSha256||synthesis.wavSha256!==wavSha256||synthesis.text!==wanted.text||synthesis.identity!==identity
      ||alignment.wavSha256!==wavSha256||alignment.text!==wanted.text||alignment.alignmentIdentity!==alignIdentity||alignment.identity!==identity)throw Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
    verifyRenderedArtifact(synthesis.artifact,wanted.text,synthesisProvision,language,voiceId);
    const words=verifyAlignedArtifact(alignment.provider,wanted.text,wavSha256,metrics.durationSeconds,alignProvision,language);
    if(JSON.stringify(alignment.words)!==JSON.stringify(words))throw Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
    let transcription:NarrationBeat['transcription'];
    if(beat.transcription){
      const saved=await receipt(join(directory,'transcription.json')),asrProvision=validateAudioProvision(saved.generationProvision??provision);
      if(asrProvision.schemaVersion!==3||saved.identity!==transcriptionIdentity(asrProvision,language)||saved.language!==language||saved.wavSha256!==wavSha256)throw Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
      verifyTranscribedArtifact(saved.provider,wavSha256,metrics.durationSeconds,asrProvision,language);
      const comparison=compareTranscript(wanted.text,saved.provider.transcript);
      if(saved.transcript!==saved.provider.transcript||JSON.stringify(saved.comparison)!==JSON.stringify(comparison))throw Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
      transcription={identity:saved.identity,transcript:saved.transcript,language,comparison,cacheHit:true,manifestPath:join(directory,'transcription.json'),provider:saved.provider};
    }
    beats.push({directory,beat:{id:wanted.id,text:wanted.text,wavPath,wavSha256,metrics,durationSeconds:metrics.durationSeconds,words,captions:captionCues(wanted.text,words,language),cacheHit:true,language,synthesisIdentity:identity,alignmentIdentity:alignIdentity,alignmentCacheHit:true,transcription,unresolvedWordCount:words.filter(word=>!word.timingResolved).length}});
  }
  return {complete:true as const,voiceId,language,beats,narration,provision,provisionPath};
}

/** Copies only verified retained products into the new editorial occurrence.
 * Original receipts remain byte-identical and carry their original runtime. */
export async function reuseRetainedNarration(input:RetainedNarrationInput&{outputDirectory:string}):Promise<NarrationResult|undefined>{
  const retained=await inspectRetainedNarration(input);if(!retained.complete)return undefined;
  const sourceManifestSha256=await digestFile(join(input.directory,'narration.json')),sourceProvisionSha256=retained.narration.provisionManifestSha256;
  await mkdir(input.outputDirectory,{mode:0o700});
  const copy=async(source:string,target:string)=>{await copyFile(source,target,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);if(await digestFile(source)!==await digestFile(target))throw Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');};
  await copy(retained.provisionPath,join(input.outputDirectory,'provision.json'));
  const beats:NarrationBeat[]=[],cues:Array<{text:string;startSeconds:number;endSeconds:number}>=[];let elapsed=0;
  for(const source of retained.beats){
    const directory=join(input.outputDirectory,source.beat.id);await mkdir(directory,{mode:0o700});
    for(const name of ['narration.wav','synthesis.json','alignment.json',...(source.beat.transcription?['transcription.json']:[])])await copy(join(source.directory,name),join(directory,name));
    const beat={...source.beat,wavPath:join(directory,'narration.wav'),...(source.beat.transcription?{transcription:{...source.beat.transcription,manifestPath:join(directory,'transcription.json')}}:{})};beats.push(beat);
    cues.push(...beat.captions.map(cue=>({...cue,startSeconds:cue.startSeconds+elapsed,endSeconds:cue.endSeconds+elapsed})));elapsed+=beat.durationSeconds;
  }
  const vttPath=join(input.outputDirectory,'narration.vtt'),manifestPath=join(input.outputDirectory,'narration.json');
  await writeFile(vttPath,'WEBVTT\n\n'+cues.map((cue,index)=>`${index+1}\n${vttTime(cue.startSeconds)} --> ${vttTime(cue.endSeconds)}\n${cue.text}`).join('\n\n')+'\n',{flag:'wx',mode:0o600});
  const result={schemaVersion:1 as const,voiceId:retained.voiceId,language:retained.language,beats,manifestPath,vttPath,provisionManifestSha256:sourceProvisionSha256,provisionManifestPath:join(input.outputDirectory,'provision.json'),runtime:retained.provision.runtime,reuseOnly:true,reuseSource:{manifestPath:join(input.directory,'narration.json'),sha256:sourceManifestSha256},spokenContentVerified:false as const,humanListeningRequired:true as const};
  await writeFile(manifestPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  const verified=await inspectRetainedNarration({directory:input.outputDirectory,beats:input.beats,voiceId:retained.voiceId,language:retained.language,match:'id-and-text'});
  if(!verified.complete||await digestFile(join(input.directory,'narration.json'))!==sourceManifestSha256||await digestFile(retained.provisionPath)!==sourceProvisionSha256)throw Error('AUDIO_RETAINED_PROVENANCE_MISMATCH');
  return result;
}
