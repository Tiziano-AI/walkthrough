import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {chromium,type Page} from 'playwright';
import {installSlateCover} from '../src/capture/surface.ts';
import {qualifiedBrowserPath} from '../src/core/environment.ts';
import {resolveLocalTools} from '../src/core/toolchain.ts';

const customScrollbars=`
  html::-webkit-scrollbar,body::-webkit-scrollbar{width:27px!important;height:23px!important;background:#19ed31!important}
  html::-webkit-scrollbar-track,body::-webkit-scrollbar-track{background:#0bdded!important;border:3px solid #e31372!important}
  html::-webkit-scrollbar-thumb,body::-webkit-scrollbar-thumb{background:#ed12de!important;border:4px solid #eecc09!important}
  html::-webkit-scrollbar-corner,body::-webkit-scrollbar-corner{background:#e91210!important;border:2px solid #18ccdf!important}
`;
type Fixture={name:string;quirks?:boolean;css?:string;rootStyle?:string;bodyStyle?:string;independentBody?:boolean;custom?:boolean};
const fixtures:Fixture[]=[
  {name:'standards viewport with native scrollbars'},
  {name:'quirks viewport with native scrollbars',quirks:true},
  {name:'standards custom root and body scrollbar borders',css:customScrollbars,custom:true},
  {name:'quirks custom root and body scrollbar borders',quirks:true,css:customScrollbars,custom:true},
  {name:'standard colored scrollbars with both stable gutters',rootStyle:'scrollbar-width: auto !important; scrollbar-color: rgb(201, 14, 79) rgb(17, 202, 151) !important; scrollbar-gutter: stable both-edges !important;'},
  {name:'thin colored scrollbars with both stable gutters',rootStyle:'scrollbar-width: thin !important; scrollbar-color: rgb(231, 117, 3) rgb(49, 12, 211) !important; scrollbar-gutter: stable both-edges !important;'},
  {name:'independently scrolling body and viewport',css:`${customScrollbars}html{overflow:auto}`,custom:true,independentBody:true,bodyStyle:'width: 1200px; height: 800px; overflow: scroll; margin: 24px; --retained-body: yes;'},
  {name:'thin viewport with independently scrolling legacy body',css:`${customScrollbars}html{overflow:auto}`,rootStyle:'scrollbar-width: thin !important; scrollbar-color: auto !important;',independentBody:true,bodyStyle:'width: 1200px; height: 800px; overflow: scroll; margin: 24px; --retained-body: yes;'},
];

function html(fixture:Fixture):string{
  return `${fixture.quirks?'':'<!doctype html>'}<html style="${fixture.rootStyle??'--retained-root: yes;'}"><head><style>
    html{background:#254871}body{margin:0;background:#57a324}#terrain{width:1800px;height:1700px;background:linear-gradient(135deg,#62318a,#bc657a)}
    #review{position:fixed;left:50px;top:40px;width:260px;height:90px;margin:0;background:#4674ab}
    ${fixture.css??''}
  </style></head><body style="${fixture.bodyStyle??'--retained-body: yes;'}"><div id="terrain"></div><dialog id="review"><input id="draft" value="initial"><button id="approve">Approve</button></dialog></body></html>`;
}

async function prepare(page:Page,fixture:Fixture):Promise<void>{
  await page.setContent(html(fixture));
  await page.evaluate(independent=>{
    (window as any).retainedIdentity={};
    const input=document.querySelector('#draft') as HTMLInputElement;
    input.value='unsaved review decision';
    (document.querySelector('#review') as HTMLDialogElement).showModal();
    input.focus();
    window.scrollTo(137,159);
    if(independent){document.body.scrollLeft=211;document.body.scrollTop=173;}
  },Boolean(fixture.independentBody));
}

async function snapshot(page:Page){
  return page.evaluate(()=>{
    const geometry=(element:HTMLElement)=>{
      const rect=element.getBoundingClientRect();
      return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,clientWidth:element.clientWidth,clientHeight:element.clientHeight,scrollWidth:element.scrollWidth,scrollHeight:element.scrollHeight,scrollLeft:element.scrollLeft,scrollTop:element.scrollTop};
    };
    return {html:document.documentElement.outerHTML,rootStyle:document.documentElement.getAttribute('style'),bodyStyle:document.body.getAttribute('style'),active:document.activeElement?.id,value:(document.querySelector('#draft') as HTMLInputElement).value,modal:(document.querySelector('#review') as HTMLDialogElement).open,
      geometry:{window:{width:innerWidth,height:innerHeight,x:scrollX,y:scrollY},root:geometry(document.documentElement),body:geometry(document.body),scrollingElement:document.scrollingElement?.tagName},
    };
  });
}

function extrema(png:Buffer):{min:number;max:number;bytes:number}{
  // Decode every original screenshot pixel, including viewport gutters and
  // scrollbar corners. No resizing, edge exclusion or color mask can hide an
  // uncovered scrollbar here. The bytes remain in memory only.
  const pixels=execFileSync(resolveLocalTools().ffmpegPath,['-v','error','-f','image2pipe','-i','pipe:0','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input:png,maxBuffer:8*1024*1024});
  let min=255,max=0;
  for(const pixel of pixels){min=Math.min(min,pixel);max=Math.max(max,pixel);}
  return {min,max,bytes:pixels.length};
}

test('calibration slates cover real root and body scrollbars without changing the application',async t=>{
  const browser=await chromium.launch({executablePath:qualifiedBrowserPath(),headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
  try{
    for(const fixture of fixtures)await t.test(fixture.name,async()=>{
      const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:1});
      try{
        await prepare(page,fixture);
        const before=await snapshot(page);
        const identity=await page.evaluateHandle(()=>(window as any).retainedIdentity);
        const scrollbar=await page.evaluate(()=>{
          const element=document.scrollingElement as HTMLElement;
          return {x:innerWidth-element.clientWidth,y:innerHeight-element.clientHeight,custom:getComputedStyle(element,'::-webkit-scrollbar').width};
        });
        assert.ok(scrollbar.x>0,'the regression fixture must expose an actual viewport scrollbar; headless default hiding would conceal the defect');
        if(fixture.custom)assert.equal(scrollbar.custom,'27px','custom scrollbar styling must reach the actual viewport scrollbar');
        if(fixture.independentBody){
          assert.equal(before.geometry.body.scrollLeft,211);assert.equal(before.geometry.body.scrollTop,173);
          assert.equal(before.geometry.body.width-before.geometry.body.clientWidth,27,'body must retain its actual custom vertical scrollbar width');
          assert.equal(before.geometry.body.height-before.geometry.body.clientHeight,23,'body must retain its actual custom horizontal scrollbar height');
        }
        const cover=await page.evaluateHandle(installSlateCover);
        const samples:{color:string;min:number;max:number;bytes:number}[]=[];
        try{
          for(const color of ['#000','#fff']){
            await cover.evaluate((value,color)=>value.color(color),color);
            const during=await snapshot(page);
            assert.deepEqual(during.geometry,before.geometry,'covering a scrollbar must not resize, reflow or scroll the application');
            assert.equal(during.active,before.active);assert.equal(during.value,before.value);assert.equal(during.modal,true);
            assert.equal(await identity.evaluate(value=>value===(window as any).retainedIdentity),true);
            samples.push({color,...extrema(await page.screenshot({animations:'allow',caret:'initial',scale:'device'}))});
          }
        }finally{await cover.evaluate(value=>value.remove());await cover.dispose();await identity.dispose();}
        assert.deepEqual(await snapshot(page),before,'removal must restore exact DOM, root/body inline attributes, focus and scroll geometry');
        assert.deepEqual(samples,[{color:'#000',min:0,max:0,bytes:960*640*3},{color:'#fff',min:255,max:255,bytes:960*640*3}],'every original pixel, including native scrollbar tracks, thumbs, borders and corners, must have the requested slate color');
      }finally{await page.close();}
    });
  }finally{await browser.close();}
});

test('a slate refused for application layout change removes its own DOM and styles',async()=>{
  const browser=await chromium.launch({executablePath:qualifiedBrowserPath(),headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
  try{
    const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:1});
    await prepare(page,{name:'layout-sensitive root',css:'html:has(> div){width:calc(100% - 8px)!important}',rootStyle:'scrollbar-color: rgb(17, 91, 211) rgb(199, 28, 83) !important;'});
    const before=await snapshot(page);
    await assert.rejects(()=>page.evaluateHandle(installSlateCover),/CAPTURE_SLATE_LAYOUT_CHANGED/);
    assert.deepEqual(await snapshot(page),before,'a failed cover must restore exact application state rather than strand an invisible capture overlay or scrollbar override');
  }finally{await browser.close();}
});

test('slate removal restores its paint without discarding concurrent application style changes',async()=>{
  const browser=await chromium.launch({executablePath:qualifiedBrowserPath(),headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
  try{
    const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:1});
    await prepare(page,{name:'concurrent application style',rootStyle:'scrollbar-color: rgb(17, 91, 211) rgb(199, 28, 83) !important; background-color: rgb(21, 54, 87) !important; --retained-root: yes;'});
    const properties=()=>page.evaluate(()=>{
      const style=document.documentElement.style;
      return ['scrollbar-color','background-color','--retained-root'].map(name=>({name,value:style.getPropertyValue(name),priority:style.getPropertyPriority(name)}));
    });
    const before=await properties();
    const cover=await page.evaluateHandle(installSlateCover);
    try{
      await cover.evaluate(value=>value.color('#fff'));
      await page.evaluate(()=>document.documentElement.style.setProperty('--application-update','retained'));
      await cover.evaluate(value=>value.color('#000'));
    }finally{await cover.evaluate(value=>value.remove());await cover.dispose();}
    assert.deepEqual(await properties(),before,'a separate app style change must not strand normalized capture colors or prevent restoration of its owned paint');
    assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--application-update')),'retained');

    const changed=await page.evaluateHandle(installSlateCover);
    try{
      await changed.evaluate(value=>value.color('#000'));
      await page.evaluate(()=>document.documentElement.style.setProperty('scrollbar-color','rgb(11, 22, 33) rgb(44, 55, 66)','important'));
    }finally{await changed.evaluate(value=>value.remove());await changed.dispose();}
    assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('scrollbar-color')),'rgb(11, 22, 33) rgb(44, 55, 66)','cleanup must not overwrite a newer application-owned scrollbar color');
  }finally{await browser.close();}
});

test('slate repaint and removal retain newer application-owned background and scrollbar paint',async()=>{
  const browser=await chromium.launch({executablePath:qualifiedBrowserPath(),headless:true,ignoreDefaultArgs:['--hide-scrollbars']});
  try{
    const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:1});
    await prepare(page,{name:'application paint changes between slate colors',
      rootStyle:'background: rgb(21, 54, 87) !important; scrollbar-color: rgb(17, 91, 211) rgb(199, 28, 83) !important; --retained-root: original;',
      bodyStyle:'scrollbar-color: rgb(29, 43, 57) rgb(61, 75, 89) !important; --retained-body: original;',
    });
    const original=await snapshot(page);
    const properties=()=>page.evaluate(()=>{
      const values=(element:HTMLElement,names:string[])=>names.map(name=>({name,value:element.style.getPropertyValue(name),priority:element.style.getPropertyPriority(name)}));
      return {root:values(document.documentElement,['background-color','background-image','background-position-x','background-position-y','background-size','background-repeat','background-attachment','background-origin','background-clip','scrollbar-color','--retained-root','--application-update']),
        body:values(document.body,['scrollbar-color','--retained-body'])};
    });
    const cover=await page.evaluateHandle(installSlateCover);
    let expected:Awaited<ReturnType<typeof properties>>;
    try{
      await cover.evaluate(value=>value.color('#000'));
      // These are genuine application changes made while the first slate is
      // present, not changes to the recorder or its private overlay. A later
      // slate must cover them temporarily, then restore these latest values.
      await page.evaluate(()=>{
        const style=document.documentElement.style;
        style.setProperty('background','linear-gradient(rgb(31, 42, 53), rgb(64, 75, 86)) 13px 17px / 71px 83px repeat-y fixed padding-box content-box rgb(14, 28, 42)');
        style.setProperty('background-color','rgb(91, 102, 113)','important');
        style.setProperty('scrollbar-color','rgb(11, 22, 33) rgb(44, 55, 66)');
        style.setProperty('--application-update','preserved');
        document.body.style.setProperty('scrollbar-color','rgb(77, 88, 99) rgb(111, 122, 133)','important');
      });
      expected=await properties();
      assert.equal(expected.root.find(item=>item.name==='background-image')?.value,'linear-gradient(rgb(31, 42, 53), rgb(64, 75, 86))','the fixture must install a real replacement background, not a rejected CSS value');
      await cover.evaluate(value=>value.color('#fff'));
      await cover.evaluate(value=>value.color('#000'));
    }finally{await cover.evaluate(value=>value.remove());await cover.dispose();}
    assert.deepEqual(await properties(),expected,'repainting must retain the newest application values and priorities, not the values saved when capture started');
    const after=await snapshot(page);
    assert.deepEqual(after.geometry,original.geometry);
    assert.equal(after.active,original.active);assert.equal(after.value,original.value);assert.equal(after.modal,true);
  }finally{await browser.close();}
});
