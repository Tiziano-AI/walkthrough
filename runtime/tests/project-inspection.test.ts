import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSourceSet,captureSummary} from '../src/project/inspection.ts';
import type {SourceSet,TakeRecord} from '../src/project/contracts.ts';

const source={id:'take',media:{relativePath:'take/source.mp4',sha256:'a'.repeat(64),bytes:100},width:3200,height:1800,durationSeconds:120,frameCount:7200,clock:{offsetSeconds:0,uncertaintySeconds:0.01,driftSeconds:0},usableRange:{startSeconds:1,endSeconds:119},pointer:Array.from({length:7000},(_,i)=>({timeSeconds:i/60,x:i%3000,y:450,type:'move' as const}))};
const set:SourceSet={schemaVersion:1,kind:'source-set',id:'set',projectId:'project',createdAt:'2026-10-03',state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[source],marks:Array.from({length:25},(_,i)=>({id:'mark-'+i,title:'A moment',sourceId:'take',timeSeconds:i,target:null})),artifacts:[]};
const retained={sourceSet:set,sha256:'b'.repeat(64),directory:'/project/sources/set',sourcePaths:{take:'/project/sources/set/take/source.mp4'},artifactPaths:{}};
test('source inspection keeps editing facts small and deepens exact retained pointer/mark pages',()=>{
  const summary=inspectSourceSet(retained);
  assert.ok(JSON.stringify(summary).length<6000);assert.ok(!JSON.stringify(summary).includes('"pointer":'));
  assert.deepEqual((summary as any).sources.items[0].usableRange,source.usableRange);
  assert.equal((summary as any).sources.items[0].pointerSamples,7000);
  const tail=inspectSourceSet(retained,{section:'marks',offset:20,limit:20}) as any;
  assert.equal(tail.items.length,5);assert.equal(tail.items[0].id,'mark-20');assert.equal(tail.nextOffset,null);
  const points=inspectSourceSet(retained,{section:'pointer',sourceId:'take',offset:21,limit:2}) as any;
  assert.deepEqual(points.items,source.pointer.slice(21,23));assert.equal(points.nextOffset,23);
  assert.equal(set.sources[0].pointer.length,7000);
});
test('capture operation keeps identity and state without flooding supervisor output',()=>{
  const take:TakeRecord={schemaVersion:1,id:'take',sessionId:'session',pageId:'page',title:'Recorded',createdAt:'2026-10-03',state:'stopped',source,marks:set.marks,eventsPath:'input-events.json'};
  const op=captureSummary({operationId:'stop',status:'completed',result:take}) as any;
  assert.equal(op.operationId,'stop');assert.equal(op.result.state,'stopped');assert.equal(op.result.source.pointerSamples,7000);assert.ok(JSON.stringify(op).length<6000);
  assert.throws(()=>inspectSourceSet(retained,{section:'pointer',sourceId:'missing'}),{code:'SOURCE_NOT_FOUND'});
});
