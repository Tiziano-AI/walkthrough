import {isAbsolute} from 'node:path';
import {stableJson,resolveProvisionVoice,type AudioProvision,type CurrentAudioProvision,type AudioLanguage} from './provision.ts';
import {validateAlignment} from './captions.ts';

export function verifyRuntime(actual:unknown,manifest:AudioProvision):void{
  if(stableJson(actual)!==stableJson(manifest.runtime))throw new Error('AUDIO_RUNTIME_IDENTITY_DRIFT');
}
function verifyGenerationRuntime(actual:any,manifest:AudioProvision):void{
  if(!actual||typeof actual!=='object'||typeof actual.executable!=='string'||!isAbsolute(actual.executable))throw new Error('AUDIO_RUNTIME_IDENTITY_DRIFT');
  const {executable:_actual,...actualIdentity}=actual,{executable:_current,...currentIdentity}=manifest.runtime;
  if(stableJson(actualIdentity)!==stableJson(currentIdentity))throw new Error('AUDIO_RUNTIME_IDENTITY_DRIFT');
}
export function verifyRenderedArtifact(artifact:any,text:string,manifest:AudioProvision,language:AudioLanguage='English',voiceId?:string):void{
  verifyGenerationRuntime(artifact?.runtime,manifest);const voice=resolveProvisionVoice(manifest,voiceId);
  if(artifact?.schema_version!==2||artifact.voice_id!==voice.id||artifact.reference_voice_id!==voice.id||artifact.text!==text
    ||(artifact.language===undefined&&manifest.schemaVersion===2?'English':artifact.language)!==language
    ||artifact.base_model_id!==manifest.models.tts.repository||artifact.base_model_revision!==manifest.models.tts.revision
    ||artifact.reference_sha256!==voice.files['reference.wav'])throw new Error('AUDIO_GENERATION_PROVENANCE_MISMATCH');
}
export function verifyAlignedArtifact(aligned:any,text:string,wavSha256:string,duration:number,manifest:AudioProvision,language:AudioLanguage='English'){
  verifyGenerationRuntime(aligned?.runtime,manifest);
  if(aligned?.model_id!==manifest.models.aligner.repository||aligned.model_revision!==manifest.models.aligner.revision||aligned.text!==text
    ||(aligned.language===undefined&&manifest.schemaVersion===2?'English':aligned.language)!==language||aligned.audio?.sha256!==wavSha256
    ||typeof aligned.audio.duration_seconds!=='number'||Math.abs(aligned.audio.duration_seconds-duration)>.001
    ||aligned.audio.sample_rate!==16000||aligned.audio.channels!==1||aligned.audio.normalized_dtype!=='<f4'
    ||!/^[a-f0-9]{64}$/.test(aligned.audio.normalized_sha256)||aligned.audio.waveform_basis!=='ffmpeg-normalized-mono-pcm16-to-float32'
    ||aligned.timing_basis!=='qwen-forced-aligner-estimator-adjusted'||aligned.spoken_content_verified!==false||aligned.timing_diagnostics!==null
    ||typeof aligned.diagnostic_limit!=='string'||!aligned.diagnostic_limit.trim()||!Array.isArray(aligned.words))throw new Error('AUDIO_ALIGNMENT_PROVENANCE_MISMATCH');
  return validateAlignment(text,aligned.words.map((word:any)=>({text:word?.text,start_time:word?.start,end_time:word?.end})),duration);
}
export function verifyTranscribedArtifact(transcribed:any,wavSha256:string,duration:number,manifest:CurrentAudioProvision,language:AudioLanguage):void{
  verifyGenerationRuntime(transcribed?.runtime,manifest);
  if(typeof transcribed?.transcript!=='string'||transcribed.transcript.length>10000||transcribed.language!==language
    ||transcribed.model_id!==manifest.models.asr.repository||transcribed.model_revision!==manifest.models.asr.revision
    ||transcribed.audio?.sha256!==wavSha256||typeof transcribed.audio.duration_seconds!=='number'||Math.abs(transcribed.audio.duration_seconds-duration)>.001
    ||transcribed.audio.sample_rate!==16000||transcribed.audio.channels!==1||transcribed.audio.normalized_dtype!=='<f4'
    ||!/^[a-f0-9]{64}$/.test(transcribed.audio.normalized_sha256)||transcribed.audio.waveform_basis!=='ffmpeg-normalized-mono-pcm16-to-float32')throw new Error('AUDIO_TRANSCRIPTION_PROVENANCE_MISMATCH');
}
