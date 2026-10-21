import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {qualifiedBrowserPath} from '../src/core/environment.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';
import {chromium} from 'playwright';
import {beginTake} from '../src/capture/take.ts';
import {execFileSync} from 'node:child_process';

const browserPath=qualifiedBrowserPath();
const tools={...resolveLocalTools(),nodePath:process.execPath,browserPath};

test('calibrated repeated takes preserve the same live document, dialog and unsaved form without navigation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'walkthrough-page-calibration-'));
  const browser=await chromium.launch({executablePath:browserPath,headless:true,args:['--screen-info={3200x1800 devicePixelRatio=2}']});
  let passed=false;
  try{
    const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:2});
    await page.route('https://synthetic.invalid/**',route=>route.fulfill({contentType:'text/html',body:'<style>body{background:#234}dialog{background:#426;color:white}</style><dialog id="review"><form><input id="draft" value="initial"><button>Approve</button></form></dialog><script>window.pageIdentity={};window.form=document.querySelector("form");window.submissions=0;window.form.onsubmit=e=>{e.preventDefault();window.submissions++};document.querySelector("dialog").showModal();document.querySelector("input").value="unsaved consent selection";</script>'}));
    await page.goto('https://synthetic.invalid/consent#review');
    const requests:string[]=[];page.on('request',request=>requests.push(request.url()));
    const identity=await page.evaluateHandle(()=>(window as any).pageIdentity);
    const before=await page.evaluate(()=>({url:location.href,html:document.documentElement.outerHTML,active:document.activeElement?.id,value:(document.querySelector('#draft') as HTMLInputElement).value}));
    for(let index=0;index<2;index++){
      const takeDirectory=join(directory,`take-${index}`);await mkdir(takeDirectory);
      const take=await beginTake(page,tools,takeDirectory);
      try{
        assert.equal(page.url(),before.url,'starting capture must not navigate away from the live consent document');
        assert.equal(await identity.evaluate(value=>value===(window as any).pageIdentity),true,'JavaScript state must survive calibration');
        await page.waitForTimeout(350);
        const map=await take.finish();
        assert.ok(map.frameCount>0);assert.ok(map.uncertaintySeconds<=0.05);assert.ok(map.driftSeconds<=0.05);
        // Decode synthetic footage only. Before the opening white transition
        // and after the closing white transition, every sampled pixel must be
        // neutral slate, not the colored live modal or unsaved form beneath it.
        const probe=JSON.parse(execFileSync(tools.ffprobePath,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',take.sourcePath],{encoding:'utf8'}));
        const pixels=execFileSync(tools.ffmpegPath,['-v','error','-i',take.sourcePath,'-vf','scale=32:18:flags=area','-fps_mode','passthrough','-f','rawvideo','-pix_fmt','gray','pipe:1'],{maxBuffer:4*1024*1024});
        const size=32*18;
        const frames=probe.frames.map((frame:any,i:number)=>({pts:Number(frame.best_effort_timestamp_time),pixels:pixels.subarray(i*size,(i+1)*size)}));
        assert.equal(pixels.length,frames.length*size);
        const clock=JSON.parse(await readFile(join(takeDirectory,'capture-clock.json'),'utf8'));
        const openingThrough=clock.start.beforeMs/1000+map.offsetSeconds+0.15;
        const closingFrom=clock.end.afterMs/1000+map.offsetSeconds-0.15;
        const covered=frames.filter((frame:any)=>frame.pts<=openingThrough||frame.pts>=closingFrom);
        assert.ok(covered.length>=4);
        assert.ok(frames.some((frame:any)=>frame.pixels.some((pixel:number)=>Math.abs(pixel-frame.pixels[0])>5)),'actual footage must reveal the nonuniform synthetic page between uniform slates');
        for(const frame of covered){
          assert.ok([0,119,255].some(level=>frame.pixels.every((pixel:number)=>Math.abs(pixel-level)<=5)),'a neutral slate must cover the whole viewport, including the existing top-layer dialog');
        }
      }finally{await take.abort();}
      assert.deepEqual(await page.evaluate(()=>({url:location.href,html:document.documentElement.outerHTML,active:document.activeElement?.id,value:(document.querySelector('#draft') as HTMLInputElement).value})),before);
      assert.equal(await page.evaluate(()=>(window as any).submissions),0);
    }
    assert.deepEqual(requests,[],'calibration must dispatch no network requests');
    passed=true;
  }finally{await browser.close();if(passed)await rm(directory,{recursive:true,force:true});else console.error(`Retained calibration diagnostics: ${directory}`);}
});
