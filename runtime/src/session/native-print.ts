import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {BrowserContext,CDPSession,Page} from 'playwright';
import {installSlateCover,type CaptureSurface} from '../capture/surface.ts';
import {startRecordingOnSession} from '../capture/chromium.ts';
import {SessionError,type NativePrintState} from './contracts.ts';
import {digest} from './journal.ts';
import {attachNativeTarget,awaitNativeOperation,evaluateNative,printCandidate,type NativeTargetInfo,type TargetConnection} from './native-print-transport.ts';

type BrowserPrintState={width:number;height:number;dpr:number;title:string;state:string;ready:boolean;requestId:number;ticket:unknown;settingsChanged:boolean};
const readState=`(()=>{
  const app=document.querySelector('print-preview-app');
  const area=app?.shadowRoot?.querySelector('print-preview-preview-area');
  if(!area||typeof area.hasTicketChanged_!=='function')throw new Error('NATIVE_PRINT_VERSION_UNSUPPORTED');
  return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,title:document.title,
    state:area.previewState,ready:area.documentReady_===true&&area.pluginLoadComplete_===true,
    requestId:area.inFlightRequestId_,ticket:area.lastTicket_,settingsChanged:area.hasTicketChanged_()};
})()`;
// Chromium 153 button_strip.html.ts -> cancel-requested -> app.ts CLOSING ->
// nativeLayer.dialogClose(true). Target.closeTarget only accepts a request and
// does not perform this constrained dialog's Cancel lifecycle.
const cancelPoint=`(()=>{
  const app=document.querySelector('print-preview-app');
  const sidebar=app?.shadowRoot?.querySelector('print-preview-sidebar');
  const strip=sidebar?.shadowRoot?.querySelector('print-preview-button-strip');
  const button=strip?.shadowRoot?.querySelector('cr-button.cancel-button');
  if(!button||button.disabled)throw new Error('NATIVE_PRINT_CANCEL_UNAVAILABLE');
  const box=button.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2;
  if(box.width<=0||box.height<=0||x<0||y<0||x>=innerWidth||y>=innerHeight)throw new Error('NATIVE_PRINT_CANCEL_UNAVAILABLE');
  let hit=document.elementFromPoint(x,y);
  while(hit?.shadowRoot){const next=hit.shadowRoot.elementFromPoint(x,y);if(!next||next===hit)break;hit=next;}
  if(hit!==button&&!button.contains(hit)&&!button.shadowRoot?.contains(hit))throw new Error('NATIVE_PRINT_CANCEL_OBSCURED');
  return {x,y};
})()`;

type FrameTree={frame:{id:string;url:string;parentId?:string};childFrames?:FrameTree[]};
type PrintFrame=FrameTree['frame']&{pdfUrl:string;previewToken:string};
export function printFrame(tree:FrameTree){
  const frames:PrintFrame[]=[];
  // Pinned plugin_proxy.ts creates this trusted wrapper. browser_api.ts takes
  // its entire query as the PDF stream URL; it is not a query parameter map.
  // Page.getFrameTree omits remote children, so this does not pretend the
  // wrapper's frame ID is the untrusted PDF target's identity.
  const walk=(node:FrameTree)=>{
    const match=/^chrome:\/\/print\/pdf\/index_print\.html\?(chrome-untrusted:\/\/print\/([0-9a-fA-F]{32})\/-?\d+\/print\.pdf)$/.exec(node.frame.url);
    if(match)frames.push({...node.frame,pdfUrl:match[1],previewToken:match[2]});
    for(const child of node.childFrames??[])walk(child);
  };
  if(tree.frame.url==='chrome://print/')for(const child of tree.childFrames??[])walk(child);
  if(frames.length!==1)throw new SessionError('NATIVE_PRINT_FRAME_UNAVAILABLE','The preview must expose exactly one related trusted PDF wrapper. No target is guessed from a browser-wide URL match.');
  return frames[0];
}
export function completedGeneration(state:BrowserPrintState,frame:PrintFrame){
  if(!state.ready||state.state!=='display-preview'||state.settingsChanged||!Number.isSafeInteger(state.requestId)||state.requestId<0||!state.ticket||typeof state.ticket!=='object'||(state.ticket as any).requestID!==state.requestId)
    throw new SessionError('NATIVE_PRINT_NOT_READY','Wait for the current native preview to finish, then observe it again.');
  return {requestId:state.requestId,ticketSha256:digest(state.ticket),previewToken:frame.previewToken,frameId:frame.id};
}
export function requireSameGeneration(expected:NativePrintState['generation'],actual:NativePrintState['generation']){
  if(!expected||!actual||digest(expected)!==digest(actual))throw new SessionError('NATIVE_PRINT_GENERATION_CHANGED','The preview or its settings changed. Observe its completed generation before saving; the original print is not repeated.');
}

/** Only a target discovered during explicitly expected real product input can
 * construct this surface. The scoped inspector follows pinned Chromium state;
 * no public action evaluates caller code or clicks native Save. */
export class NativePrintPreview {
  readonly pageId=`print-${randomUUID()}`;
  readonly documentId=`document-${randomUUID()}`;
  readonly sourcePageId:string;
  readonly actionId:string;
  readonly targetId:string;
  closed=false;
  private root:CDPSession;
  private target:TargetConnection;
  private contextId:string;
  private baseline:Set<string>;
  private closing?:Promise<void>;
  private destroyed:(event:{targetId:string})=>void;
  constructor(input:{root:CDPSession;target:TargetConnection;targetInfo:NativeTargetInfo;sourcePageId:string;actionId:string;contextId:string;baseline:Set<string>}){
    this.root=input.root;this.target=input.target;this.targetId=input.targetInfo.targetId;this.sourcePageId=input.sourcePageId;this.actionId=input.actionId;this.contextId=input.contextId;this.baseline=input.baseline;
    this.destroyed=event=>{if(event.targetId===this.targetId)this.closed=true;};
    this.root.on('Target.targetDestroyed',this.destroyed);
  }
  private async assertTarget(){
    if(this.closed)throw new SessionError('NATIVE_PRINT_TARGET_CLOSED');
    const {targetInfos}=await this.root.send('Target.getTargets');
    const target=printCandidate(targetInfos,this.baseline,this.contextId);
    if(target?.targetId!==this.targetId)throw new SessionError('NATIVE_PRINT_TARGET_CHANGED');
  }
  async inspect():Promise<NativePrintState&{width:number;height:number;dpr:number;title:string}>{
    await this.assertTarget();
    const state=await evaluateNative<BrowserPrintState>(this.target,readState);
    let generation:NativePrintState['generation'];
    if(state.ready&&state.state==='display-preview'&&!state.settingsChanged){const {frameTree}=await this.target.send('Page.getFrameTree');generation=completedGeneration(state,printFrame(frameTree));}
    return {sourcePageId:this.sourcePageId,actionId:this.actionId,sourceBinding:'exclusive-action-and-browser-context',state:state.state,width:state.width,height:state.height,dpr:state.dpr,title:state.title,...(generation?{generation}:{})};
  }
  async prepareGeometry(){
    await this.assertTarget();
    await this.target.send('Emulation.setDeviceMetricsOverride',{width:1600,height:900,deviceScaleFactor:2,mobile:false});
    const dimensions=await evaluateNative<{width:number;height:number;dpr:number}>(this.target,'({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
    if(dimensions.width!==1600||dimensions.height!==900||dimensions.dpr!==2)throw new SessionError('NATIVE_PRINT_GEOMETRY_UNSUPPORTED','Native capture requires measured 1600 by 900 CSS pixels at DPR 2. No rescaling can qualify a different source.');
  }
  captureSurface():CaptureSurface{
    return {
      cover:async()=>{
        await this.prepareGeometry();
        const response=await this.target.send('Runtime.evaluate',{expression:`(${installSlateCover.toString()})()`,awaitPromise:true,returnByValue:false});
        const objectId=response.result?.objectId;
        if(response.exceptionDetails||!objectId)throw new SessionError('NATIVE_PRINT_SLATE_FAILED');
        const invoke=async(functionDeclaration:string,args:any[]=[])=>{
          const result=await this.target.send('Runtime.callFunctionOn',{objectId,functionDeclaration,arguments:args.map(value=>({value})),awaitPromise:true,returnByValue:true});
          if(result.exceptionDetails)throw new SessionError('NATIVE_PRINT_SLATE_FAILED');
        };
        let removed=false;
        return {color:value=>invoke('function(value){return this.color(value);}',[value]),remove:async()=>{if(removed)return;removed=true;try{await invoke('function(){return this.remove();}');}finally{await this.target.send('Runtime.releaseObject',{objectId});}}};
      },
      startRecording:async destination=>startRecordingOnSession(await attachNativeTarget(this.root,this.targetId) as any,destination),
      screenshot:async()=>{await this.assertTarget();const result=await this.target.send('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false});return Buffer.from(result.data,'base64');},
    };
  }
  async pdf(expected:NonNullable<NativePrintState['generation']>){
    requireSameGeneration(expected,(await this.inspect()).generation);
    const {frameTree}=await this.target.send('Page.getFrameTree'),frame=printFrame(frameTree);
    if(frame.id!==expected.frameId||frame.previewToken!==expected.previewToken)throw new SessionError('NATIVE_PRINT_FRAME_CHANGED');
    const {targetInfos}=await this.root.send('Target.getTargets');
    const candidates=targetInfos.filter(target=>target.url===frame.pdfUrl&&target.type==='iframe'&&target.browserContextId===this.contextId&&!this.baseline.has(target.targetId));
    if(candidates.length!==1)throw new SessionError('NATIVE_PRINT_FRAME_UNAVAILABLE','The observed PDF stream must have one new target in this browser context; no unrelated iframe is adopted.');
    const child=candidates[0];
    const connection=await attachNativeTarget(this.root,child.targetId);
    try{
      // InspectorPageAgent omits remote frames from the parent's frame tree,
      // but reports the remote root's actual parentId in its own tree. Verify
      // that relationship before using its default execution context.
      const {frameTree:pdfTree}=await connection.send('Page.getFrameTree') as {frameTree:FrameTree};
      if(pdfTree.frame.parentId!==frame.id||pdfTree.frame.url!==frame.pdfUrl)throw new SessionError('NATIVE_PRINT_FRAME_CHANGED','The PDF target is not a child of the observed trusted preview wrapper.');
      const token=JSON.stringify(expected.previewToken);
      const data=await evaluateNative<string>(connection,`(async()=>{
        const current=new URL(location.href);
        if(current.href!==${JSON.stringify(frame.pdfUrl)}||current.protocol!=='chrome-untrusted:'||current.hostname!=='print'||current.pathname.split('/')[1]!==${token})throw new Error('NATIVE_PRINT_FRAME_CHANGED');
        const response=await fetch('chrome-untrusted://print/'+${token}+'/-1/print.pdf',{cache:'no-store'});
        if(!response.ok||!response.body)throw new Error('NATIVE_PRINT_PDF_UNAVAILABLE');
        const reader=response.body.getReader(),chunks=[];let size=0;
        while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>512*1024*1024){await reader.cancel();throw new Error('DOWNLOAD_SIZE_LIMIT');}chunks.push(value);}
        let binary='';for(const chunk of chunks)for(let offset=0;offset<chunk.length;offset+=32768)binary+=String.fromCharCode(...chunk.subarray(offset,offset+32768));
        return btoa(binary);
      })()`);
      requireSameGeneration(expected,(await this.inspect()).generation);
      return Buffer.from(data,'base64');
    }finally{await connection.detach().catch(()=>{});}
  }
  close():Promise<void>{
    if(this.closed)return Promise.resolve();
    if(this.closing)return this.closing;
    this.closing=(async()=>{
      await awaitNativeOperation(this.assertTarget(),'NATIVE_PRINT_CLOSE_UNCERTAIN');
      const point=await awaitNativeOperation(evaluateNative<{x:number;y:number}>(this.target,cancelPoint),'NATIVE_PRINT_CLOSE_UNCERTAIN');
      let inputError:unknown;
      const send=(type:string)=>awaitNativeOperation(this.target.send('Input.dispatchMouseEvent',{type,...point,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1}),'NATIVE_PRINT_CLOSE_UNCERTAIN');
      await send('mouseMoved');
      // A rejected press may already have reached Chrome. Release it once,
      // while retaining the same close promise for every later caller.
      try{await send('mousePressed');}catch(error){inputError=error;}
      try{await send('mouseReleased');}catch(error){inputError??=error;}
      for(let attempt=0;attempt<50;attempt++){
        if(this.closed)return;
        const {targetInfos}=await awaitNativeOperation(this.root.send('Target.getTargets'),'NATIVE_PRINT_CLOSE_UNCERTAIN');
        if(!targetInfos.some(target=>target.targetId===this.targetId)){this.closed=true;return;}
        await delay(100);
      }
      throw new SessionError('NATIVE_PRINT_CLOSE_UNCERTAIN',`Cancel was attempted once, but the original preview remains present. Close the owned session.${inputError instanceof Error?` ${inputError.message}`:''}`);
    })();return this.closing;
  }
  async dispose(){this.root.off('Target.targetDestroyed',this.destroyed);await this.target.detach().catch(()=>{});await this.root.detach().catch(()=>{});}
}

export async function expectNativePrint(context:BrowserContext,page:Page,sourcePageId:string,actionId:string){
  const root=await context.newCDPSession(page);
  try{
    const {targetInfo:source}=await root.send('Target.getTargetInfo');
    if(!source.browserContextId)throw new SessionError('NATIVE_PRINT_CONTEXT_UNAVAILABLE');
    await root.send('Target.setDiscoverTargets',{discover:true});
    const {targetInfos}=await root.send('Target.getTargets'),baseline=new Set(targetInfos.map(target=>target.targetId));
    let cancelled=false;
    return {cancel:async()=>{cancelled=true;await root.detach().catch(()=>{});},wait:async()=>{
      try{
        for(let attempt=0;attempt<100;attempt++){
          if(cancelled)throw new SessionError('NATIVE_PRINT_EXPECTATION_CLOSED');
          const {targetInfos:current}=await root.send('Target.getTargets');
          const targetInfo=printCandidate(current,baseline,source.browserContextId!);
          if(targetInfo){const target=await attachNativeTarget(root,targetInfo.targetId);return new NativePrintPreview({root,target,targetInfo,sourcePageId,actionId,contextId:source.browserContextId!,baseline});}
          await delay(100);
        }
        throw new SessionError('NATIVE_PRINT_NOT_OBSERVED','No uniquely associated native preview was observed. Inspect the original input and session; do not repeat it under another action ID.');
      }catch(error){await root.detach().catch(()=>{});throw error;}
    }};
  }catch(error){await root.detach().catch(()=>{});throw error;}
}
