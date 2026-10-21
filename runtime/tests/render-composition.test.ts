import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {Audio,Freeze,OffthreadVideo,Sequence} from 'remotion';
import {WalkthroughFrame,type CompositionProps} from '../src/render/composition.ts';
import {frameState,type Timeline} from '../src/render/timeline.ts';

const props:CompositionProps={presentation:'full-frame-visible-captions',sourceFiles:{source:{file:'product.mp4',windows:[{sourceStartFrame:0,frameCount:180,stagedStartFrame:0}]}},audioFiles:{voice:'narration.wav'},timeline:{
  sourceWidth:3200,sourceHeight:1800,sources:{source:{pointer:[]}},
  segments:[{id:'product',sourceId:'source',kind:'live',transition:'cut',sourceStartSeconds:0,sourceEndSeconds:2,outputStartSeconds:0,durationSeconds:2,zoom:1,target:null}],
  narration:[{id:'voice',outputStartSeconds:0,durationSeconds:2,captions:[{text:'Explore the product clearly.',startSeconds:.25,endSeconds:1.5}]}],
}};

function elements(node:React.ReactNode):React.ReactElement<Record<string,unknown>>[]{
  if(!React.isValidElement<Record<string,unknown>>(node))return [];
  return [node,...React.Children.toArray(node.props.children as React.ReactNode).flatMap(elements)];
}

test('narrated frame burns in canonical text without shrinking the application',()=>{
  const frame=WalkthroughFrame({...props,frame:60});
  const tree=elements(frame);
  const video=tree.find(element=>element.type===OffthreadVideo)!;
  assert.deepEqual(video.props.style,{position:'absolute',left:0,top:0,width:1920,height:1080,maxWidth:'none'});
  assert.equal(video.props.src,'/product.mp4');
  assert.equal(tree.find(element=>element.type===Audio)?.props.src,'/narration.wav');
  const captions=tree.filter(element=>element.props['data-caption-line']!==undefined);
  assert.equal(captions.length,1);
  assert.equal(captions[0].props.children,'Explore the product clearly.');
  const style=captions[0].props.style as React.CSSProperties;
  assert.equal(style.color,'#fff');
  assert.equal(style.fontSize,30);
  assert.equal(style.backgroundColor,'rgba(0,0,0,0.68)');
  assert.ok(typeof style.width==='number'&&style.width<500,'backing hugs the phrase, not the frame');
  assert.ok(typeof style.height==='number'&&style.height<50);
  assert.equal(style.overflow,'hidden','paint stays within the same exact box exposed to QA');
});

test('caption visibility uses aligned inclusive-start exclusive-end frames, including silence',()=>{
  for(const frame of [0,14,90,119])assert.equal(elements(WalkthroughFrame({...props,frame})).filter(element=>element.props['data-caption-line']!==undefined).length,0,`frame ${frame} is silent`);
  for(const frame of [15,89])assert.equal(elements(WalkthroughFrame({...props,frame})).filter(element=>element.props['data-caption-line']!==undefined).length,1,`frame ${frame} contains speech`);
});

test('captions preserve observed pointer and click feedback',()=>{
  const frame=WalkthroughFrame({...props,frame:30,timeline:{...props.timeline,sources:{source:{pointer:[{type:'down',timeSeconds:.5,x:1600,y:1700}]}}}});
  const tree=elements(frame);
  const halo=tree.filter(element=>element.type==='div'&&element.props['data-caption-line']===undefined);
  assert.equal(halo.length,1,'one observed click halo');
  const cursor=tree.find(element=>element.type==='svg')!;
  assert.equal((cursor.props.style as React.CSSProperties).left,960);
  assert.equal((cursor.props.style as React.CSSProperties).top,1020);
  assert.equal(tree.filter(element=>element.type==='path').length,1);
});

test('a mid-gesture preview intersects media before trimming and retains the absolute camera, pointer, caption and narration clocks',()=>{
  const timeline:Timeline={...props.timeline,sources:{source:{pointer:[
    {type:'down',timeSeconds:1.2,x:1600,y:900},
    {type:'move',timeSeconds:1.4,x:1700,y:950},
    {type:'up',timeSeconds:1.9,x:1700,y:950},
  ]}},segments:[{...props.timeline.segments[0],sourceStartSeconds:17/60,sourceEndSeconds:137/60,
    cameraMove:{startSeconds:.5,durationSeconds:1,zoom:1.5,target:null}}]};
  const original=JSON.stringify(timeline);
  const preview={...props,timeline,frameRange:[75,104] as [number,number],sourceFiles:{source:{file:'bounded.mp4',windows:[{sourceStartFrame:92,frameCount:30,stagedStartFrame:0}]}}};
  for(const frame of [75,82,89,90,104]){
    const full=elements(WalkthroughFrame({...props,timeline,frame})),bounded=elements(WalkthroughFrame({...preview,frame}));
    const video=bounded.find(node=>node.type===OffthreadVideo)!;
    assert.equal(video.props.trimBefore,0,'intersection start maps to the first staged frame, never a negative trim');
    assert.deepEqual(video.props.style,full.find(node=>node.type===OffthreadVideo)!.props.style,'camera uses the original segment-local position');
    const picture=bounded.find(node=>node.type===Sequence&&React.isValidElement(node.props.children)&&node.props.children.type===OffthreadVideo)!;
    assert.equal(picture.props.from,75);assert.equal(picture.props.durationInFrames,30);
    const sourceFrame=Number(video.props.trimBefore)+frame-Number(picture.props.from)+92;
    assert.equal(sourceFrame,frameState(timeline,frame).sourceFrame);
    const narration=bounded.find(node=>node.type===Sequence&&React.isValidElement(node.props.children)&&node.props.children.type===Audio)!;
    assert.equal(narration.props.from,0);assert.equal(narration.props.durationInFrames,120);
    const overlay=(nodes:typeof bounded)=>nodes.filter(node=>node.type==='svg'||node.type==='div');
    assert.deepEqual(overlay(bounded),overlay(full),'pointer/drag and caption state stay on the original composition clock');
  }
  assert.equal(JSON.stringify(timeline),original);
});

test('preview omits unavailable sources outside its range and pins a one-frame held derivative',()=>{
  const timeline:Timeline={...props.timeline,narration:[],sources:{source:{pointer:[]},hold:{pointer:[]}},segments:[
    props.timeline.segments[0],
    {...props.timeline.segments[0],id:'held',sourceId:'hold',kind:'hold',sourceStartSeconds:25/60,sourceEndSeconds:25/60,outputStartSeconds:2,durationSeconds:2},
  ]};
  const tree=elements(WalkthroughFrame({...props,timeline,frame:200,frameRange:[190,210],sourceFiles:{hold:{file:'hold.mp4',windows:[{sourceStartFrame:25,frameCount:1,stagedStartFrame:0}]}}}));
  const videos=tree.filter(node=>node.type===OffthreadVideo);
  assert.equal(videos.length,1);assert.equal(videos[0].props.src,'/hold.mp4');assert.equal(videos[0].props.trimBefore,0);
  assert.equal(tree.find(node=>node.type===Freeze)?.props.frame,0);
  const picture=tree.find(node=>node.type===Sequence)!;
  assert.equal(picture.props.from,190);assert.equal(picture.props.durationInFrames,21);
});
