import {type BrowserContext,type Dialog,type ElementHandle,type Frame,type Page} from 'playwright';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {constants} from 'node:fs';
import {mkdir,open,readFile,realpath,stat,unlink,writeFile} from 'node:fs/promises';
import {basename,join,resolve,sep} from 'node:path';
import {qualifiedBrowserPath} from '../core/environment.ts';
import {resolveLocalTools} from '../core/toolchain.ts';
import {runtimePaths} from '../core/runtime-paths.ts';
import type {InputEvent} from './events.ts';
import {openSessionBrowser} from './browser.ts';
import {removeSessionMarker,retainProcessGroup} from './process.ts';
import {createSessionCapture} from '../project/capture.ts';
import {loadSourceSet} from '../project/store.ts';
import type {Box,MarkTargetObservation} from '../project/contracts.ts';
import {createSessionInput,inputCleanupFailure} from './input.ts';
import {mediaTypeForFile} from './media-type.ts';
import {expectNativePrint,NativePrintPreview,requireSameGeneration} from './native-print.ts';
import {awaitNativeOperation} from './native-print-transport.ts';
import {retainPrintArtifact,verifiedPdfArtifact} from './print-artifact.ts';
import {actionPath,digest,privateDirectory,readAction,readJson,saveInfo,timestamp,validId,writeJson} from './journal.ts';
import {SessionError,sessionError,type ActionRecord,type ActionRequest,type CaptureMarkTarget,type CaptureRequest,type ElementRef,type Observation,type ObserveOptions,type PageInfo,type ResolvedTarget,type SessionAction,type SessionClosePhase,type SessionConfig,type SessionEvent,type SessionInfo,type SessionRuntimeOptions,type SessionTarget} from './contracts.ts';

const isWithin=(root:string,path:string)=>path===root||path.startsWith(root+sep);
const loopback=(hostname:string)=>hostname==='localhost'||hostname==='[::1]'||/^127(?:\.\d{1,3}){3}$/.test(hostname);
type DocumentRef={id:string;handle:import('playwright').JSHandle<Document>};
type StoredRef={description:ElementRef;page:Page;frame:Frame;document:DocumentRef;element:ElementHandle<HTMLElement|SVGElement>};
type Surface={page:Page;frame:Frame;document:DocumentRef;width:number;height:number};
type FramingObservation={observation:Observation;views:Array<{frame:Frame;document:DocumentRef;view:string}>};
const interactive='button,a[href],input,textarea,select,summary,[role],[tabindex],canvas,[contenteditable="true"],iframe';
// Read scroll/viewport geometry without installing listeners or touching input.
// A screenshot rectangle cannot be safely reused after a nested scroller moves.
const framingView=(frame:Frame)=>frame.evaluate(()=>JSON.stringify({width:innerWidth,height:innerHeight,x:scrollX,y:scrollY,
  visual:visualViewport?{x:visualViewport.offsetLeft,y:visualViewport.offsetTop,width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}:null,
  scrolled:[...document.querySelectorAll('*')].flatMap((element,index)=>element.scrollLeft||element.scrollTop?[{index,x:element.scrollLeft,y:element.scrollTop}]:[])}));
const visibleBox=(box:Box|null,width:number,height:number):box is Box=>!!box&&[box.x,box.y,box.width,box.height].every(Number.isFinite)&&box.x>=0&&box.y>=0&&box.width>0&&box.height>0&&box.x+box.width<=width&&box.y+box.height<=height;
const sameBox=(left:Box,right:Box)=>left.x===right.x&&left.y===right.y&&left.width===right.width&&left.height===right.height;
const unclippedElement=(element:ElementHandle<Node>)=>element.evaluate(element=>{
  if(!(element instanceof Element))return false;
  const box=element.getBoundingClientRect();
  if(box.left<0||box.top<0||box.right>innerWidth||box.bottom>innerHeight)return false;
  for(let current:Element|null=element;current;){
    const style=getComputedStyle(current);if(style.visibility!=='visible'||Number(style.opacity)===0)return false;
    if(current!==element){
      const clip=current.getBoundingClientRect();
      if(/^(auto|scroll|hidden|clip)$/.test(style.overflowX)&&(box.left<clip.left||box.right>clip.right))return false;
      if(/^(auto|scroll|hidden|clip)$/.test(style.overflowY)&&(box.top<clip.top||box.bottom>clip.bottom))return false;
    }
    const root=current.getRootNode();current=current.parentElement??(root instanceof ShadowRoot?root.host:null);
  }
  return true;
});

export class SessionRuntime {
  readonly config:SessionConfig;
  readonly info:SessionInfo;
  readonly events:SessionEvent[]=[];
  readonly inputEvents:InputEvent[]=[];
  private context!:BrowserContext;
  private pages=new Map<string,Page>();
  private pageIds=new Map<Page,string>();
  private frameIds=new Map<Frame,string>();
  private documents=new Map<Frame,DocumentRef>();
  private refs=new Map<string,StoredRef>();
  private surfaces=new Map<string,Surface>();
  private framingObservation?:FramingObservation;
  private dialogs=new Map<string,{dialog:Dialog;pageId:string}>();
  private inputs=new Map<Page,ReturnType<typeof createSessionInput>>();
  private pageInputEvents=new Map<string,InputEvent[]>();
  private prints=new Map<string,NativePrintPreview>();
  private nativeObservations=new Map<string,Observation>();
  private pendingPrintSource?:Page;
  private pendingPrintPreview?:NativePrintPreview;
  private pendingPrintDiscovery?:{record:ActionRecord;save:()=>Promise<void>;completion:Promise<void>;cancel:()=>Promise<void>};
  private capture?:ReturnType<typeof createSessionCapture>;
  private capturePage?:Page;
  private captureNative?:NativePrintPreview;
  private parkedCapture?:{capture:ReturnType<typeof createSessionCapture>;page:Page};
  private captureActive=false;
  private activeAction?:ActionRecord;
  private pendingInput?:{record:ActionRecord;completion:Promise<void>;save?:()=>Promise<void>};
  private dialogWake?:()=>void;
  private queue:Promise<unknown>=Promise.resolve();
  private pendingEvents=new Set<Promise<unknown>>();
  private eventWrites:Promise<void>=Promise.resolve();
  private idleTimer?:NodeJS.Timeout;
  private closing?:Promise<void>;
  private options:SessionRuntimeOptions;
  private marker:string;
  private constructor(config:SessionConfig,info:SessionInfo,options:SessionRuntimeOptions){
    this.config=config;this.info=info;this.options=options;this.marker=join(runtimePaths().activeRoot,`${info.sessionId}.json`);
  }
  static async open(config:SessionConfig,info:SessionInfo,options:SessionRuntimeOptions={}){
    const runtime=new SessionRuntime(config,info,options);
    try{await runtime.initialize();return runtime;}catch(error){await runtime.close('initialization-failed').catch(()=>{});throw error;}
  }
  private async initialize(){
    validateSessionConfig(this.config);
    const {activeRoot}=runtimePaths();
    const profile=this.info.profileDirectory;
    if(typeof profile!=='string'||resolve(profile)!==profile)throw new SessionError('SESSION_PROFILE_UNRESOLVED','The original resolved browser profile is missing or invalid. Inspect this retained session; it cannot launch a browser.');
    await privateDirectory(this.config.directory);
    for(const directory of ['actions','observations','downloads','capture-operations'])await privateDirectory(join(this.config.directory,directory));
    await privateDirectory(activeRoot);
    await writeJson(this.marker,{schemaVersion:1,kind:'session',pid:process.pid,projectPath:this.config.projectPath,sessionId:this.info.sessionId,workerToken:this.info.workerToken,status:'open'});
    if(isWithin(this.config.projectPath,profile))throw new SessionError('AUTH_PROFILE_INSIDE_PROJECT','Keep authentication profiles outside the project evidence directory.');
    await privateDirectory(profile);
    this.context=await openSessionBrowser({profileDirectory:profile,executablePath:this.config.executablePath,headless:this.config.headless,network:this.config.network});
    await retainProcessGroup(this.info);await saveInfo(this.info);
    this.context.setDefaultTimeout(10000);this.context.setDefaultNavigationTimeout(15000);
    await this.context.route('**/*',async route=>{
      const request=route.request();
      let allowed=true;
      try{
        const url=new URL(request.url());
        if(this.config.network==='loopback-only'&&['http:','https:','ws:','wss:'].includes(url.protocol)&&!loopback(url.hostname))allowed=false;
        if(request.isNavigationRequest())allowed&&=this.navigationAllowed(request.url());
      }catch{allowed=false;}
      if(allowed)await route.continue();
      else{
        let pageId='unknown';try{pageId=this.pageIds.get(request.frame().page())??'unknown';}catch{}
        if(this.info.status!=='authentication')this.retainEvent('navigation-blocked',pageId,{url:request.url()});
        await route.abort('blockedbyclient');
      }
    });
    if(this.config.network==='loopback-only')await this.context.routeWebSocket('**/*',route=>{
      try{if(loopback(new URL(route.url()).hostname)){route.connectToServer();return;}}catch{}
      route.close();
    });
    this.context.on('page',page=>this.attachPage(page,true));
    this.context.on('close',()=>{if(!this.closing){void this.close('browser-closed');}});
    // Any tabs restored by Chromium are excluded from observation and selection.
    // The fresh page is the only initial working target.
    for(const page of this.context.pages())await page.close();
    const page=await this.context.newPage();this.attachPage(page,false);
    this.info.selectedPageId=this.pageIds.get(page)!;
    this.info.status='open';this.info.pid=process.pid;await saveInfo(this.info);
    await page.goto(this.config.startUrl,{waitUntil:'domcontentloaded'});
    this.touch();
  }
  private navigationAllowed(raw:string){
    if(raw==='about:blank')return true;
    try{const url=new URL(raw);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&this.config.allowedOrigins.includes(url.origin)&&
      (this.config.network==='web'||loopback(url.hostname));}catch{return false;}
  }
  private attachPage(page:Page,popup:boolean){
    if(this.pageIds.has(page))return;
    const pageId=`page-${randomUUID()}`;this.pages.set(pageId,page);this.pageIds.set(page,pageId);
    page.on('dialog',dialog=>{
      const id=`dialog-${randomUUID()}`;this.dialogs.set(id,{dialog,pageId});
      if(this.info.status!=='authentication')this.retainEvent('dialog',pageId,{dialogId:id,type:dialog.type(),message:dialog.message(),defaultValue:dialog.defaultValue()});
      this.dialogWake?.();
    });
    page.on('download',download=>{
      if(this.info.status==='authentication'){void download.cancel();return;}
      const artifactId=`artifact-${randomUUID()}`,filename=download.suggestedFilename();
      const event=this.retainEvent('download',pageId,{artifactId,downloadId:artifactId,filename,mediaType:mediaTypeForFile(filename),status:'receiving'});
      const work=(async()=>{
        const destination=join(this.config.directory,'downloads',String(event.detail.downloadId));
        try{
          await download.saveAs(destination);
          const file=await open(destination,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
          try{const info=await file.stat();if(!info.isFile()||info.size>512*1024*1024)throw new SessionError('DOWNLOAD_SIZE_LIMIT');bytes=await file.readFile();}finally{await file.close();}
          const retained=await open(destination,'r');try{await retained.chmod(0o400);}finally{await retained.close();}
          event.detail={...event.detail,status:'retained',path:destination,bytes:bytes.length,sha256:digestBytes(bytes)};
        }catch(error){event.detail={...event.detail,status:'failed',error:sessionError(error)};}
        await this.saveEvents();
      })();
      this.track(work);
    });
    page.on('framenavigated',frame=>{this.documents.delete(frame);});
    page.on('close',()=>{
      if(this.info.status!=='authentication')this.retainEvent('page-closed',pageId,{});
      if(this.captureActive&&page===this.capturePage)this.track(this.stopCapture('close'));
    });
    if(popup&&this.info.selectedPageId&&this.info.status!=='authentication')this.retainEvent('popup',pageId,{selected:false});
  }
  private track(work:Promise<unknown>){this.pendingEvents.add(work);void work.catch(()=>{}).finally(()=>this.pendingEvents.delete(work));}
  private retainEvent(kind:SessionEvent['kind'],pageId:string,detail:Record<string,unknown>,action=this.activeAction){
    const event:SessionEvent={eventId:`event-${randomUUID()}`,kind,at:timestamp(),pageId,detail,...(action?{actionId:action.actionId}:{})};
    this.events.push(event);action?.eventIds.push(event.eventId);this.track(this.saveEvents());return event;
  }
  private saveEvents(){
    const snapshot=structuredClone(this.events);
    const next=this.eventWrites.then(()=>writeJson(join(this.config.directory,'events.json'),snapshot));
    this.eventWrites=next.catch(()=>{});return next;
  }
  private touch(){
    clearTimeout(this.idleTimer);
    if(!this.closing)this.idleTimer=setTimeout(()=>{void this.close('idle-limit');},this.config.idleTimeoutMs??30*60*1000);
  }
  private serial<T>(work:()=>Promise<T>):Promise<T>{
    this.touch();const next=this.queue.then(work);this.queue=next.catch(()=>{});return next;
  }
  private assertOpen(observation=false){
    if(this.closing||!['open','authentication'].includes(this.info.status))throw new SessionError('SESSION_NOT_OPEN');
    if(observation&&this.info.status==='authentication')throw new SessionError('AUTHENTICATION_PRIVATE','Observations and recording are disabled. Finish human authentication, then resume explicitly.');
  }
  private page(pageId=this.info.selectedPageId){
    const page=pageId&&this.pages.get(pageId);
    if(!page||page.isClosed())throw new SessionError('SESSION_PAGE_UNAVAILABLE','Observe the page list and explicitly select an open page.');
    return page;
  }
  private async document(frame:Frame){
    const current=this.documents.get(frame);if(current)return current;
    const record={id:`document-${randomUUID()}`,handle:await frame.evaluateHandle(()=>document)};
    this.documents.set(frame,record);return record;
  }
  private frameId(frame:Frame){let id=this.frameIds.get(frame);if(!id){id=`frame-${randomUUID()}`;this.frameIds.set(frame,id);}return id;}
  private async documentCurrent(frame:Frame,document:DocumentRef){
    try{return !frame.isDetached()&&this.documents.get(frame)===document&&await document.handle.evaluate(original=>original===globalThis.document);}catch{return false;}
  }
  private input(page:Page){
    let driver=this.inputs.get(page);
    if(!driver){driver=createSessionInput(page,event=>{this.inputEvents.push(event);this.eventsForPage(this.pageIds.get(page)!).push(event);},this.config.pacing);this.inputs.set(page,driver);}return driver;
  }
  private eventsForPage(id:string){let events=this.pageInputEvents.get(id);if(!events){events=[];this.pageInputEvents.set(id,events);}return events;}
  private selectedPrint(){const preview=this.info.selectedPageId&&this.prints.get(this.info.selectedPageId);return preview&&!preview.closed?preview:undefined;}
  private openPrint(){return [...this.prints.values()].find(preview=>!preview.closed);}
  private pendingPrint(){return this.pendingPrintPreview;}
  private async clearObservationHandles(){
    const handles=[...this.refs.values()].map(ref=>ref.element);this.refs.clear();this.surfaces.clear();this.framingObservation=undefined;
    await Promise.all(handles.map(handle=>handle.dispose().catch(()=>{})));
  }
  private async pageInfo():Promise<PageInfo[]>{
    const privateMode=this.info.status==='authentication'||!['agent-reviewable','agent-reviewable-synthetic'].includes(this.config.mediaReview??'');
    const pages=await Promise.all([...this.pages].map(async([pageId,page])=>({pageId,selected:pageId===this.info.selectedPageId,closed:page.isClosed(),
      ...(!privateMode&&!page.isClosed()?{url:page.url(),title:this.dialogs.size||page===this.pendingPrintSource||this.openPrint()?.sourcePageId===pageId?'':await page.title().catch(()=>'')}:{})})));
    return [...pages,...[...this.prints.values()].map(preview=>({pageId:preview.pageId,selected:preview.pageId===this.info.selectedPageId,closed:preview.closed,kind:'native-print' as const,...(!privateMode?{url:'chrome://print/',title:'Print preview',sourcePageId:preview.sourcePageId,actionId:preview.actionId}:{})}))];
  }
  async inspect(){
    this.touch();await retainProcessGroup(this.info);await saveInfo(this.info);
    const privateMode=this.info.status==='authentication'||!['agent-reviewable','agent-reviewable-synthetic'].includes(this.config.mediaReview??''),capture=this.capture?.inspect();
    return {...this.info,captureActive:this.captureActive||!!this.parkedCapture,pages:await this.pageInfo(),events:privateMode?[]:this.events,capture:capture?{state:capture.state,parkedSourceTakeId:this.parkedCapture?.capture.inspect().take?.id,take:capture.take?{id:capture.take.id,state:capture.take.state,markCount:capture.take.marks.length,hasSource:!!capture.take.source,...(!privateMode?{title:capture.take.title}:{}),...(capture.take.error?{error:capture.take.error}:{})}:null}:null};
  }
  observe(options:ObserveOptions={}):Promise<Observation>{return this.serial(async()=>{
    this.assertOpen(true);
    if(!['agent-reviewable','agent-reviewable-synthetic'].includes(this.config.mediaReview??''))throw new SessionError('MEDIA_REVIEW_NOT_AUTHORIZED');
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['pageId','screenshot','limit','observationId','offset','ref'].includes(key)))throw new SessionError('INVALID_OBSERVATION_OPTIONS');
    const limit=options.limit===undefined?250:options.limit,offset=options.offset===undefined?0:options.offset;
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(offset)||offset<0)throw new SessionError('INVALID_OBSERVATION_LIMIT');
    if(options.screenshot!==undefined&&typeof options.screenshot!=='boolean')throw new SessionError('INVALID_OBSERVATION_OPTIONS');
    if(options.pageId!==undefined&&(typeof options.pageId!=='string'||!options.pageId))throw new SessionError('INVALID_PAGE_ID');
    if(options.ref!==undefined&&!validId(options.ref))throw new SessionError('INVALID_OBSERVATION_REF');
    const optionPage=(ref:ElementRef,start:number,count:number):ElementRef=>{
      if(!ref.options)return ref;
      const {options:retained,optionsNextOffset:_,...description}=ref;
      return {...description,options:retained.slice(start,start+count),optionsOffset:start,...(start+count<retained.length?{optionsNextOffset:start+count}:{})};
    };
    const slice=(observation:Observation):Observation=>{
      const {nextOffset:_,...snapshot}=observation;
      if(options.ref!==undefined){
        const index=observation.refs.findIndex(ref=>ref.ref===options.ref);
        if(index<0)throw new SessionError('OBSERVATION_REF_NOT_FOUND');
        if(!observation.refs[index].options)throw new SessionError('OBSERVATION_REF_NOT_SELECT');
        const ref=optionPage(observation.refs[index],offset,limit);
        return {...snapshot,refs:[ref],offset:index,truncated:!!ref.optionsTruncated||ref.optionsNextOffset!==undefined};
      }
      const refs=observation.refs.slice(offset,offset+limit).map(ref=>optionPage(ref,0,20));
      return {...snapshot,refs,offset,refsTotal:observation.refs.length,truncated:observation.refsTruncated||offset+limit<observation.refs.length||refs.some(ref=>ref.optionsTruncated||ref.optionsNextOffset!==undefined),...(offset+limit<observation.refs.length?{nextOffset:offset+limit}:{})};
    };
    if(options.observationId!==undefined){
      if(!validId(options.observationId)||options.pageId!==undefined)throw new SessionError('INVALID_OBSERVATION_ID');
      const saved=await readJson<Observation>(join(this.config.directory,'observations',`${options.observationId}.json`)).catch(error=>{if(error.code==='ENOENT')throw new SessionError('OBSERVATION_NOT_FOUND');throw error;});
      return slice(saved);
    }
    if(offset!==0||options.ref!==undefined)throw new SessionError('OBSERVATION_ID_REQUIRED','Use the returned observationId to page the same snapshot or read a select reference.');
    const preview=this.prints.get(options.pageId??this.info.selectedPageId??'');
    if(preview)return this.observePrint(preview,options.screenshot!==false);
    const page=this.page(options.pageId),pageId=this.pageIds.get(page)!;
    if(this.pendingPrintSource===page||this.openPrint()?.sourcePageId===pageId)throw new SessionError('NATIVE_PRINT_PENDING','Select the observed native preview; close it explicitly before observing the suspended source.');
    if([...this.dialogs.values()].some(value=>value.pageId===pageId))throw new SessionError('DIALOG_PENDING','Answer the retained dialog before observing its blocked page.');
    const main=page.mainFrame(),document=await this.document(main),viewport=page.viewportSize()!;
    const surfaceId=`surface-${randomUUID()}`;this.surfaces.set(surfaceId,{page,frame:main,document,...viewport});
    const refs:ElementRef[]=[],frames:Observation['frames']=[],views:FramingObservation['views']=[];let truncated=false;
    // Bound the retained option snapshot across all selects without fabricating
    // shortened values. Paging reads these exact bytes, never the live DOM.
    let optionCountRemaining=2000,optionCharactersRemaining=250000;
    for(const frame of page.frames()){
      const doc=await this.document(frame),frameId=this.frameId(frame),parent=frame.parentFrame();
      views.push({frame,document:doc,view:await framingView(frame)});
      frames.push({frameId,documentId:doc.id,url:frame.url(),...(parent?{parentFrameId:this.frameId(parent)}:{})});
      const elements=await frame.locator(interactive).elementHandles() as ElementHandle<HTMLElement|SVGElement>[];
      for(const element of elements){
        if(refs.length>=2000){truncated=true;await element.dispose();continue;}
        const hiddenFile=await element.evaluate(element=>element instanceof HTMLInputElement&&element.type==='file');
        if(!hiddenFile&&!await element.isVisible()){await element.dispose();continue;}
        const description=await element.evaluate((element,budget)=>{
          const input=element as HTMLInputElement,role=element.getAttribute('role')??'';
          const labels=input.labels?[...input.labels].map(label=>label.textContent??'').join(' '):'';
          const labelled=element.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>globalThis.document.getElementById(id)?.textContent??'').join(' ');
          const text=(element.textContent??'').trim().slice(0,1000);
          const select=element instanceof HTMLSelectElement?element:undefined,options:import('./contracts.ts').SelectOption[]=[];
          let characters=0;
          if(select)for(let index=0;index<select.options.length&&options.length<budget.count;index++){
            const option=select.options[index],value=option.value,label=option.label;
            if(characters+value.length+label.length>budget.characters)break;
            characters+=value.length+label.length;
            options.push({index,value,label,disabled:select.matches(':disabled')||option.matches(':disabled'),selected:option.selected});
          }
          return {tag:element.tagName.toLowerCase(),role,name:(element.getAttribute('aria-label')??labelled??labels??'')||element.getAttribute('alt')||element.getAttribute('title')||text,
            text,...(input.type!=='password'&&typeof input.value==='string'?{value:input.value.slice(0,4000)}:{}),
            ...(select?{multiple:select.multiple,options,optionsTotal:select.options.length,optionsRetainedTotal:options.length,optionsTruncated:options.length<select.options.length,optionsOffset:0}:{})};
        },{count:optionCountRemaining,characters:optionCharactersRemaining});
        optionCountRemaining-=description.options?.length??0;
        optionCharactersRemaining-=description.options?.reduce((sum,option)=>sum+option.value.length+option.label.length,0)??0;
        const ref=`ref-${randomUUID()}`,record:ElementRef={ref,pageId,frameId,documentId:doc.id,...description,enabled:await element.isEnabled(),bounds:await element.boundingBox()};
        this.refs.set(ref,{description:record,page,frame,document:doc,element});refs.push(record);
      }
    }
    const observation:Observation={observationId:surfaceId,observedAt:timestamp(),pageId,surfaceId,documentId:document.id,...viewport,coordinateSpace:'css',pages:await this.pageInfo(),frames,refs,truncated,refsTotal:refs.length,refsTruncated:truncated,offset:0,
      text:(await page.locator('body').innerText().catch(()=>'')).slice(0,50000),events:[...this.events]};
    if(options.screenshot!==false){
      observation.screenshotPath=join(this.config.directory,'observations',`${surfaceId}.png`);
      // A CSS-scale CDP screenshot can perturb Chromium's device raster while
      // recording. Retain native pixels and describe their CSS mapping instead.
      const png=await page.screenshot({path:observation.screenshotPath,animations:'allow',caret:'initial',scale:'device'});
      observation.screenshotPixels={width:png.readUInt32BE(16),height:png.readUInt32BE(20)};
    }
    await writeJson(join(this.config.directory,'observations',`${surfaceId}.json`),observation);
    this.framingObservation={observation,views};
    return slice(observation);
  });}
  private async observePrint(preview:NativePrintPreview,screenshot:boolean):Promise<Observation>{
    const state=await preview.inspect(),surfaceId=`surface-${randomUUID()}`;
    const observation:Observation={observationId:surfaceId,observedAt:timestamp(),pageId:preview.pageId,surfaceId,documentId:preview.documentId,width:state.width,height:state.height,coordinateSpace:'css',pages:await this.pageInfo(),
      frames:[{frameId:preview.targetId,documentId:preview.documentId,url:'chrome://print/'}],refs:[],truncated:false,refsTotal:0,refsTruncated:false,offset:0,
      text:`Chrome native print preview: ${state.title}\nState: ${state.state}\n${state.generation?'The current generation is complete.':'The current generation is not ready to save.'}\nNative preview controls are read-only in this authoring surface. Save retains the prepared PDF programmatically; it does not click Save or demonstrate a file chooser.`,events:[...this.events],nativePrint:state};
    if(screenshot){const png=await preview.captureSurface().screenshot();observation.screenshotPath=join(this.config.directory,'observations',`${surfaceId}.png`);await writeFile(observation.screenshotPath,png,{mode:0o600});observation.screenshotPixels={width:png.readUInt32BE(16),height:png.readUInt32BE(20)};}
    this.nativeObservations.set(surfaceId,observation);await writeJson(join(this.config.directory,'observations',`${surfaceId}.json`),observation);return observation;
  }
  private async savePrint(action:Extract<SessionAction,{kind:'save-print-preview'}>){
    const preview=this.prints.get(action.pageId)!,observation=this.nativeObservations.get(action.observationId)!;
    const artifactId=`artifact-${randomUUID()}`;
    const event=this.retainEvent('download',preview.pageId,{artifactId,downloadId:artifactId,filename:action.filename,mediaType:'application/pdf',status:'receiving',origin:'native-print-preview',print:{...observation.nativePrint,targetId:preview.targetId,observationId:action.observationId}});
    this.activeAction!.result={artifactId};
    await writeJson(actionPath(this.config.directory,this.activeAction!.actionId),this.activeAction);await this.saveEvents();
    try{const bytes=await preview.pdf(observation.nativePrint!.generation!);await retainPrintArtifact(this.config.directory,event,bytes,()=>this.saveEvents());}
    catch(error){if(event.detail.status==='receiving'){event.detail={...event.detail,status:'failed',error:sessionError(error)};await this.saveEvents();}throw error;}
  }
  private async openArtifact(artifactId:string){
    const event=this.events.find(event=>event.kind==='download'&&event.detail.artifactId===artifactId);
    if(!event)throw new SessionError('ARTIFACT_NOT_RETAINED');
    const bytes=await verifiedPdfArtifact(this.config.directory,event);
    await this.stopCapture('stop');
    this.activeAction!.result={artifactId};await writeJson(actionPath(this.config.directory,this.activeAction!.actionId),this.activeAction);
    const page=await this.context.newPage();this.attachPage(page,false);
    const pageId=this.pageIds.get(page)!;
    this.activeAction!.result={artifactId,pageId};await writeJson(actionPath(this.config.directory,this.activeAction!.actionId),this.activeAction);
    // This one page owns one intercepted loopback URL. No server, rewritten PDF,
    // application origin, upload or new remote data destination is introduced.
    const url=`http://127.0.0.1/__walkthrough_pdf/${this.info.sessionId}/${artifactId}.pdf`;
    await page.route(url,route=>route.fulfill({status:200,contentType:'application/pdf',headers:{'Content-Length':String(bytes.length),'Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(String(event.detail.filename))}`},body:bytes}));
    this.info.selectedPageId=pageId;this.capture=undefined;this.capturePage=undefined;this.captureNative=undefined;
    await page.goto(url,{waitUntil:'load'});
  }
  private async closePrint(preview:NativePrintPreview){
    // Finish the native slate before closing the target. Closing it first loses
    // the only possible ending calibration for that native take.
    let failure:unknown;
    if(this.captureNative===preview)try{await this.stopCapture('stop');}catch(error){failure=error;}
    try{await preview.close();}catch(error){throw failure?new AggregateError([failure,error],'NATIVE_PRINT_CLOSE_FAILED'):error;}
    // Destruction releases the native dialog; the original product input has
    // its own terminal event. A missing event must leave the recorder parked
    // and let session close reach the owned context, rather than wait forever.
    if(this.pendingInput)await awaitNativeOperation(this.pendingInput.completion,'NATIVE_PRINT_INPUT_UNSETTLED');
    if(this.parkedCapture){
      const parked=this.parkedCapture;this.parkedCapture=undefined;
      this.capture=parked.capture;this.capturePage=parked.page;this.captureNative=undefined;this.captureActive=true;
      try{await this.stopCapture('stop');}catch(error){failure??=error;}
    }else if(this.captureActive&&this.capturePage&&this.pageIds.get(this.capturePage)===preview.sourcePageId)try{await this.stopCapture('stop');}catch(error){failure??=error;}
    const source=this.pages.get(preview.sourcePageId);if(source&&!source.isClosed())try{await this.input(source).flush();}catch(error){failure??=error;}
    this.pendingPrintSource=undefined;this.pendingPrintPreview=undefined;this.pendingPrintDiscovery=undefined;this.info.selectedPageId=preview.sourcePageId;this.captureNative=undefined;
    await preview.dispose();
    if(failure)throw failure;
  }
  /** Unlike input resolution this never scrolls, focuses, moves or reacquires. */
  private async resolveMarkTarget(target:CaptureMarkTarget):Promise<{target:Box;targetObservation:Omit<MarkTargetObservation,'markId'>;verify:()=>Promise<void>}>{
    const preview=this.selectedPrint();
    if(preview){
      const observation=this.nativeObservations.get(target.observationId),pixels=observation?.screenshotPixels;
      if(!observation||observation.pageId!==preview.pageId||this.captureNative!==preview||'ref'in target||!pixels||!observation.screenshotPath)throw new SessionError('NATIVE_PRINT_MARK_OBSERVATION_REQUIRED','Use a screenshot rectangle from a fresh native-preview observation.');
      if(!visibleBox(target.box,pixels.width,pixels.height))throw new SessionError('MARK_TARGET_NOT_VISIBLE');
      const verify=async()=>{const state=await preview.inspect();requireSameGeneration(observation.nativePrint?.generation,state.generation);if(state.width!==observation.width||state.height!==observation.height||!(await preview.captureSurface().screenshot()).equals(await readFile(observation.screenshotPath!)))throw new SessionError('MARK_VIEW_CHANGED');};
      await verify();const box=target.box;
      return {target:{x:box.x*observation.width/pixels.width,y:box.y*observation.height/pixels.height,width:box.width*observation.width/pixels.width,height:box.height*observation.height/pixels.height},targetObservation:{observationId:observation.observationId,observedAt:observation.observedAt,pageId:preview.pageId,frameId:preview.targetId,documentId:preview.documentId,viewport:{width:observation.width,height:observation.height},coordinateSpace:'screenshot',box,screenshotPixels:pixels},verify};
    }
    const current=this.framingObservation;
    if(!current||current.observation.observationId!==target.observationId)throw new SessionError('STALE_MARK_OBSERVATION','Observe the current capture page again, then mark before another action or observation.');
    const {observation,views}=current,surface=this.surfaces.get(observation.surfaceId),page=this.page();
    if(!surface||surface.page!==page||page!==this.capturePage||observation.pageId!==this.info.selectedPageId)throw new SessionError('MARK_TARGET_PAGE_MISMATCH','Use an observation of the selected page belonging to this capture.');
    const verifyView=async()=>{
      if(this.framingObservation!==current||page.isClosed())throw new SessionError('STALE_MARK_OBSERVATION');
      const viewport=page.viewportSize(),frames=page.frames();
      if(!viewport||viewport.width!==observation.width||viewport.height!==observation.height||frames.length!==views.length)throw new SessionError('MARK_VIEW_CHANGED','Observe again after the viewport, frame set or scrolling changes.');
      for(const view of views){
        if(!frames.includes(view.frame)||!await this.documentCurrent(view.frame,view.document))throw new SessionError('MARK_DOCUMENT_CHANGED','Observe the current document; a framing mark cannot reuse an earlier document.');
        if(await framingView(view.frame)!==view.view)throw new SessionError('MARK_VIEW_CHANGED','Observe again after the viewport or scrolling changes.');
      }
    };
    await verifyView();
    const origin={observationId:observation.observationId,observedAt:observation.observedAt,pageId:observation.pageId,viewport:{width:observation.width,height:observation.height}};
    if('ref'in target){
      const description=observation.refs.find(ref=>ref.ref===target.ref),stored=this.refs.get(target.ref);
      if(!description||!stored||stored.description!==description||stored.page!==page)throw new SessionError('MARK_REF_NOT_IN_OBSERVATION','Choose a ref from the named current observation.');
      if(!visibleBox(description.bounds,observation.width,observation.height))throw new SessionError('MARK_TARGET_NOT_VISIBLE','Use wholly visible observed geometry; marking never scrolls a subject into view.');
      const box={...description.bounds};
      const verify=async()=>{
        await verifyView();
        if(!await this.documentCurrent(stored.frame,stored.document)||!await stored.element.evaluate(element=>element.isConnected).catch(()=>false))throw new SessionError('MARK_DOCUMENT_CHANGED');
        const bounds=await stored.element.boundingBox();
        if(!await stored.element.isVisible()||!visibleBox(bounds,observation.width,observation.height)||!await unclippedElement(stored.element))throw new SessionError('MARK_TARGET_NOT_VISIBLE');
        for(let frame=stored.frame;frame.parentFrame();frame=frame.parentFrame()!){
          const element=await frame.frameElement();try{if(!await unclippedElement(element))throw new SessionError('MARK_TARGET_NOT_VISIBLE');}finally{await element.dispose();}
        }
        if(!sameBox(bounds,box))throw new SessionError('MARK_TARGET_MOVED','Observe its new geometry before marking; marks do not track moving subjects.');
      };
      await verify();return {target:box,targetObservation:{...origin,frameId:description.frameId,documentId:description.documentId,ref:description.ref,coordinateSpace:'css',box},verify};
    }
    const pixels=observation.screenshotPixels;
    if(!observation.screenshotPath||!pixels)throw new SessionError('MARK_SCREENSHOT_REQUIRED','Observe with a screenshot before selecting a screenshot-pixel rectangle.');
    if(!visibleBox(target.box,pixels.width,pixels.height))throw new SessionError('MARK_TARGET_NOT_VISIBLE','Keep the rectangle inside the exact observed screenshot pixel dimensions.');
    const box={...target.box},main=observation.frames.find(frame=>frame.documentId===observation.documentId);
    if(!main)throw new SessionError('MARK_DOCUMENT_CHANGED');
    return {target:{x:box.x*observation.width/pixels.width,y:box.y*observation.height/pixels.height,width:box.width*observation.width/pixels.width,height:box.height*observation.height/pixels.height},
      targetObservation:{...origin,frameId:main.frameId,documentId:main.documentId,coordinateSpace:'screenshot',box,screenshotPixels:{...pixels}},verify:verifyView};
  }
  private async resolveTarget(target:SessionTarget,options:{hidden?:boolean;hitTest?:boolean}={}):Promise<ResolvedTarget>{
    if('surfaceId'in target){
      const surface=this.surfaces.get(target.surfaceId);
      if(!surface||![target.x,target.y].every(Number.isFinite)||target.x<0||target.y<0||target.x>=surface.width||target.y>=surface.height)throw new SessionError('STALE_SURFACE','Observe again and use coordinates in that observation viewport.');
      if(surface.page!==this.page())throw new SessionError('TARGET_PAGE_NOT_SELECTED');
      const verify=async()=>{if(!await this.documentCurrent(surface.frame,surface.document)||surface.page.isClosed())throw new SessionError('STALE_SURFACE');};
      await verify();return {page:surface.page,point:{x:target.x,y:target.y},verifyPointer:verify,verifyKeyboard:verify};
    }
    const stored=this.refs.get(target.ref);
    if(!stored)throw new SessionError('STALE_ELEMENT_REF','Observe the current document; refs never reacquire a replacement element.');
    if(stored.page!==this.page())throw new SessionError('TARGET_PAGE_NOT_SELECTED');
    const identity=async()=>{
      if(!await this.documentCurrent(stored.frame,stored.document)||!await stored.element.evaluate(element=>element.isConnected).catch(()=>false))throw new SessionError('STALE_ELEMENT_REF');
      if(!await stored.element.isEnabled())throw new SessionError('ELEMENT_DISABLED');
    };
    await identity();
    let bounds=await stored.element.boundingBox();
    if(!options.hidden){
      if(!await stored.element.isVisible())throw new SessionError('ELEMENT_NOT_VISIBLE');
      if(!bounds||bounds.x<0||bounds.y<0||bounds.x+bounds.width>1600||bounds.y+bounds.height>900){
        // Offscreen DOM refs need explicit native scrolling; this is itself real
        // input and therefore happens only after the action's dispatch marker.
        await stored.element.scrollIntoViewIfNeeded();bounds=await stored.element.boundingBox();
      }
      if(!bounds||bounds.width<=0||bounds.height<=0)throw new SessionError('ELEMENT_NOT_VISIBLE');
    }
    const point=bounds?{x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2}:{x:0,y:0};
    const verifyKeyboard=async()=>{
      await identity();
      if(!await stored.element.isVisible())throw new SessionError('ELEMENT_NOT_VISIBLE');
    };
    const verifyPointer=async()=>{
      if(options.hidden){await identity();return;}
      await verifyKeyboard();
      const box=await stored.element.boundingBox();
      if(!box||Math.abs(box.x+box.width/2-point.x)>.5||Math.abs(box.y+box.height/2-point.y)>.5)throw new SessionError('ELEMENT_MOVED','Observe the new layout before acting.');
      if(options.hitTest!==false){
        const hit=await stored.element.evaluate(element=>{
          const box=element.getBoundingClientRect();let root:Document|ShadowRoot=element.getRootNode() as Document|ShadowRoot;
          const top=root.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
          return !!top&&(element===top||element.contains(top));
        });
        if(!hit)throw new SessionError('ELEMENT_OBSCURED');
      }
    };
    return {page:stored.page,element:stored.element,point,verifyPointer,verifyKeyboard};
  }
  private async uploadFiles(paths:string[],artifactIds:string[]=[],sourceArtifacts:Array<{sourceSetId:string;artifactId:string}>=[]){
    const roots=await Promise.all(this.config.uploadRoots.map(root=>realpath(root)));
    const artifacts=artifactIds.map(id=>{
      const artifact=this.events.find(event=>event.kind==='download'&&event.detail.artifactId===id&&event.detail.status==='retained')?.detail;
      if(!artifact)throw new SessionError('ARTIFACT_NOT_RETAINED');return artifact;
    });
    const loaded=new Map<string,Awaited<ReturnType<typeof loadSourceSet>>>();
    for(const reference of sourceArtifacts){
      let source=loaded.get(reference.sourceSetId);
      if(!source){source=await loadSourceSet(this.config.projectPath,reference.sourceSetId);loaded.set(reference.sourceSetId,source);}
      const artifact=source.sourceSet.artifacts.find(artifact=>artifact.id===reference.artifactId);
      if(!artifact)throw new SessionError('ARTIFACT_NOT_RETAINED','This source set does not retain that artifact ID. List project artifacts and use both returned identities.');
      artifacts.push({...artifact,path:source.artifactPaths[artifact.id]});
    }
    return Promise.all([...paths,...artifacts.map(artifact=>String(artifact.path))].map(async (path,index)=>{
      if(resolve(path)!==path)throw new SessionError('UPLOAD_PATH_NOT_ABSOLUTE');
      const artifact=index>=paths.length?artifacts[index-paths.length]:undefined;
      const canonical=await realpath(path);if(canonical!==path||(!artifact&&!roots.some(root=>isWithin(root,canonical))))throw new SessionError('UPLOAD_OUTSIDE_MANDATE');
      const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{const before=await file.stat();if(!before.isFile()||before.size>64*1024*1024)throw new SessionError('UPLOAD_SIZE_LIMIT');
        const buffer=await file.readFile(),after=await file.stat();
        if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||buffer.length!==before.size)throw new SessionError('UPLOAD_CHANGED');
        if(artifact&&(buffer.length!==artifact.bytes||digestBytes(buffer)!==artifact.sha256))throw new SessionError('ARTIFACT_CHANGED');
        const name=artifact?String(artifact.filename):basename(path);
        return {name,mimeType:mediaTypeForFile(name,artifact?String(artifact.mediaType):undefined),buffer};
      }finally{await file.close();}
    }));
  }
  private async preflightAction(action:SessionAction){
    const preview=this.pendingPrint();
    if(preview){
      if(!['select-page','save-print-preview','close-print-preview'].includes(action.kind))throw new SessionError('NATIVE_PRINT_PENDING','Observe/save the native preview or close it explicitly before other input. Native preview controls are read-only.');
      if(!('pageId'in action)||action.pageId!==preview.pageId)throw new SessionError('NATIVE_PRINT_PAGE_MISMATCH','Act only on the observed associated preview until it is closed.');
    }else if(this.pendingPrintSource&&action.kind!=='dialog')throw new SessionError('NATIVE_PRINT_UNRESOLVED','The original print has no usable associated preview. Inspect its action and close this session; do not replay print.');
    else if(this.pendingInput&&action.kind!=='dialog')throw new SessionError('DIALOG_PENDING','Answer the retained dialog before another browser action.');
    if(action.kind==='save-print-preview'){
      const observation=this.nativeObservations.get(action.observationId);
      if(!preview||preview.pageId!==action.pageId||observation?.pageId!==action.pageId||!observation.nativePrint?.generation)throw new SessionError('NATIVE_PRINT_OBSERVATION_REQUIRED','Observe the completed native preview and use that observationId.');
      requireSameGeneration(observation.nativePrint.generation,(await preview.inspect()).generation);
    }
    if(action.kind==='close-print-preview'&&!preview)throw new SessionError('NATIVE_PRINT_TARGET_CLOSED');
    if(action.kind==='open-artifact'){
      const event=this.events.find(event=>event.kind==='download'&&event.detail.artifactId===action.artifactId);
      if(!event)throw new SessionError('ARTIFACT_NOT_RETAINED');await verifiedPdfArtifact(this.config.directory,event);
    }
    const targets:SessionTarget[]=action.kind==='drag'?[action.from,action.to]:'target'in action&&action.target?[action.target]:[];
    for(const target of targets){
      if('ref'in target){
        const ref=this.refs.get(target.ref);
        if(!ref||!await this.documentCurrent(ref.frame,ref.document)||!await ref.element.evaluate(element=>element.isConnected).catch(()=>false))throw new SessionError('STALE_ELEMENT_REF','Observe again; the original element is gone.');
        if(ref.page!==this.page())throw new SessionError('TARGET_PAGE_NOT_SELECTED');
        if(!await ref.element.isEnabled())throw new SessionError('ELEMENT_DISABLED');
        if(action.kind==='text'&&await ref.element.evaluate(element=>element instanceof HTMLInputElement&&element.type==='password'))throw new SessionError('AUTHENTICATION_HANDOFF_REQUIRED');
      }else{
        const surface=this.surfaces.get(target.surfaceId);
        if(!surface||!await this.documentCurrent(surface.frame,surface.document)||target.x<0||target.y<0||target.x>=surface.width||target.y>=surface.height)throw new SessionError('STALE_SURFACE');
        if(surface.page!==this.page())throw new SessionError('TARGET_PAGE_NOT_SELECTED');
      }
    }
    if(action.kind==='dialog'&&!this.dialogs.has(action.dialogId))throw new SessionError('DIALOG_NOT_FOUND');
    if(action.kind==='auth-resume'&&this.info.status!=='authentication')throw new SessionError('AUTHENTICATION_NOT_ACTIVE');
    if(!['dialog','auth-begin','auth-resume','select-page'].includes(action.kind)&&[...this.dialogs.values()].some(value=>value.pageId===this.info.selectedPageId))throw new SessionError('DIALOG_PENDING');
    if(action.kind==='upload')return {
      files:await this.uploadFiles(action.paths??[],action.artifactIds??[],action.sourceArtifacts??[]),
      fileInput:await this.refs.get(action.target.ref)!.element.evaluate(element=>element instanceof HTMLInputElement&&element.type==='file'),
    };
    return undefined;
  }
  private async dispatchPrint(record:ActionRecord,execution:Promise<void>,expected:Awaited<ReturnType<typeof expectNativePrint>>,dialog:Promise<'dialog'>,save:()=>Promise<void>){
    let input:'pending'|'completed'|'failed'='pending',discovered:'pending'|'found'|'failed'='pending',inputError:ActionRecord['error'],discoveryError:ActionRecord['error'];
    const update=async()=>{
      record.result={...record.result,print:{input:{status:input,...(inputError?{error:inputError}:{})},discovery:{status:discovered,...(discoveryError?{error:discoveryError}:{})}}};
      record.status=input==='completed'&&discovered==='found'?'input-completed':'outcome-uncertain';
      if(record.status==='input-completed')delete record.error;
      else record.error=inputError??discoveryError??{code:this.dialogs.size?'DIALOG_PENDING':'NATIVE_PRINT_PENDING',message:'The original print attempt remains owned. Inspect its observed preview or dialog; never replay this input.'};
      record.updatedAt=timestamp();await save();
    };
    // Input and target discovery have independent terminal events. A discovery
    // refusal or rejected input cannot establish that the other did not happen.
    const completion=execution.then(async()=>{input='completed';record.completedAtMs=performance.now();await update();},async error=>{input='failed';inputError=sessionError(error);await update();})
      .finally(()=>{if(this.pendingInput?.record===record)this.pendingInput=undefined;});
    this.pendingInput={record,completion,save};
    const discovery=expected.wait().then(async preview=>{
      this.prints.set(preview.pageId,preview);this.pendingPrintPreview=preview;discovered='found';
      this.retainEvent('print-preview',preview.pageId,{sourcePageId:preview.sourcePageId,actionId:record.actionId,sourceBinding:'exclusive-action-and-browser-context'},record);
      record.result={...record.result,pageId:preview.pageId};await update();
    },async error=>{discovered='failed';discoveryError=sessionError(error);await update();});
    this.pendingPrintDiscovery={record,save,completion:discovery,cancel:expected.cancel};
    this.track(completion);this.track(discovery);
    await Promise.race([discovery,dialog]);await update();
  }
  dispatch(request:ActionRequest):Promise<ActionRecord>{return this.serial(async()=>{
    this.assertOpen();validateAction(request.action);const path=actionPath(this.config.directory,request.actionId),payloadSha256=digest(request.action);
    const previous=await readAction(this.config.directory,request.actionId);
    if(previous){if(previous.payloadSha256!==payloadSha256)throw new SessionError('ACTION_ID_CONFLICT','This actionId already belongs to a different payload.');return previous;}
    const record:ActionRecord={version:1,actionId:request.actionId,payloadSha256,action:request.action,status:'not-dispatched',createdAt:timestamp(),updatedAt:timestamp(),eventIds:[]};
    let writes=Promise.resolve();const save=()=>{const snapshot=structuredClone(record),next=writes.then(()=>writeJson(path,snapshot));writes=next.catch(()=>{});return next;};
    await save();
    try{
      const action=request.action;
      if(this.info.status==='authentication'&&!['auth-resume','auth-begin'].includes(action.kind))throw new SessionError('AUTHENTICATION_PRIVATE');
      if(action.kind==='navigate'&&!this.navigationAllowed(action.url))throw new SessionError('NAVIGATION_OUTSIDE_MANDATE');
      if(action.kind==='select-page'&&!this.prints.has(action.pageId))this.page(action.pageId);
      const upload=await this.preflightAction(action);
      const expected='expectPrintPreview'in action&&action.expectPrintPreview?await expectNativePrint(this.context,this.page(),this.info.selectedPageId!,record.actionId):undefined;
      // Admission validation above sends no application input. This durable
      // marker precedes scrolling, focus, pointer movement, and every API input.
      record.status='outcome-uncertain';record.dispatchedAt=timestamp();record.startedAtMs=performance.now();await save();this.activeAction=record;this.framingObservation=undefined;
      let wake!:()=>void;const dialog=new Promise<'dialog'>(resolve=>{wake=()=>resolve('dialog');});this.dialogWake=wake;
      if(expected)this.pendingPrintSource=this.page();
      const execution=this.execute(action,upload);
      if(expected){await this.dispatchPrint(record,execution,expected,dialog,save);return record;}
      const completed=await Promise.race([execution.then(()=>'completed' as const),dialog]);
      this.dialogWake=undefined;
      if(completed==='dialog'){
        record.status='outcome-uncertain';record.error={code:'DIALOG_PENDING',message:'The input is waiting on the retained native dialog. Answer that dialog; this action is never replayed.'};
        const completion=execution.then(async()=>{
          record.status='input-completed';record.completedAtMs=performance.now();delete record.error;record.updatedAt=timestamp();
          await save();
        },async error=>{record.status='outcome-uncertain';record.error=sessionError(error);record.updatedAt=timestamp();await save();}).finally(()=>{if(this.pendingInput?.record===record)this.pendingInput=undefined;});
        this.pendingInput={record,completion,save};
      }else{record.status='input-completed';record.completedAtMs=performance.now();}
    }catch(error){record.status=record.dispatchedAt?'outcome-uncertain':'not-dispatched';record.error=sessionError(error);}
    finally{this.dialogWake=undefined;this.activeAction=undefined;record.updatedAt=timestamp();await save();this.info.captureActive=this.captureActive||!!this.parkedCapture;await saveInfo(this.info);}
    return record;
  });}
  resolveAction(id:string,resolution:{outcome:'effect-observed'|'no-effect-observed'|'uncertain';note:string}){return this.serial(async()=>{
    const pending=this.pendingInput?.record.actionId===id?this.pendingInput:this.pendingPrintDiscovery?.record.actionId===id?this.pendingPrintDiscovery:undefined;
    const record=pending?.record??await readAction(this.config.directory,id);if(!record)throw new SessionError('ACTION_NOT_FOUND');
    record.resolution={...resolution,at:timestamp()};record.updatedAt=timestamp();
    if(pending?.save)await pending.save();else await writeJson(actionPath(this.config.directory,id),record);return record;
  });}
  private async execute(action:SessionAction,upload?:{files:Array<{name:string;mimeType:string;buffer:Buffer}>;fileInput:boolean}){
    if(action.kind==='save-print-preview'){await this.savePrint(action);return;}
    if(action.kind==='close-print-preview'){await this.closePrint(this.prints.get(action.pageId)!);return;}
    if(action.kind==='open-artifact'){await this.openArtifact(action.artifactId);return;}
    if(action.kind==='auth-begin'){
      try{await this.stopCapture('authentication');}catch(error){await this.close('authentication-recorder-stop-failed');throw error;}
      for(const driver of this.inputs.values())await driver.dispose();this.inputs.clear();
      await this.clearObservationHandles();this.info.status='authentication';await saveInfo(this.info);return;
    }
    if(action.kind==='auth-resume'){
      if(this.info.status!=='authentication')throw new SessionError('AUTHENTICATION_NOT_ACTIVE');
      this.dialogs.clear();this.info.status='open';await this.clearObservationHandles();await saveInfo(this.info);return;
    }
    if(action.kind==='select-page'){
      const preview=this.prints.get(action.pageId);
      if(preview){
        if(preview.closed)throw new SessionError('NATIVE_PRINT_TARGET_CLOSED');
        if(this.info.selectedPageId===action.pageId)return;
        // The source cannot paint its closing slate while window.print blocks
        // it. Park the still-owned recorder; native gets a distinct take.
        if(this.captureActive&&this.capturePage&&this.pageIds.get(this.capturePage)===preview.sourcePageId){this.parkedCapture={capture:this.capture!,page:this.capturePage};this.captureActive=false;}
        else await this.stopCapture('stop');
        await preview.prepareGeometry();
      }else await this.stopCapture('stop');
      this.info.selectedPageId=action.pageId;this.capture=undefined;this.capturePage=undefined;this.captureNative=undefined;return;
    }
    if(action.kind==='dialog'){
      const pending=this.dialogs.get(action.dialogId);if(!pending)throw new SessionError('DIALOG_NOT_FOUND');
      if(action.response==='accept')await pending.dialog.accept(action.promptText);else await pending.dialog.dismiss();
      this.dialogs.delete(action.dialogId);
      await (this.pendingPrintDiscovery?Promise.race([this.pendingInput?.completion??Promise.resolve(),this.pendingPrintDiscovery.completion]):this.pendingInput?.completion);return;
    }
    const page=this.page(action.kind==='navigate'?action.pageId:undefined);
    if([...this.dialogs.values()].some(value=>value.pageId===this.pageIds.get(page)))throw new SessionError('DIALOG_PENDING');
    if(action.kind==='navigate'&&page!==this.page())throw new SessionError('TARGET_PAGE_NOT_SELECTED');
    const driver=this.input(page);await driver.ready();let failure:{error:unknown}|undefined;
    try{
    if(action.kind==='navigate')await driver.navigate(action.url);
    else if(action.kind==='drag'){
      const from=await this.resolveTarget(action.from),to=await this.resolveTarget(action.to,{hitTest:false});
      await driver.drag(from,to,action);
    }else if(action.kind==='keys')await driver.keys(action.target?await this.resolveTarget(action.target,{hitTest:false}):undefined,action.keys);
    else{
      const target=await this.resolveTarget(action.target,{hidden:action.kind==='upload'&&upload!.fileInput});
      if(action.kind==='click')await driver.click(target,action.button,action.clickCount,action.modifiers);
      if(action.kind==='hover')await driver.hover(target);
      if(action.kind==='text'){
        if(await target.element?.evaluate(element=>element instanceof HTMLInputElement&&element.type==='password'))throw new SessionError('AUTHENTICATION_HANDOFF_REQUIRED','Use auth-begin and enter credentials yourself off camera.');
        await driver.text(target,action.text,action.mode);
      }
      if(action.kind==='select')await driver.select(target,action.values);
      if(action.kind==='wheel')await driver.wheel(target,action.deltaX,action.deltaY);
      if(action.kind==='upload')await driver.upload(target,upload!.files,upload!.fileInput);
    }
    }catch(error){failure={error};throw error;}finally{
    // A dialog blocks evaluation; its retained event is the result available
    // now. The next explicit dialog action releases it; never dismiss silently.
    if(page!==this.pendingPrintSource&&![...this.dialogs.values()].some(value=>value.pageId===this.pageIds.get(page))&&!page.isClosed()){
      try{await driver.flush();}catch(error){throw failure?inputCleanupFailure(failure.error,error):error;}
    }
    }
  }
  captureCommand(request:CaptureRequest){return this.serial(async()=>{
    validateCaptureRequest(request);
    const path=join(this.config.directory,'capture-operations',`${request.operationId}.json`),sha256=digest(request);
    let prior:{sha256:string;status:string;result?:unknown;error?:unknown}|undefined;
    try{prior=await readJson(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(prior){if(prior.sha256!==sha256)throw new SessionError('CAPTURE_OPERATION_ID_CONFLICT');return prior;}
    this.assertOpen(true);
    const retained:{sha256:string;operationId:string;status:string;result?:unknown;error?:unknown}={sha256,operationId:request.operationId,status:'outcome-uncertain'};
    await writeJson(path,retained);
    try{
      const native=this.selectedPrint(),page=native?undefined:this.page();
      if(page&&(page===this.pendingPrintSource||this.openPrint()?.sourcePageId===this.pageIds.get(page)))throw new SessionError('NATIVE_PRINT_PENDING','Select the native preview before capture. Its suspended source take cannot stop until the preview closes.');
      if(this.captureActive&&(page!==this.capturePage||native!==this.captureNative))throw new SessionError('CAPTURE_PAGE_MISMATCH','Finish the original capture before selecting a different page.');
      if(!this.capture||page!==this.capturePage||native!==this.captureNative){
        this.capture=createSessionCapture({projectPath:this.config.projectPath,sessionId:this.info.sessionId,page:native?native.captureSurface():page!,pageId:this.info.selectedPageId!,tools:this.config.tools??{
          ...resolveLocalTools(),browserPath:this.config.executablePath??qualifiedBrowserPath()},events:this.eventsForPage(this.info.selectedPageId!)});
        this.capturePage=page;this.captureNative=native;
      }
      if(request.kind==='start'){
        if(this.captureActive)throw new SessionError('CAPTURE_ALREADY_ACTIVE');
        this.framingObservation=undefined;
        try{retained.result=await this.capture.start(request.request??{});}catch(error){
          // A rejected start does not prove that the backend never recorded.
          // Fence this context before persistence; only its explicit close can
          // contain a recorder whose handle was not returned. Never retry it.
          this.info.status='interrupted';this.info.closeReason='capture-start-failed';
          const original=sessionError(error);
          retained.error={...original,recovery:`${original.recovery??''} Close the original session before any further input or capture; the recorder's stopped state is not established.`.trim()};
          throw error;
        }
        this.captureActive=true;if(page)await this.input(page).samplePointer();
      }else if(request.kind==='mark'){
        if(!this.captureActive)throw new SessionError('CAPTURE_NOT_ACTIVE');
        if(!request.request?.title)throw new SessionError('CAPTURE_MARK_TITLE_REQUIRED');
        if([...this.dialogs.values()].some(value=>value.pageId===this.info.selectedPageId))throw new SessionError('DIALOG_PENDING');
        if(page)await this.input(page).flush();
        const {target,...options}=request.request,framing=target?await this.resolveMarkTarget(target):undefined;
        retained.result=await this.capture.mark({...options,title:request.request.title,...(framing?{target:framing.target,targetObservation:framing.targetObservation,verifyTarget:framing.verify}:{})});
      }else retained.result=await this.stopCapture('stop');
      retained.status='completed';
    }catch(error){retained.error??=sessionError(error);}
    this.info.captureActive=this.captureActive||!!this.parkedCapture;await saveInfo(this.info);await writeJson(path,retained);return retained;
  });}
  private async stopCapture(reason:'stop'|'authentication'|'close'){
    if(!this.captureActive)return this.capture?.inspect()??null;
    this.framingObservation=undefined;
    // Deactivate first. A failed native stop remains the original occurrence;
    // close/auth must not issue another stop against an uncertain recorder.
    this.captureActive=false;this.info.captureActive=false;
    let failure:unknown;
    try{if(this.capturePage&&!this.capturePage.isClosed()&&![...this.dialogs.values()].some(value=>value.pageId===this.pageIds.get(this.capturePage!)))await this.input(this.capturePage).flush();}catch(error){failure=error;}
    const result=await this.capture!.stop();if(failure)throw failure;return result;
  }
  close(reason='closed-by-user'):Promise<void>{
    if(this.closing)return this.closing;
    clearTimeout(this.idleTimer);
    // Retain the attempt before invoking observers: a reentrant observer must
    // rejoin it, and diagnostic failures must never become close failures.
    const attempt=Promise.withResolvers<void>();this.closing=attempt.promise;
    void (async()=>{
      this.closePhase('starting');
      let failure:unknown;
      const preview=this.pendingPrint();
      if(preview)try{this.closePhase('print-close');await this.closePrint(preview);}catch(error){failure=error;}
      else if(this.pendingPrintDiscovery)try{
        this.closePhase('print-discovery-cancel');await this.pendingPrintDiscovery.cancel();
        this.closePhase('print-discovery-settle');await this.pendingPrintDiscovery.completion;
      }catch(error){failure=error;}
      // Failed Cancel or source settlement cannot safely calibrate a suspended
      // source. Shut down this exact context first, then settle its recorder.
      if(this.dialogs.size||this.pendingPrintSource&&(!preview||failure))try{this.closePhase('context-close-before-capture');await this.context?.close();}catch(error){failure??=error;}
      try{this.closePhase('capture-stop');await this.stopCapture('close');}catch(error){failure=error;}
      try{this.closePhase('context-close');await this.context?.close();}catch(error){failure??=error;}
      // A failed target close may force browser shutdown. Settle the still-owned
      // source recorder once, recording its failure rather than abandoning it.
      if(this.parkedCapture){const parked=this.parkedCapture;this.parkedCapture=undefined;this.capture=parked.capture;this.capturePage=parked.page;this.captureNative=undefined;this.captureActive=true;try{this.closePhase('parked-capture-stop');await this.stopCapture('close');}catch(error){failure??=error;}}
      this.closePhase('print-dispose');
      for(const preview of this.prints.values())await preview.dispose().catch(()=>{});
      this.closePhase('input-dispose');
      for(const driver of this.inputs.values())await driver.dispose().catch(()=>{});
      if(this.pendingInput)try{this.closePhase('pending-input-settle');await awaitNativeOperation(this.pendingInput.completion,'NATIVE_PRINT_INPUT_UNSETTLED');}catch(error){failure??=error;}
      try{this.closePhase('events-settle');await awaitNativeOperation(Promise.allSettled(this.pendingEvents),'SESSION_EVENTS_UNSETTLED');}catch(error){failure??=error;}
      this.info.status=failure?'interrupted':'closed';this.info.captureActive=false;this.info.closeReason=reason;
      this.closePhase('journal-save');await saveInfo(this.info);
      if(!failure){this.closePhase('marker-remove');await removeSessionMarker(this.info);}
      this.options.onClosed?.();if(failure)throw failure;
    })().then(()=>{this.closePhase('closed');attempt.resolve();},error=>{this.closePhase('failed');attempt.reject(error);});
    return this.closing;
  }
  private closePhase(phase:SessionClosePhase){
    try{void Promise.resolve(this.options.onClosePhase?.(phase)).catch(()=>{});}catch{}
  }
}

import {createHash} from 'node:crypto';
const digestBytes=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function validateSessionConfig(config:SessionConfig){
  if(!config||!validId(config.projectId)||![config.directory,config.projectPath].every(path=>typeof path==='string'&&resolve(path)===path))throw new SessionError('INVALID_SESSION_CONFIG');
  if(!['web','loopback-only'].includes(config.network)||!Array.isArray(config.allowedOrigins)||!config.allowedOrigins.length||!Array.isArray(config.uploadRoots))throw new SessionError('INVALID_SESSION_MANDATE');
  for(const origin of config.allowedOrigins){const url=new URL(origin);if(url.origin!==origin||!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new SessionError('INVALID_NAVIGATION_ORIGIN');}
  const url=new URL(config.startUrl);if(!config.allowedOrigins.includes(url.origin)||url.username||url.password||!['http:','https:'].includes(url.protocol)||config.network==='loopback-only'&&!loopback(url.hostname))throw new SessionError('NAVIGATION_OUTSIDE_MANDATE');
  if(config.uploadRoots.some(path=>resolve(path)!==path))throw new SessionError('UPLOAD_ROOT_NOT_ABSOLUTE');
  if(config.profileDirectory&&resolve(config.profileDirectory)!==config.profileDirectory)throw new SessionError('PROFILE_PATH_NOT_ABSOLUTE');
  if(config.idleTimeoutMs!==undefined&&(!Number.isSafeInteger(config.idleTimeoutMs)||config.idleTimeoutMs<1000||config.idleTimeoutMs>24*60*60*1000))throw new SessionError('INVALID_SESSION_IDLE_LIMIT');
  if(config.pacing&&Object.values(config.pacing).some(value=>!Number.isFinite(value)||value!<0))throw new SessionError('INVALID_INTERACTION_PACING');
}
export function validateAction(action:SessionAction){
  if(!action||typeof action!=='object')throw new SessionError('INVALID_ACTION');
  const keys:Record<SessionAction['kind'],string[]>={navigate:['url','pageId'],'select-page':['pageId'],click:['target','button','clickCount','modifiers','expectPrintPreview'],hover:['target'],text:['target','text','mode'],keys:['target','keys','expectPrintPreview'],select:['target','values'],wheel:['target','deltaX','deltaY'],drag:['from','to','button','modifiers','durationMs'],upload:['target','paths','artifactIds','sourceArtifacts'],dialog:['dialogId','response','promptText'],'save-print-preview':['pageId','observationId','filename'],'close-print-preview':['pageId'],'open-artifact':['artifactId'],'auth-begin':[],'auth-resume':[]};
  if(!Object.hasOwn(keys,action.kind)||Object.keys(action).some(key=>key!=='kind'&&!keys[action.kind].includes(key)))throw new SessionError('INVALID_ACTION','Use a documented typed browser action; scripts and evaluation are not supported.');
  const target=(value:unknown,element=false)=>{
    if(!value||typeof value!=='object')throw new SessionError('INVALID_TARGET');
    const t=value as Record<string,unknown>;
    if(typeof t.ref==='string'&&Object.keys(t).length===1)return;
    if(!element&&typeof t.surfaceId==='string'&&typeof t.x==='number'&&typeof t.y==='number'&&Number.isFinite(t.x)&&Number.isFinite(t.y)&&Object.keys(t).every(key=>['surfaceId','x','y'].includes(key)))return;
    throw new SessionError('INVALID_TARGET');
  };
  const string=(value:unknown,max=100000)=>{if(typeof value!=='string'||value.length>max)throw new SessionError('INVALID_ACTION_ARGUMENT');};
  if('target'in action&&action.target!==undefined)target(action.target,action.kind==='select'||action.kind==='upload');
  if(['click','hover','text','select','wheel','upload'].includes(action.kind)&&!('target'in action))throw new SessionError('INVALID_TARGET');
  if('button'in action&&action.button!==undefined&&!['left','middle','right'].includes(action.button))throw new SessionError('INVALID_POINTER_BUTTON');
  if(action.kind==='click'&&action.clickCount!==undefined&&(!Number.isSafeInteger(action.clickCount)||action.clickCount<1||action.clickCount>3))throw new SessionError('INVALID_CLICK_COUNT');
  if(action.kind==='navigate'){string(action.url,10000);if(action.pageId!==undefined){string(action.pageId,200);if(!action.pageId)throw new SessionError('INVALID_PAGE_ID');}}
  if(action.kind==='select-page'){string(action.pageId,200);if(!action.pageId)throw new SessionError('INVALID_PAGE_ID');}
  if(action.kind==='text'){string(action.text);if(action.mode!==undefined&&!['type','insert','replace'].includes(action.mode))throw new SessionError('INVALID_TEXT_MODE');}
  if(action.kind==='keys'){string(action.keys,200);if(!action.keys)throw new SessionError('INVALID_KEYS');}
  if('expectPrintPreview'in action&&action.expectPrintPreview!==true)throw new SessionError('INVALID_PRINT_EXPECTATION');
  if(action.kind==='save-print-preview'||action.kind==='close-print-preview'){
    if(!validId(action.pageId))throw new SessionError('INVALID_PAGE_ID');
    if(action.kind==='save-print-preview'&&(!validId(action.observationId)||typeof action.filename!=='string'||action.filename.length>180||action.filename.startsWith('.')||/[\\/\u0000-\u001f\u007f]/.test(action.filename)||!/^.+\.pdf$/i.test(action.filename)))throw new SessionError('INVALID_PRINT_SAVE_ARGUMENT','Use an observed generation and a safe .pdf basename of at most 180 characters.');
  }
  if(action.kind==='open-artifact'&&!validId(action.artifactId))throw new SessionError('INVALID_ARTIFACT_ID');
  if(action.kind==='wheel'&&![action.deltaX,action.deltaY].every(Number.isFinite))throw new SessionError('INVALID_WHEEL_DELTA');
  if((action.kind==='click'||action.kind==='drag')&&action.modifiers!==undefined&&(!Array.isArray(action.modifiers)||action.modifiers.some(key=>!['Alt','Control','Meta','Shift'].includes(key))||new Set(action.modifiers).size!==action.modifiers.length))throw new SessionError('INVALID_MODIFIERS');
  if(action.kind==='drag'){
    target(action.from);target(action.to);
    if(action.durationMs!==undefined&&(!Number.isFinite(action.durationMs)||action.durationMs<=0||action.durationMs>60000))throw new SessionError('INVALID_DRAG_DURATION');
  }
  if(action.kind==='select'||action.kind==='upload'){
    const values=action.kind==='select'?action.values:action.paths??action.artifactIds??action.sourceArtifacts;
    if(action.kind==='upload'&&[action.paths,action.artifactIds,action.sourceArtifacts].filter(value=>value!==undefined).length!==1)throw new SessionError('UPLOAD_SELECT_ONE_SOURCE');
    if(!Array.isArray(values)||values.length>100)throw new SessionError('INVALID_ACTION_ARGUMENT');
    if(action.kind==='upload'&&action.sourceArtifacts!==undefined){
      for(const value of values)if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='artifactId,sourceSetId'||!validId(value.sourceSetId)||!validId(value.artifactId))throw new SessionError('INVALID_SOURCE_ARTIFACT');
    }else for(const value of values)string(value,10000);
  }
  if(action.kind==='dialog'){string(action.dialogId,200);if(!['accept','dismiss'].includes(action.response))throw new SessionError('INVALID_DIALOG_RESPONSE');if(action.promptText!==undefined)string(action.promptText,10000);}
}
export function validateCaptureRequest(request:CaptureRequest){
  if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(key=>!['operationId','kind','request'].includes(key))||!validId(request.operationId)||!['start','mark','stop'].includes(request.kind))throw new SessionError('INVALID_CAPTURE_REQUEST');
  const details=request.request;if(details===undefined){if(request.kind==='mark')throw new SessionError('CAPTURE_MARK_TITLE_REQUIRED');return;}
  const allowed=request.kind==='start'?['title']:request.kind==='mark'?['title','id','settled','target']:[];
  if(!details||typeof details!=='object'||Array.isArray(details)||Object.keys(details).some(key=>!allowed.includes(key)))throw new SessionError('INVALID_CAPTURE_REQUEST');
  if(details.title!==undefined&&(typeof details.title!=='string'||!details.title.trim()||details.title.length>10000))throw new SessionError('INVALID_CAPTURE_TITLE');
  if(request.kind==='mark'&&details.title===undefined)throw new SessionError('CAPTURE_MARK_TITLE_REQUIRED');
  if(details.id!==undefined&&!validId(details.id))throw new SessionError('INVALID_MARK_ID');
  if(details.settled!==undefined&&typeof details.settled!=='boolean')throw new SessionError('INVALID_SETTLED_FLAG');
  if(details.target!==undefined){
    const target=details.target;
    if(!target||typeof target!=='object'||Array.isArray(target)||!validId(target.observationId))throw new SessionError('INVALID_CAPTURE_TARGET');
    if('ref'in target){if(Object.keys(target).sort().join(',')!=='observationId,ref'||!validId(target.ref))throw new SessionError('INVALID_CAPTURE_TARGET');}
    else {const box=target.box;if(Object.keys(target).sort().join(',')!=='box,coordinateSpace,observationId'||target.coordinateSpace!=='screenshot'||!box||typeof box!=='object'||Array.isArray(box)||Object.keys(box).sort().join(',')!=='height,width,x,y'||!visibleBox(box,Number.MAX_VALUE,Number.MAX_VALUE))throw new SessionError('INVALID_CAPTURE_TARGET');}
  }
}
