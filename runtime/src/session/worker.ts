import {createServer,type Socket} from 'node:net';
import {chmod,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {SessionRuntime} from './runtime.ts';
import {SessionError,sessionError,type SessionConfig,type SessionInfo} from './contracts.ts';
import {actionPath,infoPath,readAction,readJson,saveInfo,timestamp,writeJson} from './journal.ts';
import {retainWorkerIdentity} from './process.ts';

const directory=process.argv[2];
let runtime:SessionRuntime|undefined,server:ReturnType<typeof createServer>|undefined,stopping=false;
const connections=new Set<Socket>();
async function shutdown(reason:string){
  if(stopping)return;stopping=true;
  let failure:unknown;
  try{await runtime?.close(reason);}catch(error){failure=error;}
  for(const socket of connections)socket.end();
  if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  if(runtime&&!failure)await unlink(runtime.info.socketPath).catch(()=>{});
  process.exitCode=failure?1:0;
}
try{
  const config=await readJson<SessionConfig>(join(directory,'config.json'));
  const info=await readJson<SessionInfo>(infoPath(directory));
  if(!info.workerToken||process.argv[3]!==info.workerToken)throw new SessionError('SESSION_WORKER_IDENTITY_MISMATCH');
  await retainWorkerIdentity(info);await saveInfo(info);
  runtime=await SessionRuntime.open(config,info,{onClosed:()=>{if(!stopping)setImmediate(()=>{void shutdown('runtime-closed');});}});
  const owned=runtime;
  server=createServer(socket=>{
    connections.add(socket);socket.once('close',()=>connections.delete(socket));
    let buffer='',dispatched=false;
    socket.setTimeout(65000,()=>socket.destroy());
    socket.on('error',()=>{});
    socket.on('data',(chunk:Buffer)=>{
      if(dispatched)return;
      buffer+=chunk.toString();if(Buffer.byteLength(buffer)>1024*1024){socket.destroy();return;}
      const end=buffer.indexOf('\n');if(end<0)return;dispatched=true;
      void (async()=>{
        let close=false;
        try{
          const request=JSON.parse(buffer.slice(0,end));
          if(request.version!==1||request.sessionId!==owned.info.sessionId||request.workerToken!==owned.info.workerToken)throw new SessionError('SESSION_PROTOCOL_MISMATCH');
          let result:unknown;
          switch(request.method){
            case 'info':result=owned.info;break;
            case 'inspect':result=await owned.inspect();break;
            case 'observe':result=await owned.observe(request.params);break;
            case 'dispatch':result=await owned.dispatch(request.params);break;
            case 'capture':result=await owned.captureCommand(request.params);break;
            case 'resolve':{
              const {id,resolution}=request.params;
              if(!resolution||!['effect-observed','no-effect-observed','uncertain'].includes(resolution.outcome)||typeof resolution.note!=='string'||!resolution.note.trim()||resolution.note.length>10000)throw new SessionError('INVALID_ACTION_RESOLUTION');
              result=await owned.resolveAction(id,resolution);break;
            }
            case 'close':await owned.close();result=owned.info;close=true;break;
            default:throw new SessionError('UNKNOWN_SESSION_METHOD');
          }
          socket.end(JSON.stringify({ok:true,result})+'\n');
        }catch(error){socket.end(JSON.stringify({ok:false,error:sessionError(error)})+'\n');}
        if(close)setImmediate(()=>{void shutdown('closed-by-user');});
      })();
    });
  });
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(info.socketPath,()=>{server!.off('error',reject);resolve();});});
  await chmod(info.socketPath,0o600);
  process.once('SIGTERM',()=>{void shutdown('signal-SIGTERM');});
  process.once('SIGINT',()=>{void shutdown('signal-SIGINT');});
}catch(error){
  try{
    if(runtime)await runtime.close('worker-failed');
    else{const info=await readJson<SessionInfo>(infoPath(directory));info.status='interrupted';info.closeReason=sessionError(error).code+': '+sessionError(error).message;await saveInfo(info);}
  }catch{}
  console.error(JSON.stringify({error:sessionError(error)}));process.exitCode=1;
}
