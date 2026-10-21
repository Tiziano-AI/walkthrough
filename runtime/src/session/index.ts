import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createConnection} from 'node:net';
import {open,unlink} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {localEnvironment,qualifiedNodePath} from '../core/environment.ts';
import {runtimePaths} from '../core/runtime-paths.ts';
import {SessionError,type ActionRecord,type ActionRequest,type CaptureRequest,type Observation,type ObserveOptions,type SessionConfig,type SessionEvent,type SessionInfo} from './contracts.ts';
import {actionPath,digest,infoPath,privateDirectory,readAction,readJson,recoverInterruptedActions,saveInfo,timestamp,validId,writeJson} from './journal.ts';
import {inspectWorker,removeSessionMarker,retainLaunchIdentity,settleStoppedWorker} from './process.ts';
import {interruptSessionTakes} from '../project/capture.ts';
import {reconcilePrintArtifacts} from './print-artifact.ts';

export type {SessionConfig,SessionInfo,SessionAction,SessionTarget,ActionRecord,ActionRequest,Observation,ObserveOptions,CaptureRequest} from './contracts.ts';

type RpcResult<T>={ok:true;result:T}|{ok:false;error:{code:string;message:string}};
const transportLost=(error:unknown)=>error instanceof SessionError&&['SESSION_WORKER_UNAVAILABLE','SESSION_RESPONSE_UNCERTAIN'].includes(error.code);

/** Resolve only retained launch evidence. Inspection never opens a profile,
 * rewrites historical records, or substitutes the caller's current state root. */
export async function retainedProfileDirectory(info:SessionInfo):Promise<string|null>{
  const absolute=(value:unknown):value is string=>typeof value==='string'&&resolve(value)===value;
  if(info.profileDirectory!==undefined)return absolute(info.profileDirectory)?info.profileDirectory:null;
  let config:SessionConfig;
  try{config=await readJson<SessionConfig>(join(info.directory,'config.json'));}catch{return null;}
  if(!config||config.directory!==info.directory||config.projectId!==info.projectId||config.projectPath!==info.projectPath)return null;
  if(config.profileDirectory!==undefined)return absolute(config.profileDirectory)?config.profileDirectory:null;
  if(!absolute(info.socketPath)||!validId(info.sessionId)||basename(dirname(info.socketPath))!=='sockets'||basename(info.socketPath)!==`${digest(info.directory).slice(0,20)}.sock`)return null;
  return join(dirname(dirname(info.socketPath)),'profiles',info.sessionId);
}

export async function sessionRequest<T>(directory:string,method:string,params:unknown={}):Promise<T>{
  const info=await readJson<SessionInfo>(infoPath(directory));
  return new Promise<T>((resolve,reject)=>{
    const socket=createConnection(info.socketPath);let buffer='',settled=false;
    const finish=(error?:unknown,result?:T)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(result as T);};
    // Transport timeout is not cancellation and never triggers replay. The
    // retained operation is inspected with its same ID after this error.
    socket.setTimeout(60000,()=>finish(new SessionError('SESSION_RESPONSE_UNCERTAIN','The response was not received. Inspect the original action/operation ID; do not redispatch under a new ID.')));
    socket.on('connect',()=>socket.write(JSON.stringify({version:1,sessionId:info.sessionId,workerToken:info.workerToken,method,params})+'\n'));
    socket.on('error',error=>finish(new SessionError('SESSION_WORKER_UNAVAILABLE',error.message)));
    socket.on('end',()=>{if(!settled)finish(new SessionError('SESSION_RESPONSE_UNCERTAIN'));});
    socket.on('data',(chunk:Buffer)=>{
      buffer+=chunk.toString();if(Buffer.byteLength(buffer)>16*1024*1024){finish(new SessionError('SESSION_RESPONSE_TOO_LARGE'));return;}
      const end=buffer.indexOf('\n');if(end<0)return;
      try{const response=JSON.parse(buffer.slice(0,end)) as RpcResult<T>;
        if(response.ok)finish(undefined,response.result);else finish(new SessionError(response.error.code,response.error.message));
      }catch(error){finish(error);}
    });
  });
}

export async function openSession(config:SessionConfig):Promise<SessionInfo>{
  // Configuration validation has no browser effect. Keep the runtime import in
  // the worker so the client never opens or attaches to a second browser.
  const sessionId=basename(config.directory);if(!validId(sessionId))throw new SessionError('INVALID_SESSION_ID');
  await privateDirectory(config.directory);
  const existing=await readJson<SessionInfo>(infoPath(config.directory)).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(existing){
    const previous=await readJson<SessionConfig>(join(config.directory,'config.json'));
    if(digest(previous)!==digest(config))throw new SessionError('SESSION_ID_CONFLICT');
    // Open is a single launch occurrence, not a restart API. A lost worker must
    // be reconciled; this same session identity never launches another browser.
    return (await inspectSession(config.directory)).session;
  }
  const {stateRoot}=runtimePaths(),socketRoot=join(stateRoot,'sockets');await privateDirectory(socketRoot);
  const socketPath=join(socketRoot,`${digest(config.directory).slice(0,20)}.sock`);
  if(Buffer.byteLength(socketPath)>100)throw new SessionError('SESSION_SOCKET_PATH_TOO_LONG','Select a shorter local state root.');
  const profileDirectory=config.profileDirectory??join(stateRoot,'profiles',sessionId);
  if(typeof profileDirectory!=='string'||resolve(profileDirectory)!==profileDirectory)throw new SessionError('PROFILE_PATH_NOT_ABSOLUTE');
  const launchIdentity=await retainLaunchIdentity();
  // Configuration must precede the launch reservation. A caller dying at any
  // later boundary leaves enough immutable input for same-ID inspection; a
  // concurrent caller cannot replace that input before claiming the launch.
  let configuration;
  try{configuration=await open(join(config.directory,'config.json'),'wx',0o600);}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    if(digest(await readJson<SessionConfig>(join(config.directory,'config.json')))!==digest(config))throw new SessionError('SESSION_ID_CONFLICT');
  }
  if(configuration)try{await configuration.writeFile(JSON.stringify(config,null,2)+'\n');await configuration.sync();}finally{await configuration.close();}
  const now=timestamp(),info:SessionInfo={version:1,sessionId,projectId:config.projectId,projectPath:config.projectPath,directory:config.directory,status:'starting',createdAt:now,updatedAt:now,captureActive:false,socketPath,profileDirectory,workerToken:randomUUID(),launchIdentity};
  // Exclusive reservation prevents concurrent open callers starting two workers.
  const reservation=await open(infoPath(config.directory),'wx',0o600);
  try{await reservation.writeFile(JSON.stringify(info,null,2)+'\n');await reservation.sync();}finally{await reservation.close();}
  const log=await open(join(config.directory,'worker.log'),'a',0o600);
  let child:ReturnType<typeof spawn>;
  try{
    child=spawn(qualifiedNodePath(),[fileURLToPath(new URL('./worker.ts',import.meta.url)),config.directory,info.workerToken!],{
      detached:true,stdio:['ignore',log.fd,log.fd],env:{...localEnvironment(),WALKTHROUGH_SESSION_WORKER:'1',
        ...(process.env.WALKTHROUGH_STATE_ROOT?{WALKTHROUGH_STATE_ROOT:process.env.WALKTHROUGH_STATE_ROOT}:{}),
        ...(process.env.WALKTHROUGH_CONFIG_ROOT?{WALKTHROUGH_CONFIG_ROOT:process.env.WALKTHROUGH_CONFIG_ROOT}:{})},
    });
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    info.pid=child.pid;
    child.unref();
  }catch(error){info.status='interrupted';info.closeReason='worker-launch-failed';await saveInfo(info);throw error;}
  finally{await log.close();}
  for(let attempt=0;attempt<150;attempt++){
    const current=await readJson<SessionInfo>(infoPath(config.directory));
    if(current.status==='open'){
      try{return await sessionRequest<SessionInfo>(config.directory,'info');}catch(error){if(attempt===149)throw error;}
    }
    if(current.status==='interrupted'||current.status==='closed')throw new SessionError('SESSION_START_FAILED',current.closeReason??'Inspect the retained worker log.');
    await delay(100);
  }
  throw new SessionError('SESSION_START_PENDING','The launch occurrence remains retained. Inspect this session; do not create another session as a retry.');
}

export async function inspectSession(directory:string):Promise<{session:SessionInfo;live:boolean;pages?:unknown[];events?:SessionEvent[];capture?:unknown;worker?:string;recovery?:string}>{
  const saved=await readJson<SessionInfo>(infoPath(directory));
  try{
    const current=await sessionRequest<SessionInfo&{pages:unknown[];events:SessionEvent[];capture:unknown}>(directory,'inspect');
    const {pages,events,capture,...session}=current;
    return {session:{...session,profileDirectory:await retainedProfileDirectory(saved)},live:true,pages,events,capture};
  }catch(error){
    if(!transportLost(error))throw error;
    const state=await inspectWorker(saved);
    if(state.worker==='stopped')await reconcilePrintArtifacts(directory);
    if(state.worker==='stopped'&&!['closed','interrupted'].includes(saved.status)){
      saved.status='interrupted';saved.closeReason='worker-unavailable';await recoverInterruptedActions(directory);await saveInfo(saved);
    }
    return {session:{...saved,profileDirectory:await retainedProfileDirectory(saved)},live:false,worker:state.worker,...(saved.status!=='closed'?{recovery:'Close this same session to reconcile its retained actions and browser custody. No input will be replayed.'}:{})};
  }
}
export const observeSession=(directory:string,options:ObserveOptions={})=>sessionRequest<Observation>(directory,'observe',options);
export async function dispatchSession(directory:string,request:ActionRequest){
  try{return await sessionRequest<ActionRecord>(directory,'dispatch',request);}
  catch(error){
    if(!(error instanceof SessionError)||error.code!=='SESSION_WORKER_UNAVAILABLE')throw error;
    await inspectSession(directory);const record=await readAction(directory,request.actionId);if(!record)throw error;
    if(record.payloadSha256!==digest(request.action))throw new SessionError('ACTION_ID_CONFLICT');return record;
  }
}
export async function captureSession(directory:string,request:CaptureRequest){
  try{return await sessionRequest<unknown>(directory,'capture',request);}
  catch(error){
    if(!(error instanceof SessionError)||error.code!=='SESSION_WORKER_UNAVAILABLE')throw error;
    if(!validId(request.operationId))throw new SessionError('INVALID_CAPTURE_REQUEST');
    const prior=await readJson<{sha256:string}>(join(directory,'capture-operations',`${request.operationId}.json`)).catch(problem=>{if(problem.code==='ENOENT')return undefined;throw problem;});
    if(!prior)throw error;if(prior.sha256!==digest(request))throw new SessionError('CAPTURE_OPERATION_ID_CONFLICT');return prior;
  }
}
export async function closeSession(directory:string){
  try{return await sessionRequest<SessionInfo>(directory,'close');}
  catch(error){if(!transportLost(error))throw error;}
  const info=await readJson<SessionInfo>(infoPath(directory));
  await settleStoppedWorker(info);await recoverInterruptedActions(directory);
  await reconcilePrintArtifacts(directory);
  await interruptSessionTakes(info.projectPath,info.sessionId);
  info.status='closed';info.captureActive=false;info.closeReason??='closed-after-worker-loss';await saveInfo(info);
  await removeSessionMarker(info);await unlink(info.socketPath).catch(error=>{if(error.code!=='ENOENT')throw error;});return info;
}
export async function inspectAction(directory:string,id:string){
  await inspectSession(directory);const record=await readAction(directory,id);if(!record)throw new SessionError('ACTION_NOT_FOUND');return record;
}
export async function resolveAction(directory:string,id:string,resolution:{outcome:'effect-observed'|'no-effect-observed'|'uncertain';note:string}){
  if(!resolution||!['effect-observed','no-effect-observed','uncertain'].includes(resolution.outcome)||typeof resolution.note!=='string'||!resolution.note.trim()||resolution.note.length>10000)throw new SessionError('INVALID_ACTION_RESOLUTION');
  // Route through the live serial owner to avoid racing action completion.
  try{return await sessionRequest<ActionRecord>(directory,'resolve',{id,resolution});}
  catch(error){if(!(error instanceof SessionError)||error.code!=='SESSION_WORKER_UNAVAILABLE')throw error;}
  const status=await inspectSession(directory);if(status.live||status.worker==='running'||status.worker==='unresolved')throw new SessionError('SESSION_WORKER_STATE_UNCERTAIN');
  const record=await readAction(directory,id);if(!record)throw new SessionError('ACTION_NOT_FOUND');
  record.resolution={...resolution,at:timestamp()};record.updatedAt=timestamp();await writeJson(actionPath(directory,id),record);return record;
}
export async function listSessionArtifacts(directory:string):Promise<Array<Record<string,unknown>&{eventId:string;pageId:string;actionId?:string}>>{
  let events:SessionEvent[];
  const info=await inspectSession(directory);
  if(info.session.status==='authentication')throw new SessionError('AUTHENTICATION_PRIVATE');
  const config=await readJson<SessionConfig>(join(directory,'config.json'));
  if(!['agent-reviewable','agent-reviewable-synthetic'].includes(config.mediaReview??''))throw new SessionError('MEDIA_REVIEW_NOT_AUTHORIZED');
  if(info.live)events=info.events??[];
  else events=await readJson<SessionEvent[]>(join(directory,'events.json')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
  return events.filter(event=>event.kind==='download').map(event=>({...event.detail,eventId:event.eventId,pageId:event.pageId,actionId:event.actionId}));
}
