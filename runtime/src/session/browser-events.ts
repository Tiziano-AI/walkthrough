import {randomUUID} from 'node:crypto';
import type {Disposable,Frame,Page} from 'playwright';
import type {InputEvent} from './events.ts';
import {SessionError} from './contracts.ts';

type NativeEvent=Omit<InputEvent,'atMs'|'clockUncertaintyMs'|'gesture'>&{epochMs:number};
type Packet={documentId:string;sequence:number;event:NativeEvent};
type DocumentEvents={frame:Frame;sequence:number;pending:Packet[];clock?:{offset:number;uncertainty:number};box:{x:number;y:number}|null};
type Receipt={matches:(packet:Packet)=>boolean;accept:()=>void;cancel:(error:unknown)=>void};

/** Native listeners export evidence while their document still exists. A
 * departing document is never evaluated to retrieve an already-sent gesture. */
export function createBrowserEvents(page:Page,emit:(event:InputEvent)=>void|Promise<void>,options:{now:()=>number;gesture:()=>InputEvent['gesture'];receiptTimeoutMs?:number}){
  const key=`__walkthroughSessionInput_${randomUUID().replaceAll('-','')}`,bindingName=`${key}_send`;
  const documents=new Map<string,DocumentEvents>(),frames=new Map<Frame,string>(),receipts=new Set<Receipt>();
  const failures:unknown[]=[];
  let binding:Disposable|undefined,disposed=false,queue=Promise.resolve();
  const evidenceLost=()=>new SessionError('SESSION_INPUT_EVIDENCE_LOST','Native input completed without its expected browser evidence. Observe the outcome; do not replay this action.');
  function retain(document:DocumentEvents,packet:Packet){
    if(packet.sequence!==document.sequence+1){failures.push(evidenceLost());return;}
    document.sequence=packet.sequence;
    if(!document.clock){document.pending.push(packet);return;}
    const {epochMs,...native}=packet.event,gesture=options.gesture(),clock=document.clock,box=document.box;
    const event:InputEvent={...native,atMs:epochMs+clock.offset,clockUncertaintyMs:clock.uncertainty,
      ...(gesture&&native.kind.startsWith('pointer')?{gesture}:{}),
      ...(native.x!==undefined&&box?{x:native.x+box.x,y:native.y!+box.y}:{})};
    // Queue the original payload before acknowledging receipt. Sink failures
    // are retained independently so the remaining native events still arrive.
    queue=queue.then(()=>emit(event)).catch(error=>{failures.push(error);});
    for(const receipt of receipts)if(receipt.matches(packet))receipt.accept();
  }
  async function ready(){
    if(disposed)throw new SessionError('SESSION_INPUT_DISABLED');
    binding??=await page.exposeBinding(bindingName,({frame},packet:Packet)=>{
      if(disposed)return;
      const document=packet&&documents.get(packet.documentId);
      if(document&&document.frame===frame)retain(document,packet);
    });
    for(const frame of page.frames()){
      const documentId=randomUUID(),candidate:DocumentEvents={frame,sequence:0,pending:[],box:null};
      documents.set(documentId,candidate);
      try{
        candidate.box=frame.parentFrame()?await (await frame.frameElement()).boundingBox():null;
        const before=options.now();
        const clock=await frame.evaluate(({key,bindingName,documentId})=>{
          const scope=window as any;
          if(!scope[key]){
            const collector={documentId,sequence:0,remove:()=>{}};
            const collect=(event:Event)=>{
              if(!event.isTrusted&&event.type!=='input')return;
              const p=event as PointerEvent,w=event as WheelEvent;
              // Invoke the native binding synchronously in the capture listener,
              // before an application handler can retire this document.
              void scope[bindingName]({documentId,sequence:++collector.sequence,event:{
                kind:event.type.startsWith('key')?'keyboard':event.type,phase:event.type==='keydown'?'down':event.type==='keyup'?'up':undefined,
                epochMs:performance.timeOrigin+event.timeStamp,source:'browser',trusted:event.isTrusted,
                ...(event.type.startsWith('pointer')||event.type==='wheel'?{x:p.clientX,y:p.clientY,button:p.button,buttons:p.buttons}:{}),
                ...(event.type==='wheel'?{deltaX:w.deltaX,deltaY:w.deltaY,deltaMode:w.deltaMode}:{}),
                ...(event.type==='input'?{inputType:(event as unknown as {inputType?:string}).inputType??'programmatic'}:{}),
                altKey:p.altKey,ctrlKey:p.ctrlKey,metaKey:p.metaKey,shiftKey:p.shiftKey,
              }}).catch(()=>{});
            };
            const kinds=['pointermove','pointerdown','pointerup','wheel','keydown','keyup','input','scroll'];
            for(const kind of kinds)window.addEventListener(kind,collect,true);
            const remove=()=>{for(const kind of kinds)window.removeEventListener(kind,collect,true);window.removeEventListener('pagehide',remove);delete scope[key];};
            collector.remove=remove;window.addEventListener('pagehide',remove,{once:true});scope[key]=collector;
          }
          return {documentId:scope[key].documentId,epoch:performance.timeOrigin+performance.now()};
        },{key,bindingName,documentId});
        const after=options.now(),document=documents.get(clock.documentId);
        if(!document)throw evidenceLost();
        if(clock.documentId!==documentId)documents.delete(documentId);
        document.box=candidate.box;
        document.clock??={offset:(before+after)/2-clock.epoch,uncertainty:(after-before)/2};
        frames.set(frame,clock.documentId);
        // No author input is dispatched until calibration completes, but retain
        // any browser events emitted during installation rather than dropping them.
        const pending=document.pending.splice(0);document.sequence-=pending.length;
        for(const packet of pending)retain(document,packet);
      }catch(error){documents.delete(documentId);if(!frame.isDetached()&&!page.isClosed())throw error;}
    }
  }
  async function receipt<T>(matches:Receipt['matches'],send:()=>Promise<T>):Promise<T>{
    if(disposed)throw new SessionError('SESSION_INPUT_DISABLED');
    let arrived=false,settle!:(error?:unknown)=>void,timer:ReturnType<typeof setTimeout>|undefined;
    const received=new Promise<void>((resolve,reject)=>{settle=error=>error===undefined?resolve():reject(error);});
    // Cancellation can precede awaiting this promise when the input API throws.
    void received.catch(()=>{});
    const receipt:Receipt={matches,
      accept:()=>{arrived=true;receipts.delete(receipt);settle();},cancel:error=>{receipts.delete(receipt);settle(error);}};
    receipts.add(receipt);
    try{
      const result=await send();
      // Input acknowledgement is not a binding-delivery barrier. Wait for the
      // matching native receipt, even when navigation has already finished.
      if(!arrived)timer=setTimeout(()=>receipt.cancel(evidenceLost()),options.receiptTimeoutMs??10000);
      await received;return result;
    }finally{clearTimeout(timer);receipts.delete(receipt);}
  }
  async function clickInput<T>(kind:'pointerdown'|'pointerup',send:()=>Promise<T>):Promise<T>{
    // This fences the pointer-event prefix, not later events emitted by an
    // application handler before navigation. Those still stream independently.
    const eligible=new Set(frames.values());
    return receipt(packet=>eligible.has(packet.documentId)&&packet.event.kind===kind,send);
  }
  async function checkpoint(requiredFrames:Frame[]=[]){
    // An API call need not emit an event (unchanged coordinates, prevented text,
    // native HTML drag/drop). Fence the sequence actually emitted instead.
    for(const [frame,documentId] of frames){
      try{
        const watermark=await frame.evaluate(key=>{
          const collector=(window as any)[key];
          return collector?{documentId:collector.documentId,sequence:collector.sequence}:null;
        },key);
        if(watermark?.documentId!==documentId){if(requiredFrames.includes(frame))throw evidenceLost();continue;}
        const document=documents.get(documentId)!;
        if(document.sequence<watermark.sequence)await receipt(packet=>packet.documentId===documentId&&packet.sequence>=watermark.sequence,async()=>{});
      }catch(error){
        if(requiredFrames.includes(frame))throw evidenceLost();
        if(!frame.isDetached()&&!page.isClosed())throw error;
      }
    }
    await flush();
  }
  async function flush(){
    let pending:Promise<void>;
    do{pending=queue;await pending;}while(pending!==queue);
    const errors=failures.splice(0);
    if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'SESSION_INPUT_EVIDENCE_FAILED');
  }
  async function dispose(){
    if(disposed)return;disposed=true;
    for(const receipt of receipts)receipt.cancel(new SessionError('SESSION_INPUT_DISABLED'));
    await Promise.all(page.frames().map(frame=>frame.evaluate(key=>(window as any)[key]?.remove(),key).catch(()=>{})));
    await binding?.dispose();await flush();documents.clear();frames.clear();
  }
  return {ready,clickInput,checkpoint,flush,dispose};
}
