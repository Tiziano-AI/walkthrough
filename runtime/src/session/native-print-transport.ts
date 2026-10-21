import type {CDPSession} from 'playwright';
import {SessionError} from './contracts.ts';

export type NativeTargetInfo={targetId:string;type:string;url:string;title?:string;browserContextId?:string};
export type TargetRoot=Pick<CDPSession,'send'|'on'|'off'>;
export type TargetConnection={send:(method:string,params?:Record<string,unknown>)=>Promise<any>;detach:()=>Promise<void>};

/** A deadline bounds observation, not the underlying effect. Callers retain
 * the original operation and never interpret this rejection as cancellation. */
export async function awaitNativeOperation<T>(operation:Promise<T>,code:string,timeoutMs=5000):Promise<T>{
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SessionError(code,'The original operation has not settled. Close the owned session; do not repeat the print.')),timeoutMs);})]);}
  finally{if(timer)clearTimeout(timer);}
}

/** Private transport to one observed target, never a caller-supplied CDP API.
 * Non-flat attachment is required for persistent Playwright contexts. */
export async function attachNativeTarget(root:TargetRoot,targetId:string):Promise<TargetConnection>{
  const {sessionId}=await root.send('Target.attachToTarget',{targetId,flatten:false});
  let sequence=0,detached=false;
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  const fail=(error:Error)=>{for(const call of pending.values()){clearTimeout(call.timer);call.reject(error);}pending.clear();};
  const receive=(event:{sessionId:string;message:string})=>{
    if(event.sessionId!==sessionId)return;
    let message:any;try{message=JSON.parse(event.message);}catch{fail(new SessionError('NATIVE_PRINT_PROTOCOL_INVALID'));return;}
    const call=pending.get(message.id);if(!call)return;pending.delete(message.id);clearTimeout(call.timer);
    if(message.error)call.reject(new SessionError('NATIVE_PRINT_PROTOCOL_FAILED',String(message.error.message)));
    else call.resolve(message.result??{});
  };
  const gone=(event:{sessionId:string})=>{if(event.sessionId===sessionId){detached=true;fail(new SessionError('NATIVE_PRINT_TARGET_CLOSED'));}};
  root.on('Target.receivedMessageFromTarget',receive);root.on('Target.detachedFromTarget',gone);
  return {
    send(method,params={}){
      if(detached)return Promise.reject(new SessionError('NATIVE_PRINT_TARGET_CLOSED'));
      const id=++sequence;
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(id);reject(new SessionError('NATIVE_PRINT_PROTOCOL_TIMEOUT','The target response is unknown. Inspect the original action; do not repeat the print.'));},15000);
        pending.set(id,{resolve,reject,timer});
        void root.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(error=>{
          const call=pending.get(id);if(call){pending.delete(id);clearTimeout(call.timer);call.reject(error);}
        });
      });
    },
    async detach(){
      root.off('Target.receivedMessageFromTarget',receive);root.off('Target.detachedFromTarget',gone);
      if(!detached){detached=true;fail(new SessionError('NATIVE_PRINT_TARGET_DETACHED'));await root.send('Target.detachFromTarget',{sessionId});}
    },
  };
}

export async function evaluateNative<T>(target:TargetConnection,expression:string):Promise<T>{
  const result=await target.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw new SessionError('NATIVE_PRINT_INSPECTION_FAILED',result.exceptionDetails.text??'Native inspection failed.');
  return result.result.value as T;
}

/** Chromium exposes no print opener. This intentionally weaker association is
 * explicit in the public contract: exclusive expected input, same browser
 * context, one newly created preview, no pre-existing preview adoption. */
export function printCandidate(targets:NativeTargetInfo[],baseline:Set<string>,contextId:string){
  const previews=targets.filter(target=>target.url==='chrome://print/'&&target.type==='page'&&target.browserContextId===contextId&&!baseline.has(target.targetId));
  if(previews.length>1)throw new SessionError('NATIVE_PRINT_AMBIGUOUS','More than one native preview appeared. None is adopted; inspect and close the session without repeating input.');
  return previews[0];
}
