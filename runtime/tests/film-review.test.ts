import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {chromium} from 'playwright';
import {createReviewPage} from '../src/core/review.ts';
import {executeLocal} from '../src/render/media.ts';
import {qualifiedBrowserPath} from '../src/core/environment.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';
import {isFrameAligned} from '../src/render/timeline.ts';

const input={presentation:'full-frame-visible-captions' as const,runId:'composition-synthetic',title:'Explore a product',goal:'Compare the product’s main view and result.',narration:'Start with the overview.\n\nCompare the result.',captionsVtt:'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nStart with the overview.\n\n00:00:01.000 --> 00:00:02.000\nCompare the result.\n'};
test('local review provides native playback, seekable transcript and bounded hashed controls',()=>{
  const html=createReviewPage(input),css=html.match(/<style>([\s\S]*?)<\/style>/)![1],script=html.match(/<script>([\s\S]*?)<\/script>/)![1];
  assert.match(html,/<video controls playsinline/);assert.doesNotMatch(html,/<track\b|autoplay/);
  assert.match(html,/id="fullscreen"/);assert.match(html,/id="copy-timestamp"/);assert.match(html,/data-seek="1"/);
  assert.match(html,/<details id="technical-files"><summary>Technical files<\/summary>/);
  assert.ok(html.includes(`style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'`));
  assert.ok(html.includes(`script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`));
  assert.match(html,/connect-src 'none'/);assert.match(html,/href="walkthrough.mp4" download/);
});
test('untrusted titles and transcript cannot enter script or redirect playback',()=>{
  const hostile='</script><script src="https://example.invalid/x">evil()</script>';
  const html=createReviewPage({...input,title:hostile,narration:hostile,captionsVtt:`WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${hostile}\n`});
  assert.equal((html.match(/<script>/g)??[]).length,1);assert.ok(!html.includes(hostile));
  assert.match(html,/&lt;\/script&gt;&lt;script src=&quot;/);assert.doesNotMatch(html,/<script src=/);
  assert.equal(html.match(/<script>([\s\S]*?)<\/script>/)![1],createReviewPage(input).match(/<script>([\s\S]*?)<\/script>/)![1]);
});
test('silent review omits transcript and retains playback controls',()=>{
  const html=createReviewPage({...input,narration:'',captionsVtt:'WEBVTT\n\n'});assert.doesNotMatch(html,/id="transcript"/);assert.match(html,/id="copy-timestamp"/);
});
test('review retains Unicode cue text and only explicitly declared local deliverables',()=>{
  const artifact={name:'drawing',title:'Drawing <draft>',mediaType:'application/json',role:'deliverable' as const,relativePath:'deliverables/drawing',sha256:'a'.repeat(64),bytes:42,filename:'My drawing.json'};
  const html=createReviewPage({...input,deliverables:[artifact],captionsVtt:'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nCafé &amp; Ω &lt;value&gt; 𐐀.\n'});
  assert.match(html,/Café &amp; Ω &lt;value&gt; 𐐀\./);
  assert.match(html,/href="deliverables\/drawing" download="My drawing.json">Drawing &lt;draft&gt; · application\/json/);
  assert.throws(()=>createReviewPage({...input,deliverables:[{...artifact,relativePath:'https://example.invalid/drawing'}]}),/INVALID_DELIVERED_ARTIFACT/);
});

test('transcript labels preserve VTT milliseconds and seek the original cue time',()=>{
  const html=createReviewPage({...input,captionsVtt:'WEBVTT\n\n00:00:12.817 --> 00:00:13.000\nInspect this change.\n\n01:02:03.045 --> 01:02:04.000\nInspect the next change.\n'});
  assert.match(html,/data-seek="12\.817" aria-label="Seek to 00:00:12\.817">00:00:12\.817<\/button>/);
  assert.match(html,/data-seek="3723\.045" aria-label="Seek to 01:02:03\.045">01:02:03\.045<\/button>/);
});

// Execute the shipped, CSP-hashed script rather than testing a second formatter.
// The small DOM double only supplies the player clock and clipboard boundary.
async function copyTimestamp(currentTime:number,clipboardAvailable:boolean){
  const listeners=new Map<string,()=>Promise<void>>();
  const output={value:'',hidden:true,focused:false,selected:false,focus(){this.focused=true;},select(){this.selected=true;}};
  const status={textContent:''};let copied:string|undefined;
  const document={
    querySelector:()=>({currentTime}),querySelectorAll:()=>[],
    getElementById:(id:string)=>id==='timestamp-copy'?output:id==='player-status'?status:{addEventListener:(_event:string,listener:()=>Promise<void>)=>listeners.set(id,listener)},
  };
  const navigator={clipboard:clipboardAvailable?{writeText:async(value:string)=>{copied=value;}}:undefined};
  const script=createReviewPage(input).match(/<script>([\s\S]*?)<\/script>/)![1];
  runInNewContext(script,{document,navigator});
  await listeners.get('copy-timestamp')!();
  return {output,status,copied};
}

test('copied feedback keeps the media clock and identifies a usable nearest 60 fps edit boundary',async()=>{
  for(const [time,clock,frame,editSeconds] of [
    [12.8,'00:00:12.800',768,'12.8'],
    [0,'00:00:00.000',0,'0'],
    [12.817,'00:00:12.817',769,'12.816666666666666'],
    [0.0166667,'00:00:00.017',1,'0.016666666666666666'],
    [59.9996,'00:01:00.000',3600,'60'],
    [3600.05,'01:00:00.050',216003,'3600.05'],
  ] as const){
    const {output,status,copied}=await copyTimestamp(time,true);
    assert.equal(copied,`${clock} (media ${time} s) · nearest output edit boundary ${frame} at 60 fps (zero-based; ${editSeconds} s)`);
    assert.equal(output.value,copied);assert.equal(output.hidden,true);assert.equal(status.textContent,`Copied ${copied}`);
    const seconds=Number(copied!.match(/; ([\d.]+) s\)/)![1]);
    assert.equal(Math.round(seconds*60),frame);assert.equal(isFrameAligned(seconds),true,'copied seconds are accepted on the public edit grid');
  }
});

test('manual clipboard fallback preserves the same precise feedback',async()=>{
  const {output,status,copied}=await copyTimestamp(12.817,false);
  assert.equal(copied,undefined);
  assert.equal(output.value,'00:00:12.817 (media 12.817 s) · nearest output edit boundary 769 at 60 fps (zero-based; 12.816666666666666 s)');
  assert.equal(output.hidden,false);assert.equal(output.focused,true);assert.equal(output.selected,true);
  assert.equal(status.textContent,'Timestamp selected. Copy it with your keyboard.');
});

test('invalid or unsafe media clocks report unavailable without copying a false position',async()=>{
  for(const time of [NaN,Infinity,-Infinity,-0.001,Number.MAX_SAFE_INTEGER/60+1]){
    const {output,status,copied}=await copyTimestamp(time,true);
    assert.equal(copied,undefined);assert.equal(output.value,'');assert.equal(output.hidden,true);
    assert.equal(status.textContent,'Timestamp unavailable.');
  }
});

test('portable review seeks and copies timestamps with no app or network dependency',{skip:![qualifiedBrowserPath(),resolveLocalTools().ffmpegPath].every(existsSync),timeout:60000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'film-review-'));
  await writeFile(join(directory,'review.html'),createReviewPage(input));
  await executeLocal(resolveLocalTools().ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=2','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-movflags','+faststart',join(directory,'walkthrough.mp4')],join(directory,'video.log'),30000);
  await executeLocal(resolveLocalTools().ffmpegPath,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','color=c=0x30483b:size=640x360','-frames:v','1',join(directory,'poster.png')],join(directory,'poster.log'),30000);
  const browser=await chromium.launch({executablePath:qualifiedBrowserPath(),headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),requests:string[]=[],errors:string[]=[];
    await context.route(/^https?:/,async route=>{requests.push(route.request().url());await route.abort();});
    await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:undefined}));
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.goto(pathToFileURL(join(directory,'review.html')).href);
    await page.waitForFunction(()=>document.querySelector('video')!.readyState>=1);
    assert.equal(await page.locator('video').evaluate((video:HTMLVideoElement)=>video.paused),true);
    assert.equal(await page.locator('video').evaluate((video:HTMLVideoElement)=>video.textTracks.length),0);
    await page.locator('#transcript summary').click();
    await page.getByRole('button',{name:'Seek to 00:00:01.000',exact:true}).click();
    assert.equal(await page.locator('video').evaluate((video:HTMLVideoElement)=>video.currentTime),1);
    await page.getByRole('button',{name:'Copy timestamp'}).click();
    assert.equal(await page.locator('#timestamp-copy').inputValue(),'00:00:01.000 (media 1 s) · nearest output edit boundary 60 at 60 fps (zero-based; 1 s)');
    assert.equal(await page.locator('#timestamp-copy').isVisible(),true);
    assert.match(await page.locator('#player-status').innerText(),/Copy it with your keyboard/);
    await page.getByRole('button',{name:'Full screen',exact:true}).click();
    await page.waitForFunction(()=>document.fullscreenElement===document.querySelector('video'));
    await page.evaluate(()=>document.exitFullscreen());
    for(const width of [1440,640,375,320]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
    assert.deepEqual(requests,[]);assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});
