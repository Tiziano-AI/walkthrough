import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {WalkthroughFrame,type CompositionProps} from '../src/render/composition.ts';
import {emphasisAtFrame} from '../src/render/emphasis.ts';
import {frameState,segmentTransform,type Timeline} from '../src/render/timeline.ts';

const timeline:Timeline={sourceWidth:3200,sourceHeight:1800,sources:{source:{pointer:[{timeSeconds:0,type:'down',x:1600,y:900,gesture:'drag'}]}},segments:[{
  id:'response',sourceId:'source',kind:'live',transition:'cut',sourceStartSeconds:0,sourceEndSeconds:4,outputStartSeconds:0,durationSeconds:4,zoom:1,target:null,
  cameraMove:{startSeconds:1,durationSeconds:2,zoom:1.5,target:null},
  emphasis:[{id:'relationship',kind:'outline',target:{x:1000,y:600,width:400,height:240},startSeconds:0,endSeconds:4}],
}],narration:[{id:'voice',outputStartSeconds:0,durationSeconds:4,captions:[{text:'Follow the response.',startSeconds:0,endSeconds:4}]}]};
const props:CompositionProps={presentation:'full-frame-visible-captions',timeline,sourceFiles:{source:{file:'source.mp4',windows:[{sourceStartFrame:0,frameCount:240,stagedStartFrame:0}]}},audioFiles:{voice:'voice.wav'}};
function elements(node:React.ReactNode):React.ReactElement<Record<string,unknown>>[]{
  if(!React.isValidElement<Record<string,unknown>>(node))return [];
  return [node,...React.Children.toArray(node.props.children as React.ReactNode).flatMap(elements)];
}

test('the projected source subject follows camera framing while outline thickness stays in output pixels',()=>{
  for(const [frame,expected] of [[30,{x:600,y:360,width:240,height:144}],[180,{x:420,y:270,width:360,height:216}]] as const){
    const tree=elements(WalkthroughFrame({...props,frame})),overlay=tree.find(node=>node.props['data-emphasis-id']==='relationship')!;
    const style=overlay.props.style as React.CSSProperties;
    assert.equal(overlay.props.width,1920);assert.equal(overlay.props.height,1080);assert.equal(style.transform,undefined);
    assert.equal(style.pointerEvents,'none');
    const lines=tree.filter(node=>node.type==='rect');assert.equal(lines.length,2);
    for(const line of lines)for(const key of ['x','y','width','height'] as const)assert.ok(Math.abs(Number(line.props[key])-expected[key])<1e-9,`${key} matches hand-projected geometry`);
    assert.equal(lines.find(line=>line.props['data-emphasis-stroke']==='outline')!.props.strokeWidth,3);
    assert.equal(lines.find(line=>line.props['data-emphasis-stroke']==='backing')!.props.strokeWidth,5);
  }
});

test('outline and spotlight share the exact projected rectangle; the mild outside dim leaves pointer and captions above it',()=>{
  const spotlight=structuredClone(timeline);spotlight.segments[0].emphasis![0].kind='spotlight';
  const outlineTree=elements(WalkthroughFrame({...props,frame:120})),spotlightTree=elements(WalkthroughFrame({...props,timeline:spotlight,frame:120}));
  assert.deepEqual(spotlightTree.filter(node=>node.type==='rect').map(node=>node.props),outlineTree.filter(node=>node.type==='rect').map(node=>node.props));
  const dim=spotlightTree.find(node=>node.props['data-emphasis-dim']==='relationship')!;
  assert.equal(dim.props.opacity,.28);assert.equal(dim.props.fillRule,'evenodd');
  const coordinates=String(dim.props.d).match(/-?\d+(?:\.\d+)?/g)!.map(Number),expected=[0,0,1920,1080,0,510,315,810,495,510];
  assert.equal(coordinates.length,expected.length);coordinates.forEach((coordinate,index)=>assert.ok(Math.abs(coordinate-expected[index])<1e-9,'An exact projected hole, not a scaled or misplaced source rectangle'));
  const dimIndex=spotlightTree.indexOf(dim),cursorIndex=spotlightTree.findIndex(node=>node.type==='svg'&&node.props.width===36),captionIndex=spotlightTree.findIndex(node=>node.props['data-caption-line']===0);
  assert.ok(cursorIndex>dimIndex);assert.ok(captionIndex>cursorIndex);
});

test('emphasis uses inclusive start/exclusive end with restrained symmetric smooth fade, including a one-frame interval',()=>{
  const selected={...timeline.segments[0].emphasis![0],startSeconds:1,endSeconds:3},transform={scale:.6,x:0,y:0};
  assert.equal(emphasisAtFrame(selected,59,transform),null);assert.equal(emphasisAtFrame(selected,180,transform),null);
  const entry=emphasisAtFrame(selected,60,transform)!,next=emphasisAtFrame(selected,61,transform)!,full=emphasisAtFrame(selected,72,transform)!;
  assert.ok(entry.opacity>0&&entry.opacity<.01);assert.ok(next.opacity>entry.opacity);assert.equal(full.opacity,1);
  assert.equal(emphasisAtFrame(selected,179,transform)!.opacity,entry.opacity);
  assert.equal(emphasisAtFrame({...selected,endSeconds:61/60},60,transform)!.opacity,1,'A one-frame subject is visible, not an all-zero envelope');
  const short={...selected,endSeconds:1.1};
  for(let frame=60;frame<66;frame++)assert.ok(emphasisAtFrame(short,frame,transform)!.opacity>0&&emphasisAtFrame(short,frame,transform)!.opacity<=1);
});

test('a later picture activates emphasis on its local clock, without treating source or absolute output time as local',()=>{
  const later:Timeline={...timeline,segments:[
    {...timeline.segments[0],id:'orientation',sourceStartSeconds:0,sourceEndSeconds:2,durationSeconds:2,emphasis:undefined,cameraMove:undefined},
    {...timeline.segments[0],sourceStartSeconds:5,sourceEndSeconds:9,outputStartSeconds:2,emphasis:[{...timeline.segments[0].emphasis![0],startSeconds:1,endSeconds:3}]},
  ],narration:[]};
  const laterProps={...props,timeline:later,sourceFiles:{source:{file:'source.mp4',windows:[{sourceStartFrame:0,frameCount:120,stagedStartFrame:0},{sourceStartFrame:300,frameCount:240,stagedStartFrame:120}]}}};
  for(const frame of [119,120,179,300,359])assert.equal(elements(WalkthroughFrame({...laterProps,frame})).filter(node=>node.props['data-emphasis-id']).length,0,`No active emphasis at absolute frame ${frame}`);
  for(const frame of [180,181,299])assert.equal(elements(WalkthroughFrame({...laterProps,frame})).filter(node=>node.props['data-emphasis-id']).length,1);
  assert.equal(frameState(later,180).sourceFrame,360);
});

test('bounded preview retains the full film emphasis geometry and fade clock without rewriting intervals',()=>{
  const selected=structuredClone(timeline);selected.segments[0].sourceStartSeconds=17/60;selected.segments[0].sourceEndSeconds=257/60;
  selected.segments[0].emphasis![0].startSeconds=1;selected.segments[0].emphasis![0].endSeconds=3;
  const before=JSON.stringify(selected),preview={...props,timeline:selected,frameRange:[65,194] as [number,number],sourceFiles:{source:{file:'bounded.mp4',windows:[{sourceStartFrame:82,frameCount:130,stagedStartFrame:0}]}}};
  for(const frame of [65,71,120,179,180,194]){
    const full=elements(WalkthroughFrame({...props,timeline:selected,frame,sourceFiles:{source:{file:'source.mp4',windows:[{sourceStartFrame:17,frameCount:240,stagedStartFrame:0}]}}})),bounded=elements(WalkthroughFrame({...preview,frame}));
    const attention=(tree:typeof full)=>tree.filter(node=>node.props['data-emphasis-id']||node.props['data-emphasis-stroke']);
    assert.deepEqual(attention(bounded),attention(full),`Absolute frame ${frame} has the same attention treatment in preview and film`);
    if(frame<180){
      const rect=bounded.find(node=>node.type==='rect')!,projected=emphasisAtFrame(selected.segments[0].emphasis![0],frame,segmentTransform(selected,0,frame))!;
      assert.equal(rect.props.x,projected.box.x);
    }
  }
  assert.equal(JSON.stringify(selected),before);
});
