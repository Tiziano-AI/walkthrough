import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {WalkthroughFrame,type CompositionProps} from '../src/render/composition.ts';
import {frameState,type Timeline} from '../src/render/timeline.ts';

function elements(node:React.ReactNode):React.ReactElement<Record<string,unknown>>[]{
  if(!React.isValidElement<Record<string,unknown>>(node))return [];
  return [node,...React.Children.toArray(node.props.children as React.ReactNode).flatMap(elements)];
}

const timeline:Timeline={sourceWidth:3200,sourceHeight:1800,sources:{source:{pointer:[{type:'down',timeSeconds:0,x:1600,y:900,gesture:'drag'}]}},narration:[],segments:[{
  id:'move',sourceId:'source',kind:'hold',transition:'cut',sourceStartSeconds:0,sourceEndSeconds:0,outputStartSeconds:0,durationSeconds:4,zoom:1,target:null,
  cameraMove:{startSeconds:1,durationSeconds:2,zoom:1.5,target:{x:2800,y:1600,width:400,height:200}}
}]};

test('a held observed pointer follows editorial framing while its rendered size stays in output pixels',()=>{
  const props:CompositionProps={presentation:'full-frame-visible-captions',timeline,sourceFiles:{source:{file:'source.mp4',windows:[{sourceStartFrame:0,frameCount:1,stagedStartFrame:0}]}},audioFiles:{}};
  for(const [frame,x,y] of [[0,960,540],[120,720,405],[180,480,270]]){
    const state=frameState(timeline,frame);
    assert.equal(state.sourceFrame,0,'Camera motion must not advance held footage');
    assert.ok(Math.abs(state.cursor!.x-x)<1e-9);
    assert.ok(Math.abs(state.cursor!.y-y)<1e-9);
    const tree=elements(WalkthroughFrame({...props,frame}));
    const cursor=tree.find(element=>element.type==='svg')!;
    assert.equal(cursor.props.width,36);assert.equal(cursor.props.height,36);
    const style=cursor.props.style as React.CSSProperties;
    assert.equal(style.left,state.cursor!.x);assert.equal(style.top,state.cursor!.y);
    assert.equal(style.transform,undefined,'No inherited camera scaling on the output cursor');
  }
});

test('drag feedback retains a constant output-pixel diameter across a live camera move',()=>{
  const live:Timeline={...timeline,segments:[{...timeline.segments[0],kind:'live',sourceEndSeconds:4}]};
  for(const frame of [0,120,180]){
    const tree=elements(WalkthroughFrame({presentation:'full-frame-visible-captions',timeline:live,sourceFiles:{source:{file:'source.mp4',windows:[{sourceStartFrame:0,frameCount:240,stagedStartFrame:0}]}},audioFiles:{},frame}));
    const halo=tree.find(element=>element.type==='div')!;
    const style=halo.props.style as React.CSSProperties;
    assert.equal(style.width,64);assert.equal(style.height,64);assert.equal(style.transform,undefined);
  }
});
