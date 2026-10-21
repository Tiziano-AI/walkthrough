import assert from 'node:assert/strict';
import test from 'node:test';
import {frameState,type Timeline} from '../src/render/timeline.ts';

test('held drag feedback follows observed pointer until release instead of pulsing at its origin',()=>{
 const timeline:Timeline={sourceWidth:3200,sourceHeight:1800,sources:{source:{pointer:[
  {type:'move',timeSeconds:0,x:400,y:300},{type:'down',timeSeconds:.1,x:400,y:300,gesture:'drag'},
  {type:'move',timeSeconds:.4,x:600,y:450,gesture:'drag'},{type:'move',timeSeconds:.7,x:800,y:600,gesture:'drag'},
  {type:'up',timeSeconds:.9,x:800,y:600,gesture:'drag'},
  {type:'down',timeSeconds:1.2,x:800,y:600},{type:'up',timeSeconds:1.25,x:800,y:600}
 ]}},narration:[],segments:[{id:'live',sourceId:'source',kind:'live',transition:'cut',sourceStartSeconds:0,sourceEndSeconds:2,outputStartSeconds:0,durationSeconds:2,zoom:1,target:null}]};
 const held=frameState(timeline,42).cursor!;
 assert.equal(held.dragging,true);assert.equal(held.pressed,true);assert.equal(held.pulse,.8);
 assert.equal(held.haloX,held.x);assert.equal(held.haloY,held.y);
 const released=frameState(timeline,54).cursor!;assert.equal(released.dragging,false);assert.equal(released.pressed,false);assert.equal(released.pulse,0);
 const clicked=frameState(timeline,72).cursor!;assert.equal(clicked.dragging,false);assert.equal(clicked.pulse,1);
});
