import assert from 'node:assert/strict';
import test from 'node:test';
import {planRenderSources,renderPictures,stagedSourceFrame} from '../src/render/source-plan.ts';
import {validateTimeline,type Timeline} from '../src/render/timeline.ts';

const timeline:Timeline={sourceWidth:3200,sourceHeight:1800,sources:{a:{pointer:[]},b:{pointer:[]},c:{pointer:[]},unused:{pointer:[]}},narration:[],segments:[
  {id:'a-first',sourceId:'a',kind:'live',transition:'cut',sourceStartSeconds:5,sourceEndSeconds:6,outputStartSeconds:0,durationSeconds:1,zoom:1,target:null},
  {id:'b',sourceId:'b',kind:'live',transition:'cut',sourceStartSeconds:100/60,sourceEndSeconds:160/60,outputStartSeconds:1,durationSeconds:1,zoom:1,target:null},
  {id:'a-last',sourceId:'a',kind:'live',transition:'cut',sourceStartSeconds:7.5,sourceEndSeconds:8,outputStartSeconds:2,durationSeconds:.5,zoom:1,target:null},
  {id:'c-hold',sourceId:'c',kind:'hold',transition:'cut',sourceStartSeconds:5,sourceEndSeconds:5,outputStartSeconds:2.5,durationSeconds:.5,zoom:1,target:null},
]};

const plan=(...intervals:[number,number][])=>{let frameCount=0;const windows=intervals.map(([sourceStartFrame,count])=>{const window={sourceStartFrame,frameCount:count,stagedStartFrame:frameCount};frameCount+=count;return window;});return {windows,frameCount};};

test('delivery and preview pack only selected integer windows per source',()=>{
  validateTimeline(timeline);
  const original=JSON.stringify(timeline);
  const full={a:plan([300,60],[450,30]),b:plan([100,60]),c:plan([300,1])};
  assert.deepEqual(planRenderSources(timeline),full);
  assert.deepEqual(planRenderSources(timeline,[0,179]),full,'an explicit full interval uses the same planner');
  assert.deepEqual(planRenderSources(timeline,[45,159]),{a:plan([345,15],[450,30]),b:plan([100,60]),c:plan([300,1])});
  assert.deepEqual(planRenderSources(timeline,[90,129]),{b:plan([130,30]),a:plan([450,10])},'pictures outside the preview create no staged source');
  assert.equal(JSON.stringify(timeline),original,'planning never cuts or rebases the original timeline');
});

test('inclusive final preview frames and holds map to exactly the selected source frames',()=>{
  assert.deepEqual(planRenderSources(timeline,[59,59]),{a:plan([359,1])});
  assert.deepEqual(planRenderSources(timeline,[179,179]),{c:plan([300,1])});
  assert.deepEqual(renderPictures(timeline,[59,60]).map(({segment,...picture})=>({id:segment.id,...picture})),[
    {id:'a-first',outputStartFrame:59,durationInFrames:1,sourceStartFrame:359},
    {id:'b',outputStartFrame:60,durationInFrames:1,sourceStartFrame:100},
  ]);
});

test('overlapping, adjacent, repeated and out-of-order pictures share their exact source union',()=>{
  const intervals=[[1000,20],[20,10],[10,10],[15,20],[1000,20],[999,1]];
  let output=0;
  const repeated:Timeline={...timeline,segments:intervals.map(([start,count],index)=>{
    const segment={...timeline.segments[0],id:`picture-${index}`,sourceStartSeconds:start/60,sourceEndSeconds:(start+count)/60,outputStartSeconds:output/60,durationSeconds:count/60};output+=count;return segment;
  })};
  validateTimeline(repeated);
  const packed=planRenderSources(repeated).a;
  assert.deepEqual(packed,plan([10,25],[999,21]));
  assert.equal(stagedSourceFrame(packed.windows,1000,20),26);
  assert.equal(stagedSourceFrame(packed.windows,20,10),10);
  assert.throws(()=>stagedSourceFrame(packed.windows,30,10),/trim_out_of_bounds/,'a picture may not cross a removed gap');
  assert.throws(()=>stagedSourceFrame(packed.windows,500,1),/trim_out_of_bounds/);
});
