import assert from 'node:assert/strict';
import test from 'node:test';
import {frameState,segmentTransform,validateTimeline,type Timeline} from '../src/render/timeline.ts';
import {filmTimelineVtt} from '../src/core/film-edit.ts';

const target={x:1300,y:400,width:200,height:100};
const plan:Timeline={sourceWidth:3200,sourceHeight:1800,sources:{first:{pointer:[]},second:{pointer:[]}},narration:[],segments:[
  {id:'one',sourceId:'first',kind:'live',transition:'cut',sourceStartSeconds:17/60,sourceEndSeconds:137/60,outputStartSeconds:0,durationSeconds:2,zoom:1.5,target},
  {id:'two',sourceId:'second',kind:'live',transition:'cut',sourceStartSeconds:151/60,sourceEndSeconds:181/60,outputStartSeconds:2,durationSeconds:.5,zoom:1.5,target},
  {id:'hold',sourceId:'second',kind:'hold',transition:'continuous',sourceStartSeconds:181/60,sourceEndSeconds:181/60,outputStartSeconds:2.5,durationSeconds:.5,zoom:1.5,target}
]};

test('multiple sources preserve native speed and only explicit holds pin observed frames',()=>{
  assert.equal(validateTimeline(plan).durationInFrames,180);
  assert.equal(frameState(plan,0).sourceFrame,17);
  assert.equal(frameState(plan,119).sourceFrame,136);
  assert.equal(frameState(plan,120).segment.sourceId,'second');
  assert.equal(frameState(plan,120).sourceFrame,151);
  assert.equal(frameState(plan,149).sourceFrame,180);
  assert.equal(frameState(plan,150).sourceFrame,181);
  assert.equal(frameState(plan,179).sourceFrame,181);
  assert.equal(frameState(plan,179).hold,true);
});

test('live padding, time compression and multi-frame holds are rejected',()=>{
  for(const durationSeconds of [1,3])assert.throws(()=>validateTimeline({...plan,segments:[{...plan.segments[0],durationSeconds}]}),/scaling_or_padding/);
  assert.throws(()=>validateTimeline({...plan,segments:[{...plan.segments[0],kind:'hold'}]}),/single_frame/);
  assert.throws(()=>validateTimeline({...plan,segments:[{...plan.segments[0],sourceId:'absent'}]}),/unknown_source/);
});

test('camera stays fixed throughout approach, action, response and continuous boundaries',()=>{
  const timeline:Timeline={...plan,segments:[{...plan.segments[0],actions:[{kind:'click',timeSeconds:1,target,consequence:{...target,y:700},settledSeconds:1.1}]},
    {...plan.segments[0],id:'continuation',transition:'continuous',outputStartSeconds:2,sourceStartSeconds:137/60,sourceEndSeconds:257/60}]};
  validateTimeline(timeline);
  for(const frame of [0,30,60,66,119,120,239])assert.deepEqual(frameState(timeline,frame).transform,frameState(timeline,0).transform);
  assert.throws(()=>validateTimeline({...timeline,segments:[timeline.segments[0],{...timeline.segments[1],zoom:1.2}]}),/framing_change/);
  assert.throws(()=>validateTimeline({...timeline,segments:[timeline.segments[0],{...timeline.segments[1],sourceId:'second'}]}),/requires_cut/);
});

test('actual pointer is persistent, source-local and never anticipates a click',()=>{
  const timeline:Timeline={...plan,sources:{first:{pointer:[
    {type:'move',timeSeconds:.3,x:1400,y:450},
    {type:'down',timeSeconds:.5,x:1410,y:455},
    {type:'up',timeSeconds:.6,x:1410,y:455},
    {type:'move',timeSeconds:.8,x:1500,y:500}
  ]},second:{pointer:[]}}};
  assert.equal(frameState(timeline,0).cursor,null);
  const pre=frameState(timeline,12),clicked=frameState(timeline,13),last=frameState(timeline,119);
  assert.equal(pre.cursor?.pulse,0);
  assert.equal(clicked.cursor?.pulse,1);
  assert.equal(clicked.cursor?.x,1410*clicked.transform.scale+clicked.transform.x);
  assert.equal(last.cursor?.x,1500*last.transform.scale+last.transform.x);
  assert.equal(last.cursor?.pulse,0);
  assert.equal(frameState(timeline,120).cursor,null,'Another source must not inherit this pointer');
  const withActions:Timeline={...plan,segments:[{...plan.segments[0],actions:[{kind:'click',timeSeconds:1,target}]}]};
  assert.equal(frameState(withActions,60).cursor,null,'Semantic actions do not manufacture cursor samples');
});

test('narration and captions cross editorial cuts without restarting',()=>{
  const timeline:Timeline={...plan,narration:[{id:'voice',outputStartSeconds:0,durationSeconds:3,captions:[{text:'A continuing sentence',startSeconds:1.8,endSeconds:2.8}]}]};
  validateTimeline(timeline);
  assert.equal(filmTimelineVtt(timeline),'WEBVTT\n\n00:00:01.800 --> 00:00:02.800\nA continuing sentence\n');
  for(const text of ['one\ntwo\nthree','one\n','x'.repeat(77)])assert.throws(()=>validateTimeline({...timeline,narration:[{...timeline.narration[0],captions:[{text,startSeconds:0,endSeconds:1}]}]}),/invalid_caption/);
  validateTimeline({...timeline,narration:[{...timeline.narration[0],captions:[{text:`Read ${'x'.repeat(45)} now.`,startSeconds:0,endSeconds:1}]}]});
});

test('static framing uses the full product frame and rejects hidden action targets',()=>{
  const transform=frameState(plan,0).transform;
  assert.ok(transform.scale<=.9);
  assert.ok(transform.x<=0 && transform.y<=0);
  assert.ok(transform.x+3200*transform.scale>=1920);
  assert.ok(transform.y+1800*transform.scale>=1080);
  assert.throws(()=>validateTimeline({...plan,segments:[{...plan.segments[0],actions:[{kind:'click',timeSeconds:1,target:{x:1400,y:1600,width:100,height:100}}]}]}),/hidden_by_framing/);
});

test('default overview fills 1080p with all four browser edges visible',()=>{
  const timeline:Timeline={...plan,segments:[{...plan.segments[0],zoom:1,target:null}]};
  validateTimeline(timeline);
  assert.deepEqual(frameState(timeline,0).transform,{scale:.6,x:0,y:0});
  // A full-viewport subject must be admissible without silently cropping chrome
  // or the bottom of the page to make room for captions.
  timeline.segments[0].target={x:0,y:0,width:3200,height:1800};
  validateTimeline(timeline);
  assert.deepEqual(frameState(timeline,119).transform,{scale:.6,x:0,y:0});
  timeline.segments[0].actions=[{kind:'click',timeSeconds:1,target:{x:0,y:1760,width:3200,height:40}}];
  validateTimeline(timeline);
  timeline.segments[0].zoom=1.5;
  assert.throws(()=>validateTimeline(timeline),/hidden_by_framing/);
});

test('detail zoom can frame an edge target without moving during live input',()=>{
  const bottomRight={x:2800,y:1600,width:400,height:200};
  const timeline:Timeline={...plan,segments:[{...plan.segments[0],zoom:1.5,target:bottomRight}]};
  validateTimeline(timeline);
  const transform=frameState(timeline,0).transform;
  assert.ok(Math.abs(transform.scale-.9)<1e-10);
  assert.ok(Math.abs(transform.x+960)<1e-10);
  assert.ok(Math.abs(transform.y+540)<1e-10);
  assert.deepEqual(frameState(timeline,119).transform,frameState(timeline,0).transform);
});

test('invalid geometry, pointer clocks and narration overlap fail closed',()=>{
  assert.throws(()=>validateTimeline({...plan,sourceWidth:1920,sourceHeight:1080}),/source_geometry/);
  assert.throws(()=>validateTimeline({...plan,sources:{first:{pointer:[{type:'move',x:0,y:0,timeSeconds:1},{type:'down',x:0,y:0,timeSeconds:.5}]}}}),/pointer_samples/);
  assert.throws(()=>validateTimeline({...plan,narration:[{id:'a',outputStartSeconds:0,durationSeconds:2,captions:[]},{id:'b',outputStartSeconds:1,durationSeconds:1,captions:[]}]}),/invalid_narration/);
});

function movingTimeline():Timeline{
  return {...plan,segments:[{...plan.segments[0],sourceStartSeconds:0,sourceEndSeconds:4,durationSeconds:4,zoom:1,target:null,
    cameraMove:{startSeconds:1,durationSeconds:2,zoom:1.5,target:{x:2800,y:1600,width:400,height:200}}}]};
}
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('a declared camera move eases between bounded framing while the source stays at 1x',()=>{
  const timeline=movingTimeline();validateTimeline(timeline);
  for(const frame of [0,30,60])assert.deepEqual(segmentTransform(timeline,0,frame),{scale:.6,x:0,y:0});
  const middle=segmentTransform(timeline,0,120);
  near(middle.scale,.75);near(middle.x,-480);near(middle.y,-270);
  const quarter=segmentTransform(timeline,0,90);
  near(quarter.scale,.6+.3*.103515625);
  near(quarter.x,-960*.103515625);
  for(const frame of [180,239,240]){
    const end=segmentTransform(timeline,0,frame);
    near(end.scale,.9);near(end.x,-960);near(end.y,-540);
  }
  assert.ok(Math.abs(segmentTransform(timeline,0,61).x)<.01,'The camera accelerates from rest, not linearly');
  assert.ok(Math.abs(segmentTransform(timeline,0,179).x+960)<.01,'The camera settles to zero velocity');
  for(let frame=0;frame<240;frame++){
    const state=frameState(timeline,frame);
    assert.equal(state.sourceFrame,frame);
    const {scale,x,y}=state.transform;
    assert.ok(x<=1e-9&&y<=1e-9&&x+3200*scale>=1920-1e-9&&y+1800*scale>=1080-1e-9);
  }
});

test('continuous framing joins the previous camera endpoint and permits a new move',()=>{
  const timeline=movingTimeline(),first=timeline.segments[0],destination=first.cameraMove!;
  timeline.segments.push({...first,id:'joined',transition:'continuous',sourceStartSeconds:4,sourceEndSeconds:8,outputStartSeconds:4,
    zoom:destination.zoom,target:{x:2900,y:1650,width:200,height:100},cameraMove:{startSeconds:0,durationSeconds:2,zoom:1,target:null}});
  validateTimeline(timeline);
  assert.deepEqual(frameState(timeline,239).transform,frameState(timeline,240).transform);
  near(frameState(timeline,300).transform.scale,.75);
  assert.deepEqual(frameState(timeline,360).transform,{scale:.6,x:0,y:0});
  timeline.segments[1].zoom=1;
  assert.throws(()=>validateTimeline(timeline),/continuous_framing_change/);
});

test('camera destinations and timed actions are validated at their actual intended framing',()=>{
  const timeline=movingTimeline(),segment=timeline.segments[0];
  segment.actions=[{kind:'click',timeSeconds:.5,target:{x:0,y:0,width:100,height:100},consequence:segment.cameraMove!.target!,settledSeconds:3.5}];
  validateTimeline(timeline);
  segment.actions[0].timeSeconds=3.5;
  assert.throws(()=>validateTimeline(timeline),/target_hidden_by_framing/);
  delete segment.actions;
  segment.cameraMove!.target={x:0,y:0,width:3200,height:1800};
  assert.throws(()=>validateTimeline(timeline),/target_hidden_by_framing/);
  segment.cameraMove!.target={x:3100,y:0,width:200,height:100};
  assert.throws(()=>validateTimeline(timeline),/target_outside_source/);
});

test('camera clocks, zoom and caption strip boundaries reject malformed ranges',()=>{
  const timeline=movingTimeline(),segment=timeline.segments[0];
  const move={...segment.cameraMove!};
  for(const change of [{startSeconds:-1},{durationSeconds:0},{zoom:1.6},{startSeconds:3},{durationSeconds:NaN},{target:undefined}]){
    segment.cameraMove={...move,...change} as typeof move;
    assert.throws(()=>validateTimeline(timeline),/invalid_camera_move/);
  }
  segment.cameraMove={...move,startSeconds:.001};
  assert.throws(()=>validateTimeline(timeline),/frame_aligned/);
  segment.cameraMove=move;
  for(const placement of [{x:-1,y:0,width:1200},{x:0,y:985,width:1200},{x:0,y:0,width:1921},{x:100,y:0,width:1920},{x:0,y:0,width:0},{x:NaN,y:0,width:100}]){
    segment.captionPlacement=placement;
    assert.throws(()=>validateTimeline(timeline),/invalid_caption_placement/);
  }
  segment.captionPlacement={x:0,y:984,width:1920};
  validateTimeline(timeline);
});
