import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {openSessionBrowser} from '../src/session/browser.ts';
import {SessionRuntime} from '../src/session/runtime.ts';
import type {SessionConfig,SessionInfo} from '../src/session/contracts.ts';

/** Real-browser companion to the deterministic protocol-boundary tests. Uses
 * only generated loopback pages; no recorder or real application occurrence. */
async function fixture(t:TestContext,child:boolean){
  let effects=0;
  let root:string|undefined,context:Awaited<ReturnType<typeof openSessionBrowser>>|undefined,internals:any;
  const server=createServer((request,response)=>{
    response.setHeader('content-type','text/html');
    if(request.url==='/'){response.end(child?'<iframe style="margin:30px;width:500px;height:300px" src="/start"></iframe>':'<a style="display:block;margin:30px" href="/effect">Continue</a>');}
    else if(request.url==='/start')response.end('<a style="display:block;margin:30px" href="/effect">Continue</a>');
    else if(request.url==='/effect'){effects++;response.writeHead(303,{location:'/result'});response.end();}
    else response.end('<h1>Observed result</h1>');
  });
  t.after(async()=>{
    clearTimeout(internals?.idleTimer);
    if(internals)for(const driver of internals.inputs.values())await driver.dispose();
    try{await context?.close();}finally{
      await new Promise<void>(resolve=>server.close(()=>resolve()));
      if(root)await rm(root,{recursive:true,force:true});
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  root=await mkdtemp('/private/tmp/wts-navigation-browser-');const directory=join(root,'session');
  await mkdir(join(directory,'actions'),{recursive:true});await mkdir(join(directory,'observations'));
  context=await openSessionBrowser({profileDirectory:join(root,'profile'),headless:true,network:'loopback-only'});
  const page=await context.newPage();await page.goto(origin);
  const config:SessionConfig={directory,projectId:'project',projectPath:root,startUrl:origin,allowedOrigins:[origin],uploadRoots:[],network:'loopback-only',mediaReview:'agent-reviewable-synthetic',pacing:{minimumApproachMs:0,distanceMsPerPixel:0,targetDwellMs:0,keyDelayMs:0}};
  const info:SessionInfo={version:1,sessionId:'navigation-browser',projectId:'project',projectPath:root,directory,status:'open',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),captureActive:false,socketPath:join(root,'unused.sock')};
  const runtime=new (SessionRuntime as any)(config,info,{}) as SessionRuntime;internals=runtime as any;
  internals.context=context;internals.attachPage(page,false);info.selectedPageId=internals.pageIds.get(page);
  const document=child?page.frames().find(frame=>frame!==page.mainFrame())!:page.mainFrame();await document.waitForSelector('a');
  // Force the original document to be gone before the input promise returns.
  // A post-input window-buffer drain cannot retain these native events.
  const up=page.mouse.up.bind(page.mouse);page.mouse.up=async options=>{await up(options);await document.waitForURL(`${origin}/result`);};
  return {runtime,page,document,effects:()=>effects};
}

for(const child of [false,true])test(`native click retains original evidence across ${child?'child-frame':'main-document'} navigation and redirect`,async t=>{
  const f=await fixture(t,child),observed=await f.runtime.observe({screenshot:false}),link=observed.refs.find(ref=>ref.name==='Continue');assert.ok(link);
  const request={actionId:'continue-once',action:{kind:'click' as const,target:{ref:link.ref}}};
  const result=await f.runtime.dispatch(request);assert.equal(result.status,'input-completed',JSON.stringify(result.error));
  assert.equal(f.effects(),1);assert.match(await f.document.locator('h1').innerText(),/Observed result/);
  const pointer=f.runtime.inputEvents.filter(event=>event.kind==='pointerdown'||event.kind==='pointerup');
  assert.deepEqual(pointer.map(event=>event.kind),['pointerdown','pointerup']);assert.ok(pointer.every(event=>event.source==='browser'&&event.trusted));
  assert.ok(pointer[1].atMs>=pointer[0].atMs);assert.equal(pointer[0].x,pointer[1].x);assert.equal(pointer[0].y,pointer[1].y);
  assert.deepEqual(await f.runtime.dispatch(request),result);assert.equal(f.effects(),1);
});
