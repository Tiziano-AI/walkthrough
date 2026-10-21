import {constants} from 'node:fs';
import {lstat,open,realpath,writeFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';

const operations=['preflight','doctor','render','align','transcribe','cache','final-doctor','final-verification','manifest'] as const;
const pathKeys=['runtimeStdout','runtimeStderr','providerStdout','providerStderr','segmentDirectory','narrationWav','attempt'] as const;
const maximumBytes=32*1024;
type FailurePaths=Partial<Record<typeof pathKeys[number],string>>;
type ChildOutcome={exitCode:number|null;signal:string|null;startFailed:boolean};
type ProviderError={code:string|null;message:string|null;truncated:boolean};
type ResponseState='json'|'invalid'|'too-large'|'unreadable';
export type AudioFailureContext={phraseId:string|null;operation:typeof operations[number];paths:FailurePaths};
export type AudioCommandDiagnostic={child:ChildOutcome;response:ResponseState;providerError:ProviderError|null;paths:FailurePaths};
export type AudioFailureRecord=AudioFailureContext&{schemaVersion:1;kind:'audio-failure';code:string;child:ChildOutcome|null;response:ResponseState|null;providerError:ProviderError|null;recovery?:string};

export class AudioCommandFailure extends Error {
  diagnostic:AudioCommandDiagnostic;
  constructor(code:string,diagnostic:AudioCommandDiagnostic){super(code);this.diagnostic=diagnostic;}
}

/** Only the documented error code/message may cross into public diagnostics.
 * Pydantic input representations can include canonical speech or model output;
 * keep the causal message, not those representations, traces or arbitrary fields. */
export function safeProviderError(value:unknown):ProviderError|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const error=value as Record<string,unknown>;
  const code=typeof error.code==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(error.code)?error.code:null;
  const original=typeof error.message==='string'?error.message:null;
  const safe=original?.split(/[\[{]|\b(?:input_value|text|transcript|prompt|context|environment|env)\s*[=:]|\bTraceback \(most recent call last\)|\n\s*(?:File "|at \S+.*:\d+)/iu)[0]
    .replace(/\b(?:Bearer\s+\S+|(?:[A-Z][A-Z0-9_]*)?(?:TOKEN|SECRET|PASSWORD|KEY)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+))/gi,'[redacted]')
    .replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/gu,' ').trim();
  const message=safe?.slice(0,1024)||null;
  return code||message?{code,message,truncated:original!==null&&message!==original}:null;
}

const audioCode=(error:unknown)=>error instanceof Error&&/^AUDIO_[A-Z0-9_]{1,96}$/.test(error.message)?error.message:'AUDIO_RUNTIME_FAILED';

/** Recording a failure never changes its outcome or cleans up any audio.
 * The original worker error survives a diagnostic-write failure. */
export async function withAudioFailure<T>(directory:string,context:AudioFailureContext,body:()=>Promise<T>):Promise<T>{
  try{return await body();}
  catch(error){
    const command=error instanceof AudioCommandFailure?error.diagnostic:null;
    const record:AudioFailureRecord={schemaVersion:1,kind:'audio-failure',code:audioCode(error),phraseId:context.phraseId,operation:context.operation,
      child:command?.child??null,response:command?.response??null,providerError:command?.providerError??null,
      ...(error instanceof Error&&'recovery'in error&&typeof error.recovery==='string'?{recovery:error.recovery}:{}),
      paths:{runtimeStdout:join(directory,'runtime.stdout.log'),runtimeStderr:join(directory,'runtime.stderr.log'),...context.paths,...command?.paths,...(error instanceof Error&&'attemptPath'in error&&typeof error.attemptPath==='string'?{attempt:error.attemptPath}:{})}};
    try{
      const projected=projectRecord(record),bytes=JSON.stringify(projected)+'\n';
      if(projected&&Buffer.byteLength(bytes)<=maximumBytes)await writeFile(join(directory,'failure.json'),bytes,{flag:'wx',mode:0o600});
    }catch{/* Retain the original failure and its existing local logs. */}
    throw error;
  }
}

function projectRecord(value:unknown):AudioFailureRecord|null{
  if(!value||typeof value!=='object')return null;
  const p=value as AudioFailureRecord;
  if(p.schemaVersion!==1||p.kind!=='audio-failure'||typeof p.code!=='string'||!/^AUDIO_[A-Z0-9_]{1,96}$/.test(p.code)
    ||!(p.phraseId===null||typeof p.phraseId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(p.phraseId))||!operations.includes(p.operation)
    ||!(p.response===null||['json','invalid','too-large','unreadable'].includes(p.response))||!p.paths||typeof p.paths!=='object')return null;
  const child=p.child;
  if(child!==null&&(!child||!(child.exitCode===null||Number.isSafeInteger(child.exitCode))
    ||!(child.signal===null||typeof child.signal==='string'&&/^SIG[A-Z0-9]{1,20}$/.test(child.signal))||typeof child.startFailed!=='boolean'))return null;
  const paths:FailurePaths={};
  for(const key of pathKeys){
    const path=p.paths[key];if(path===undefined)continue;
    if(typeof path!=='string'||path.length>4096||/[\p{Cc}\p{Cf}]/u.test(path)||!isAbsolute(path)||resolve(path)!==path)return null;
    paths[key]=path;
  }
  const providerError=safeProviderError(p.providerError);
  if(p.providerError!==null&&(!providerError||typeof p.providerError.truncated!=='boolean'))return null;
  if(providerError)providerError.truncated=providerError.truncated||p.providerError!.truncated;
  return {schemaVersion:1,kind:'audio-failure',code:p.code,phraseId:p.phraseId,operation:p.operation,
    child:child?{exitCode:child.exitCode,signal:child.signal,startFailed:child.startFailed}:null,response:p.response,providerError,paths,
    ...(typeof p.recovery==='string'&&p.recovery.length<=8192?{recovery:p.recovery}:{})};
}

/** A bounded local diagnostic read only: never follows the referenced cache/log
 * paths, launches audio, repairs old failures or infers current worker liveness. */
export async function inspectAudioFailure(compositionDirectory:string){
  const directory=join(compositionDirectory,'audio'),diagnosticPath=join(directory,'failure.json');
  let state:'recorded'|'not-recorded'|'invalid'|'unsafe'|'unreadable'='not-recorded',record:AudioFailureRecord|null=null,handle;
  try{
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)state='unsafe';
    else{
      handle=await open(diagnosticPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const info=await handle.stat();
      if(!info.isFile())state='unsafe';
      else if(info.size>maximumBytes)state='invalid';
      else{
        const bytes=Buffer.alloc(maximumBytes+1),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
        record=bytesRead<=maximumBytes?projectRecord(JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'))):null;
        state=record?'recorded':'invalid';
      }
    }
  }catch(error){state=error instanceof SyntaxError?'invalid':(error as NodeJS.ErrnoException).code==='ENOENT'?'not-recorded':(error as NodeJS.ErrnoException).code==='ELOOP'?'unsafe':'unreadable';}
  finally{await handle?.close();}
  return {state,statusBasis:'retained-audio-failure' as const,diagnosticPath,record};
}
