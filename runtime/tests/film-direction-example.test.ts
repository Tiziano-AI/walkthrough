import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {commandHelp} from '../src/command-help.ts';
import {validateFilmEdit,validateFilmSources} from '../src/core/film-edit.ts';
import type {SourceSet} from '../src/project/contracts.ts';

test('the shipped directing construction joins valid continuous footage, framing and independent speech',async()=>{
  const help=commandHelp('edit') as any;
  assert.equal(help.construction.status,'illustrative-not-recorded');
  const edit=validateFilmEdit({...help.example,sourceSetId:'example-sources',sourceSetSha256:'b'.repeat(64)});
  const subject={x:1000,y:500,width:800,height:500};
  const sources:SourceSet={schemaVersion:1,kind:'source-set',id:'example-sources',projectId:'example-project',createdAt:'2026-10-10T00:00:00Z',state:'sealed',mediaReview:'agent-reviewable-synthetic',sources:[{id:'source-direction',media:{relativePath:'one.mp4',sha256:'a'.repeat(64),bytes:1},width:3200,height:1800,durationSeconds:20,frameCount:1200,clock:{offsetSeconds:0,uncertaintySeconds:0,driftSeconds:0},pointer:[],usableRange:{startSeconds:0,endSeconds:20}}],marks:[{id:'subject-before',title:'Connected objects',sourceId:'source-direction',timeSeconds:2,target:subject},{id:'connection-response',title:'Preserved connection',sourceId:'source-direction',timeSeconds:9,target:{x:1350,y:700,width:300,height:200}}],artifacts:[]};
  assert.equal(validateFilmSources(edit,sources).durationSeconds,16);
  assert.equal(edit.narration[1].outputStartSeconds,8.6);
  assert.ok(edit.narration[1].outputStartSeconds<10,'The next thought starts before the next picture, not at its boundary');
  const docs=await readFile(new URL('../../docs/browser-authoring.md',import.meta.url),'utf8');
  const section=docs.split('## Compose independent picture and narration tracks')[1];
  const example=JSON.parse(section.match(/```json\n([\s\S]*?)\n```/)![1]);
  assert.deepEqual(example,help.example,'The human-readable construction and executable help are the same example');
});
