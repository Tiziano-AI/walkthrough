import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {constants} from 'node:fs';
import {access,lstat,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import type {BrowserContext,CDPSession,Page} from 'playwright';
import {pageCaptureSurface,type SlateCover} from '../src/capture/surface.ts';
import type {Recording} from '../src/capture/chromium.ts';
import {qualifiedBrowserPath,qualifiedNode} from '../src/core/environment.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';
import {openSessionBrowser} from '../src/session/browser.ts';

// Diagnostic, not a normal-suite browser launch. Requires an unlocked macOS
// desktop and an explicitly released browser/media slot; never run alongside a
// film occurrence or render. No dependencies, profiles or browser are installed.
// WALKTHROUGH_CAPTURE_GEOMETRY_BROWSER_TEST=1 node \
//   --test --test-concurrency=1 tests/capture-geometry-browser.test.ts
//
// Public session observations do not expose native window/layout metrics or the
// closed-shadow slate. This test alone reads them through Playwright/CDP while
// using the real session launcher, production cover and native recorder. It
// does not add public evaluation or change window size, zoom, emulation or CSS.
// Extra screenshots change timing: these are geometry holds, NOT beginTake
// clock calibration. The test never manufactures a qualified capture-clock map.
const enabled=process.env.WALKTHROUGH_CAPTURE_GEOMETRY_BROWSER_TEST==='1';
const {ffmpegPath:ffmpeg,ffprobePath:ffprobe}=resolveLocalTools();
const execute=promisify(execFile),maximumFrames=3600;
const fixture=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Fictional capture geometry</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}body{background:#8743cb;color:white;font:28px sans-serif}main{position:fixed;inset:0;border:16px solid #24cd74;box-sizing:border-box}h1{margin:96px}i{position:fixed;width:80px;height:80px;background:#ed3946}.a{left:0;top:0}.b{right:0;top:0}.c{left:0;bottom:0}.d{right:0;bottom:0}</style>
<main><h1>Fictional geometry fixture</h1></main><i class="a"></i><i class="b"></i><i class="c"></i><i class="d"></i></html>`;
type Shade='white'|'gray';
type DomNode={nodeId:number;attributes?:string[];children?:DomNode[];shadowRoots?:DomNode[];contentDocument?:DomNode};
type Snapshot=Awaited<ReturnType<typeof snapshot>>;
type PixelBox={x:number;y:number;width:number;height:number};
type Coverage={raster:{width:number;height:number};box:PixelBox|null;widthRatio:number;heightRatio:number;matchedFraction:number};

async function snapshot(page:Page,cdp:CDPSession,directory:string,name:string){
  const beforeMs=performance.now();
  const dom=await page.evaluate(()=>{
    const box=(element:Element)=>{const r=element.getBoundingClientRect(),style=getComputedStyle(element);return {x:r.x,y:r.y,width:r.width,height:r.height,zoom:style.getPropertyValue('zoom'),transform:style.transform};};
    const vv=visualViewport;
    return {inner:{width:innerWidth,height:innerHeight},outer:{width:outerWidth,height:outerHeight},dpr:devicePixelRatio,
      screenPosition:{x:screenX,y:screenY},screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,colorDepth:screen.colorDepth},
      visual:vv?{width:vv.width,height:vv.height,scale:vv.scale,offsetLeft:vv.offsetLeft,offsetTop:vv.offsetTop,pageLeft:vv.pageLeft,pageTop:vv.pageTop}:null,
      scroll:{x:scrollX,y:scrollY},html:box(document.documentElement),body:box(document.body)};
  });
  const {targetInfo}=await cdp.send('Target.getTargetInfo');
  const nativeWindow=await cdp.send('Browser.getWindowForTarget',{targetId:targetInfo.targetId});
  const layout=await cdp.send('Page.getLayoutMetrics');
  // This fictional document has no popover. Inspect only the production cover,
  // including its closed shadow root; never retain an opaque full DOM dump.
  const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});const covers:DomNode[]=[];
  const walk=(node:DomNode)=>{const attrs=node.attributes??[];if(attrs.some((value,index)=>index%2===0&&value==='popover'&&attrs[index+1]==='manual'))covers.push(node);for(const child of [...node.children??[],...node.shadowRoots??[],...(node.contentDocument?[node.contentDocument]:[])])walk(child);};
  walk(root);
  const slateBoxes=[];
  for(const cover of covers){const {model}=await cdp.send('DOM.getBoxModel',{nodeId:cover.nodeId});slateBoxes.push({width:model.width,height:model.height,border:model.border,content:model.content});}
  const png=await pageCaptureSurface(page).screenshot(),screenshot=`${name}.png`;
  await writeFile(join(directory,screenshot),png,{flag:'wx',mode:0o600});
  return {name,beforeMs,afterMs:performance.now(),viewport:page.viewportSize(),dom,nativeWindow,
    layout:{cssLayoutViewport:layout.cssLayoutViewport,cssVisualViewport:layout.cssVisualViewport,cssContentSize:layout.cssContentSize},slateBoxes,
    screenshot,screenshotPixels:{width:png.readUInt32BE(16),height:png.readUInt32BE(20)}};
}
const shadeValue=(shade:Shade)=>shade==='white'?255:119;
function pixelMatches(bytes:Buffer,offset:number,shade:Shade){
  const r=bytes[offset],g=bytes[offset+1],b=bytes[offset+2],value=shadeValue(shade);
  return Math.max(r,g,b)-Math.min(r,g,b)<=8&&Math.abs(r-value)<=12&&Math.abs(g-value)<=12&&Math.abs(b-value)<=12;
}
async function coverage(path:string,shade:Shade):Promise<Coverage>{
  const png=await readFile(path),width=png.readUInt32BE(16),height=png.readUInt32BE(20);
  assert.equal(width,3200);assert.equal(height,1800);
  const {stdout}=await execute(ffmpeg,['-v','error','-nostdin','-i',path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',timeout:15000,maxBuffer:width*height*3+1024});
  assert.equal(stdout.length,width*height*3);
  const matches=(x:number,y:number)=>pixelMatches(stdout,(y*width+x)*3,shade);
  const cx=Math.floor(width/2),cy=Math.floor(height/2);let count=0;
  for(let offset=0;offset<stdout.length;offset+=3)if(pixelMatches(stdout,offset,shade))count++;
  if(!matches(cx,cy))return {raster:{width,height},box:null,widthRatio:0,heightRatio:0,matchedFraction:count/(width*height)};
  // The contiguous central cross measures the actual slate rectangle, rather
  // than including an isolated similarly colored pixel in a surrounding matte.
  let left=cx,right=cx,top=cy,bottom=cy;
  while(left>0&&matches(left-1,cy))left--;while(right+1<width&&matches(right+1,cy))right++;
  while(top>0&&matches(cx,top-1))top--;while(bottom+1<height&&matches(cx,bottom+1))bottom++;
  const box={x:left,y:top,width:right-left+1,height:bottom-top+1};
  return {raster:{width,height},box,widthRatio:box.width/width,heightRatio:box.height/height,matchedFraction:count/(width*height)};
}
function fullRaster(value:Coverage){return !!value.box&&value.box.x<=2&&value.box.y<=2&&value.box.width>=value.raster.width-4&&value.box.height>=value.raster.height-4&&value.matchedFraction>=0.995;}
async function compareOriginalFrames(directory:string,snapshots:Snapshot[]){
  const sourcePath=join(directory,'source.mp4');
  const {stdout:metadata}=await execute(ffprobe,['-v','error','-fflags','+nofillin','-select_streams','v:0','-show_streams','-show_frames','-show_entries','stream=width,height:frame=best_effort_timestamp_time','-of','json',sourcePath],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
  const probe=JSON.parse(metadata) as {streams:Array<{width:number;height:number}>;frames:Array<{best_effort_timestamp_time:string}>};
  assert.deepEqual([probe.streams[0]?.width,probe.streams[0]?.height],[3200,1800]);
  assert.ok(probe.frames.length>0&&probe.frames.length<=maximumFrames,`Retained ${probe.frames.length} frames; this bounded diagnostic admits 1..${maximumFrames}, never silently truncates.`);
  const sampleBytes=80*45*3;
  const {stdout:pixels}=await execute(ffmpeg,['-v','error','-nostdin','-fflags','+nofillin','-i',sourcePath,'-map','0:v:0','-vf','scale=80:45:flags=area','-fps_mode','passthrough','-enc_time_base','demux','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',timeout:15000,maxBuffer:maximumFrames*sampleBytes+1024});
  assert.equal(pixels.length,probe.frames.length*sampleBytes,'Each decoded sample must keep its original frame identity.');
  const runs:Array<{shade:Shade;first:number;last:number}>=[];
  for(let index=0;index<probe.frames.length;index++){
    const center=index*sampleBytes+(22*80+40)*3;
    const shade:Shade|undefined=pixelMatches(pixels,center,'white')?'white':pixelMatches(pixels,center,'gray')?'gray':undefined;
    if(!shade)continue;const last=runs.at(-1);
    if(last?.shade===shade&&last.last===index-1)last.last=index;else runs.push({shade,first:index,last:index});
  }
  const comparison=[];
  const expected=['opening-white','opening-gray','ending-white','ending-gray'];
  await writeFile(join(directory,'recorded-slate-runs.json'),JSON.stringify({frameCount:probe.frames.length,runs},null,2)+'\n',{flag:'wx',mode:0o600});
  assert.deepEqual(runs.map(run=>run.shade),['white','gray','white','gray'],'The native recording must contain both distinct opening and ending slate pairs.');
  for(const [index,run] of runs.entries()){
    const name=expected[index],frame=Math.floor((run.first+run.last)/2),recorded=`${name}-recorded.png`;
    await execute(ffmpeg,['-v','error','-nostdin','-n','-i',sourcePath,'-vf',`select=eq(n\\,${frame})`,'-frames:v','1',join(directory,recorded)],{encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
    const observed=snapshots.find(item=>item.name===name);assert.ok(observed);
    const screenshot=await coverage(join(directory,observed.screenshot),run.shade),native=await coverage(join(directory,recorded),run.shade);
    comparison.push({name,shade:run.shade,frame,pts:Number(probe.frames[frame].best_effort_timestamp_time),recorded,screenshot,native,
      fullScreenshot:fullRaster(screenshot),fullRecording:fullRaster(native)});
  }
  return {frameCount:probe.frames.length,comparison};
}

test('headed production launcher exposes document-to-native recording geometry without correcting it',{
  skip:enabled?false:'NOT QUALIFIED: opt-in WALKTHROUGH_CAPTURE_GEOMETRY_BROWSER_TEST=1 and exclusive headed browser/media resources required',timeout:180000,
},async t=>{
  assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');assert.ok(qualifiedNode(process.version));
  for(const executable of [qualifiedBrowserPath(),ffmpeg,ffprobe])await access(executable,constants.X_OK);
  const directory=await realpath(await mkdtemp('/private/tmp/wt-capture-geometry-')),profileDirectory=join(directory,'profile');
  await mkdir(profileDirectory,{mode:0o700});
  const snapshots:Snapshot[]=[];let context:BrowserContext|undefined,cdp:CDPSession|undefined,overlay:SlateCover|undefined,recording:Recording|undefined;
  let stopPromise:ReturnType<Recording['stop']>|undefined,closePromise:Promise<void>|undefined,closed=false,stage='launch';
  const stop=()=>{assert.ok(recording);return stopPromise??=recording.stop();};
  const close=async()=>{if(!context)return;await (closePromise??=context.close());closed=true;};
  const server=createServer((request,response)=>{if(request.url!=='/'){response.writeHead(404);response.end();return;}response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});response.end(fixture);});
  t.after(async()=>{
    const errors:unknown[]=[];
    if(recording)try{await stop();}catch(error){errors.push(error);}
    if(overlay)try{await overlay.remove();}catch(error){errors.push(error);}
    if(cdp)try{await cdp.detach();}catch{}
    try{await close();}catch(error){errors.push(error);}
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
    // Original pixels and measurements are the deliverable, even on success.
    // Only the exact disposable profile can go once its browser has closed.
    if(closed){assert.equal(await realpath(profileDirectory),profileDirectory);assert.ok((await lstat(profileDirectory)).isDirectory());await rm(profileDirectory,{recursive:true,force:false});}
    t.diagnostic(`Geometry evidence retained: ${directory}. Last stage: ${stage}. No window/emulation correction or automatic retry was performed.`);
    if(errors.length)throw new AggregateError(errors,`Original geometry recorder/browser did not settle cleanly; retain ${directory}.`);
  });
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
    context=await openSessionBrowser({profileDirectory,headless:false,network:'loopback-only'});
    const page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(10000);
    await page.goto(origin,{waitUntil:'load',timeout:10000});cdp=await context.newCDPSession(page);
    const surface=pageCaptureSurface(page);
    const retain=async(name:string)=>{const item=await snapshot(page,cdp!,directory,name);snapshots.push(item);await writeFile(join(directory,'geometry.json'),JSON.stringify({kind:'synthetic-geometry-diagnostic',clockQualified:false,launcher:'openSessionBrowser',recorder:'pageCaptureSurface.startRecording',snapshots},null,2)+'\n',{mode:0o600});return item;};
    await retain('before');
    stage='opening cover and native recording';overlay=await surface.cover();recording=await surface.startRecording(join(directory,'source.mp4'));
    const hold=async(name:string,shade:Shade)=>{assert.ok(overlay);await overlay.color(shade==='white'?'#fff':'#777');await delay(250);await retain(name);await delay(250);};
    await hold('opening-white','white');await hold('opening-gray','gray');await overlay.remove();overlay=undefined;
    stage='live fictional document';await retain('live');await delay(250);
    stage='ending cover';overlay=await surface.cover();await hold('ending-white','white');await hold('ending-gray','gray');
    stage='original recorder stop';const timing=await stop();await writeFile(join(directory,'recording-timing.json'),JSON.stringify(timing,null,2)+'\n',{flag:'wx',mode:0o600});
    await overlay.remove();overlay=undefined;await retain('after');await cdp.detach();cdp=undefined;await close();

    stage='offline comparison of original screenshots and native frames';
    const result=await compareOriginalFrames(directory,snapshots);
    await writeFile(join(directory,'geometry-result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    for(const item of result.comparison)t.diagnostic(`${item.name}: screenshot ${JSON.stringify(item.screenshot.box)}; native ${JSON.stringify(item.native.box)}; native width/height ratios ${item.native.widthRatio}/${item.native.heightRatio}.`);
    for(const item of snapshots){assert.deepEqual(item.screenshotPixels,{width:3200,height:1800});assert.deepEqual(item.dom.inner,{width:1600,height:900});assert.equal(item.dom.dpr,2);}
    assert.ok(result.comparison.every(item=>item.fullScreenshot),'A production cover does not fill an observed native screenshot; inspect geometry.json and retained pixels.');
    assert.ok(result.comparison.every(item=>item.fullRecording),'Document screenshots and recorded slates disagree: the production recorder has an inset/crop. Inspect geometry-result.json; do not qualify or resize these bytes.');
    stage='geometry matched on this original occurrence';
  }catch(error){
    await writeFile(join(directory,'failure.json'),JSON.stringify({stage,error:error instanceof Error?{name:error.name,message:error.message}:String(error)},null,2)+'\n',{flag:'wx',mode:0o600});
    throw error;
  }
});
