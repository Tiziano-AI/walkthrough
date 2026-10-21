import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import React from 'react';
import {chromium} from 'playwright';
import {qualifiedBrowserPath} from '../src/core/environment.ts';
import {captionOverlayAtFrame,captionOverlayBoxesAtFrame,layoutCaption} from '../src/render/captions.ts';
import {WalkthroughFrame,type CompositionProps} from '../src/render/composition.ts';
import type {Timeline} from '../src/render/timeline.ts';

const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup(node:React.ReactNode):string};
const timeline:Timeline={sourceWidth:3200,sourceHeight:1800,sources:{source:{pointer:[]}},segments:[
  {id:'first',sourceId:'source',kind:'live',transition:'cut',sourceStartSeconds:0,sourceEndSeconds:2,outputStartSeconds:0,durationSeconds:2,zoom:1,target:null},
  {id:'second',sourceId:'source',kind:'live',transition:'cut',sourceStartSeconds:2,sourceEndSeconds:4,outputStartSeconds:2,durationSeconds:2,zoom:1,target:null,captionPlacement:{x:100,y:100,width:800}},
],narration:[{id:'voice',outputStartSeconds:0,durationSeconds:4,captions:[
  {text:'Explore the frontier.',startSeconds:.5,endSeconds:1},
  {text:'Compare the cost and quality.',startSeconds:1.5,endSeconds:2.5},
]}]};

function captionElements(node:React.ReactNode):React.ReactElement<Record<string,unknown>>[]{
  if(!React.isValidElement<Record<string,unknown>>(node))return [];
  if(node.props['data-caption-line']!==undefined)return [node];
  return React.Children.toArray(node.props.children as React.ReactNode).flatMap(captionElements);
}

test('backings use only exact text-sized rectangles inside the authored strip',()=>{
  assert.deepEqual(layoutCaption('iii',{x:100,y:200,width:400}).lines,[{text:'iii',box:{x:274,y:226,width:52,height:44}}]);
  const two=layoutCaption('First line.\nSecond line.',{x:100,y:200,width:400});
  assert.equal(two.lines.length,2);
  assert.equal(two.lines[0].box.y,202);
  assert.equal(two.lines[1].box.y,250);
  assert.ok(two.lines.every(line=>line.box.width<400&&line.box.height===44));
  assert.equal(two.text,'First line.\nSecond line.');
});

test('overlay and QA boxes follow speech and switch placement on the cut frame',()=>{
  for(const frame of [0,29,60,89,150,239,240]){
    assert.equal(captionOverlayAtFrame(timeline,frame),null,`no speech at frame ${frame}`);
    assert.deepEqual(captionOverlayBoxesAtFrame(timeline,frame),[]);
  }
  assert.equal(captionOverlayAtFrame(timeline,30)?.text,'Explore the frontier.');
  assert.equal(captionOverlayAtFrame(timeline,59)?.text,'Explore the frontier.');
  assert.equal(captionOverlayAtFrame(timeline,119)?.lines[0].box.y,974);
  assert.equal(captionOverlayAtFrame(timeline,120)?.lines[0].box.y,126);
  assert.equal(captionOverlayAtFrame(timeline,149)?.lines[0].box.y,126);
  assert.ok(captionOverlayBoxesAtFrame(timeline,120).every(box=>box.x>=100&&box.x+box.width<=900));
});

test('text fit wraps at a word boundary or rejects, never drops words or shrinks type',()=>{
  const text='Compare frontier quality with the actual response cost.';
  const result=layoutCaption(text,{x:100,y:200,width:440});
  assert.equal(result.lines.length,2);
  assert.equal(result.lines.map(line=>line.text).join(' '),text);
  assert.ok(result.lines.every(line=>line.box.width<=440));
  for(const [text,width] of [['This cannot fit into a tiny placement.',100],['W'.repeat(80),1200],['a\nb\nc',1200]] as const){
    assert.throws(()=>layoutCaption(text,{x:100,y:200,width}),/render:caption_does_not_fit/);
  }
  assert.throws(()=>layoutCaption('Outside the frame.',{x:1900,y:100,width:400}),/render:invalid_caption_placement/);
});

test('actual rendered caption DOM fits glyphs, stays neutral and matches QA boxes', {skip:!existsSync(qualifiedBrowserPath()),timeout:30000},async()=>{
  const browser=await chromium.launch({executablePath:qualifiedBrowserPath(),headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1920,height:1080}});
    for(const [text,width] of [
      ['Explore the frontier.',1200],
      ['Compare frontier quality with the actual response cost.',440],
      ['WWW MMM minimum ill 12345, café naïve “quotes” ½ Ω 𐐀.',1200],
      ['Keep\u2003the\u00a0canonical\u2009spaces.',1200],
      ['Read this first.\nThen inspect the detail.',800],
    ] as const){
      const model:Timeline={...timeline,segments:[{...timeline.segments[0],captionPlacement:{x:100,y:200,width}}],narration:[{id:'voice',outputStartSeconds:0,durationSeconds:2,captions:[{text,startSeconds:.5,endSeconds:1.5}]}]};
      const props:CompositionProps={presentation:'full-frame-visible-captions',sourceFiles:{source:{file:'synthetic.mp4',windows:[{sourceStartFrame:0,frameCount:120,stagedStartFrame:0}]}},audioFiles:{voice:'synthetic.wav'},timeline:model};
      const nodes=captionElements(WalkthroughFrame({...props,frame:60}));
      await page.setContent(`<html><body style="margin:0;background:#eee">${nodes.map(node=>renderToStaticMarkup(node)).join('')}</body></html>`);
      const actual=await page.locator('[data-caption-line]').evaluateAll(elements=>elements.map(element=>{
        const box=element.getBoundingClientRect(),style=getComputedStyle(element),range=document.createRange();range.selectNodeContents(element);
        const textBox=range.getBoundingClientRect();
        return {text:element.textContent,box:{x:box.x,y:box.y,width:box.width,height:box.height},textBox:{x:textBox.x,y:textBox.y,width:textBox.width,height:textBox.height},font:style.fontFamily,fontSize:style.fontSize,color:style.color,background:style.backgroundColor,overflow:style.overflow};
      }));
      assert.deepEqual(actual.map(line=>line.box),captionOverlayBoxesAtFrame(model,60));
      assert.deepEqual(actual.map(line=>line.text),captionOverlayAtFrame(model,60)!.lines.map(line=>line.text));
      for(const line of actual){
        assert.equal(line.fontSize,'30px');assert.match(line.font,/Arial/);assert.equal(line.color,'rgb(255, 255, 255)');
        assert.equal(line.background,'rgba(0, 0, 0, 0.68)');assert.equal(line.overflow,'hidden');
        assert.ok(line.textBox.width<=line.box.width-28,`all glyphs fit without clipping: ${line.text}`);
        assert.ok(line.textBox.x>=line.box.x+14&&line.textBox.x+line.textBox.width<=line.box.x+line.box.width-14);
        assert.ok(line.textBox.y>=line.box.y&&line.textBox.y+line.textBox.height<=line.box.y+line.box.height);
      }
    }
  }finally{await browser.close();}
});
