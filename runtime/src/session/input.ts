import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import type {Frame,Page} from 'playwright';
import {deliberatePacing,type InputEvent,type InteractionPacing,type Point} from './events.ts';
import {SessionError,type ResolvedTarget} from './contracts.ts';
import {createBrowserEvents} from './browser-events.ts';

/** Keep the original input failure as the public error; release/evidence
 * failures remain attached rather than replacing the reason input stopped. */
export function inputCleanupFailure(primary:unknown,cleanup:unknown):unknown{
  const original=primary instanceof Error?primary:new Error(String(primary));
  return Object.assign(new AggregateError([primary,cleanup],`${original.message}; input cleanup also failed: ${cleanup instanceof Error?cleanup.message:String(cleanup)}`,{cause:primary}),
    {name:original.name,...('code'in original?{code:original.code}:{})});
}

/** Same 60 Hz minimum-jerk approach as the acquisition driver, now accepting
 * retained handles and screenshot coordinates (including cross-origin frames).
 * Browser event timestamps are measured against the recorder's Node clock. */
export function createSessionInput(page:Page,emit:(event:InputEvent)=>void|Promise<void>,options:Partial<InteractionPacing>={},control:{now?:()=>number;signal?:AbortSignal;receiptTimeoutMs?:number}={}){
  const pacing={...deliberatePacing,...options};
  const now=control.now??(()=>performance.now());
  if(Object.values(pacing).some(value=>!Number.isFinite(value)||value<0))throw new SessionError('INVALID_INTERACTION_PACING');
  const chooserWaits=new Set<AbortController>();
  let pointer:Point={x:0,y:0},disposed=false,gesture:'drag'|undefined;
  let evidence:ReturnType<typeof createBrowserEvents>|undefined;
  const check=()=>{if(disposed)throw new SessionError('SESSION_INPUT_DISABLED');control.signal?.throwIfAborted();};
  const wait=async(ms:number)=>{check();await delay(ms,undefined,{signal:control.signal});check();};
  const record=async(kind:InputEvent['kind'],phase?:InputEvent['phase'],extra:Partial<InputEvent>={})=>emit({kind,phase,atMs:now(),source:'driver',...extra});
  const clickInput=<T>(kind:'pointerdown'|'pointerup',send:()=>Promise<T>)=>evidence?evidence.clickInput(kind,send):send();
  async function ready(){
    check();
    evidence??=createBrowserEvents(page,emit,{now,gesture:()=>gesture,receiptTimeoutMs:control.receiptTimeoutMs});
    await evidence.ready();
  }
  async function flush(cleanup=false,requiredFrames?:Frame[]){
    if(!cleanup)check();
    if(requiredFrames)await evidence?.checkpoint(requiredFrames);else await evidence?.flush();
  }
  async function move(to:Point,durationMs?:number){
    check();const from={...pointer},duration=durationMs??pacing.minimumApproachMs+Math.hypot(to.x-from.x,to.y-from.y)*pacing.distanceMsPerPixel;
    const intervalMs=1000/60;let sample=0,next=now();
    while(true){
      const remaining=next-now();if(remaining>0)await wait(remaining);
      // Receiver and scheduler stalls extend the movement; they never consume
      // undispatched trajectory samples or accelerate the remaining path.
      check();const at=now(),progress=duration===0?1:Math.min(1,sample*intervalMs/duration),eased=progress**3*(10+progress*(-15+6*progress));
      pointer={x:from.x+(to.x-from.x)*eased,y:from.y+(to.y-from.y)*eased};
      await page.mouse.move(pointer.x,pointer.y);
      if(progress>=1)break;
      sample++;next=at+intervalMs;
    }
  }
  async function approach(target:ResolvedTarget){
    check();await target.verifyPointer();await move(target.point);await wait(pacing.targetDwellMs);await target.verifyPointer();
  }
  async function click(target:ResolvedTarget,button:'left'|'middle'|'right'='left',clickCount=1,modifiers:Array<'Alt'|'Control'|'Meta'|'Shift'>=[]){
    await approach(target);const held:string[]=[];let pressed=false,count=1,failure:{error:unknown}|undefined;
    try{
      for(const modifier of modifiers){check();held.push(modifier);await page.keyboard.down(modifier);}
      for(count=1;count<=clickCount;count++){
        check();await target.verifyPointer();check();
        // A rejected down may already have reached the browser. Retain release
        // custody before dispatch rather than relying on a successful response.
        pressed=true;await clickInput('pointerdown',()=>page.mouse.down({button,clickCount:count}));await wait(50);
        await clickInput('pointerup',async()=>{await page.mouse.up({button,clickCount:count});pressed=false;});
      }
    }catch(error){failure={error};throw error;}finally{
      const errors:unknown[]=[];
      if(pressed)try{await page.mouse.up({button,clickCount:count});}catch(error){errors.push(error);}
      for(const modifier of held.reverse())try{await page.keyboard.up(modifier);}catch(error){errors.push(error);}
      // Plain clicks keep caller-owned flushing, including upload controls that
      // navigate before their file chooser can be reconciled. Modified clicks
      // checkpoint emitted releases; an empty Node queue is not their barrier.
      if(modifiers.length)try{await flush(true,[]);}catch(error){errors.push(error);}
      const cleanup=errors.length===1?errors[0]:errors.length?new AggregateError(errors,'SESSION_INPUT_RELEASE_FAILED'):undefined;
      if(errors.length)throw failure?inputCleanupFailure(failure.error,cleanup):cleanup;
    }
  }
  async function text(target:ResolvedTarget,text:string,mode:'type'|'insert'|'replace'='type'){
    await click(target);await record(mode==='type'?'keyboard':'paste','start');
    if(mode==='replace')await focusedKeys(target,process.platform==='darwin'?'Meta+A':'Control+A');
    if(mode==='type')for(const character of text){check();await verifyFocus(target);await page.keyboard.type(character);await wait(pacing.keyDelayMs);}
    else{await verifyFocus(target);await page.keyboard.insertText(text);}
    await flush(false,[]);
    await record(mode==='type'?'keyboard':'paste','end');
  }
  async function keys(target:ResolvedTarget|undefined,keys:string){
    if(target){await target.verifyKeyboard();if(target.element)await target.element.focus();else await click(target);}
    await focusedKeys(target,keys);
  }
  async function focusedKeys(target:ResolvedTarget|undefined,keys:string){
    const frame=target?.element?await target.element.ownerFrame():page.mainFrame();
    const pieces=keys.split('+');let key=pieces.pop()!;
    if(key===''&&pieces.at(-1)===''){pieces.pop();key='+';}
    if(!key||pieces.some(part=>!['Alt','Control','Meta','Shift','ControlOrMeta'].includes(part)))throw new SessionError('INVALID_KEYS','Use a key or a modifier chord such as Shift+ArrowRight.');
    const modifiers=pieces.map(part=>part==='ControlOrMeta'?process.platform==='darwin'?'Meta':'Control':part),held:string[]=[];
    let pressed=false,failure:{error:unknown}|undefined;
    await record('keyboard','start');
    try{
      if(target)await verifyFocus(target);
      for(const modifier of modifiers){held.push(modifier);await page.keyboard.down(modifier);if(target)await verifyFocus(target);}
      pressed=true;await page.keyboard.down(key);await wait(pacing.keyDelayMs);
    }catch(error){failure={error};throw error;}finally{
      const failures:unknown[]=[];
      if(pressed)try{await page.keyboard.up(key);}catch(error){failures.push(error);}
      for(const modifier of held.reverse())try{await page.keyboard.up(modifier);}catch(error){failures.push(error);}
      try{await flush(true,frame?[frame]:[]);}catch(error){failures.push(error);}
      const cleanup=failures.length===1?failures[0]:failures.length?new AggregateError(failures,'SESSION_INPUT_RELEASE_FAILED'):undefined;
      if(failures.length)throw failure?inputCleanupFailure(failure.error,cleanup):cleanup;
    }
    await record('keyboard','end');
  }
  async function verifyFocus(target:ResolvedTarget){
    await target.verifyKeyboard();
    if(target.element&&!await target.element.evaluate(element=>(element.getRootNode() as Document|ShadowRoot).activeElement===element))throw new SessionError('ELEMENT_LOST_FOCUS');
  }
  async function drag(from:ResolvedTarget,to:ResolvedTarget,options:{button?:'left'|'middle'|'right';modifiers?:string[];durationMs?:number}){
    await approach(from);await to.verifyPointer();await flush(false,[]);const button=options.button??'left',held:string[]=[];let pressed=false,failure:{error:unknown}|undefined;gesture='drag';
    const frames=(await Promise.all([from,to].map(target=>target.element?target.element.ownerFrame():page.mainFrame()))).filter((frame):frame is Frame=>!!frame);
    try{
      for(const modifier of options.modifiers??[]){held.push(modifier);await page.keyboard.down(modifier);}
      await from.verifyPointer();pressed=true;await page.mouse.down({button});await move(to.point,options.durationMs);await to.verifyPointer();
    }catch(error){failure={error};throw error;}finally{
      const errors:unknown[]=[];
      if(pressed)try{await page.mouse.up({button});}catch(error){errors.push(error);}
      for(const key of held.reverse())try{await page.keyboard.up(key);}catch(error){errors.push(error);}
      try{await flush(true,frames);}catch(error){errors.push(error);}finally{gesture=undefined;}
      const cleanup=errors.length===1?errors[0]:errors.length?new AggregateError(errors,'SESSION_INPUT_RELEASE_FAILED'):undefined;
      if(errors.length)throw failure?inputCleanupFailure(failure.error,cleanup):cleanup;
    }
  }
  async function dispose(){
    if(disposed)return;disposed=true;
    for(const wait of chooserWaits)wait.abort(new SessionError('SESSION_INPUT_DISABLED'));
    await evidence?.dispose();
  }
  return {ready,flush:()=>flush(),dispose,click,text,keys,drag,async hover(target:ResolvedTarget){await approach(target);await flush(false,[]);},currentPointer:()=>({...pointer}),async samplePointer(){await ready();await page.mouse.move(pointer.x,pointer.y);await flush(false,[]);},
    async wheel(target:ResolvedTarget,deltaX:number,deltaY:number){await approach(target);await page.mouse.wheel(deltaX,deltaY);await flush(false,[]);},
    async select(target:ResolvedTarget,values:string[]){if(!target.element)throw new SessionError('ELEMENT_REF_REQUIRED');await target.verifyPointer();await record('select','start');await target.element.selectOption(values);await flush(false,[]);await record('select','end');},
    async upload(target:ResolvedTarget,files:Array<{name:string;mimeType:string;buffer:Buffer}>,fileInput:boolean){
      check();if(!target.element)throw new SessionError('ELEMENT_REF_REQUIRED');
      await target.verifyPointer();await record('upload','start');
      if(fileInput)await target.element.setInputFiles(files);
      else{
        const frame=await target.element.ownerFrame();if(!frame)throw new SessionError('FILE_CHOOSER_TARGET_MISMATCH');
        const document=await frame.evaluateHandle(()=>globalThis.document),controller=new AbortController();
        const changed=()=>controller.abort(new SessionError('FILE_CHOOSER_DOCUMENT_CHANGED','The upload document changed before file selection completed. Inspect the original action; no later document will receive these files.'));
        const navigated=(current:Frame)=>{
          if(current===frame)void document.evaluate(original=>original===globalThis.document).then(same=>{if(!same)changed();},changed);
        };
        const detached=(current:Frame)=>{if(current===frame)changed();};
        const closed=()=>controller.abort(new SessionError('FILE_CHOOSER_PAGE_CLOSED','The upload page closed before file selection completed.'));
        const abort=()=>controller.abort(control.signal?.reason);chooserWaits.add(controller);
        page.on('framenavigated',navigated);page.on('framedetached',detached);page.on('close',closed);
        control.signal?.addEventListener('abort',abort,{once:true});if(control.signal?.aborted)abort();
        // Arm before the real timed click: applications may create a detached
        // file input only in their trusted click handler. Never find a substitute
        // input or inject a click into the document.
        // The click may remain suspended on an author-owned JavaScript dialog.
        // Preserve its chooser listener until the original input can resume.
        const opened=page.waitForEvent('filechooser',{timeout:0,signal:controller.signal}).then(chooser=>({chooser}),error=>({error}));
        let afterClick:typeof opened|undefined;
        try{
          await click(target);
          // Only the missing-chooser phase inherits the browser timeout. Race
          // against the pre-armed waiter so a chooser opened during the click
          // remains the same attempt, without reading private timeout state.
          afterClick=page.waitForEvent('filechooser',{signal:controller.signal}).then(chooser=>({chooser}),error=>({error}));
          const result=await Promise.race([opened,afterClick]);check();controller.signal.throwIfAborted();
          if('error'in result){
            if(result.error instanceof Error&&result.error.name==='TimeoutError')throw new SessionError('FILE_CHOOSER_NOT_OPENED','The upload control was clicked, but no input-backed file chooser arrived. Inspect the original action and application state; do not replay it. Native filesystem picker APIs are not supported.');
            throw result.error;
          }
          const chooser=result.chooser;
          if(chooser.page()!==page||await chooser.element().ownerFrame()!==frame)throw new SessionError('FILE_CHOOSER_TARGET_MISMATCH','The chooser did not belong to the upload control’s page and frame. No files were selected.');
          let sameDocument=false;
          try{sameDocument=await chooser.element().evaluate((element,original)=>element.ownerDocument===original,document);}catch{}
          if(!sameDocument){changed();throw controller.signal.reason;}
          controller.signal.throwIfAborted();
          try{await chooser.setFiles(files,{signal:controller.signal});}
          catch(error){throw new SessionError('FILE_CHOOSER_SELECTION_FAILED',`The chooser opened, but file selection did not complete: ${error instanceof Error?error.message:String(error)}`);}
        }catch(error){controller.signal.throwIfAborted();throw error;}
        finally{
          controller.abort();await Promise.all([opened,afterClick]);
          page.off('framenavigated',navigated);page.off('framedetached',detached);page.off('close',closed);await document.dispose().catch(()=>{});
          control.signal?.removeEventListener('abort',abort);chooserWaits.delete(controller);
        }
      }
      await flush(false,[]);await record('upload','end');
    },
    async navigate(url:string){await record('navigation','start');await page.goto(url,{waitUntil:'domcontentloaded'});await record('navigation','end');},
  };
}
