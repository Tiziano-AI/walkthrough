import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Ajv2020} from 'ajv/dist/2020.js';

const schema=JSON.parse(await readFile(new URL('../docs/schemas/capture-mark.schema.json',import.meta.url),'utf8'));
const validate=new Ajv2020({strict:true,allErrors:true}).compile(schema);
const ref={observationId:'surface-one',ref:'ref-one'};
const screenshot={observationId:'surface-one',coordinateSpace:'screenshot',box:{x:1800,y:1000,width:400,height:300}};
const mark=(target:unknown)=>({title:'Observed subject',target});
function accepts(value:unknown){assert.equal(validate(value),true,JSON.stringify(validate.errors));}
function rejects(value:unknown){assert.equal(validate(value),false,`Schema admitted ${JSON.stringify(value)}`);}

test('capture mark schema admits independent optional settlement and both observed framing shapes',()=>{
  accepts({title:'Unframed mark'});
  accepts({...mark(ref),id:'mark_1-A',settled:true});
  accepts({...mark(screenshot),settled:false});
  accepts(mark({...screenshot,box:{x:0,y:0,width:.5,height:.5}}));
  // Screenshot dimensions are observation-specific runtime evidence, not a
  // fixed CSS-viewport limit imposed by the public input schema.
  accepts(mark({...screenshot,box:{x:0,y:0,width:6400,height:3600}}));
});

test('capture mark schema rejects legacy, mixed, missing and extra target fields',()=>{
  const invalid=[
    {x:1,y:2,width:30,height:40},
    {ref:ref.ref},{observationId:ref.observationId},
    {...ref,box:screenshot.box},{...ref,coordinateSpace:'css'},
    {...screenshot,ref:ref.ref},{...screenshot,coordinateSpace:'css'},
    {observationId:screenshot.observationId,box:screenshot.box},
    {observationId:screenshot.observationId,coordinateSpace:'screenshot'},
    {...screenshot,box:{...screenshot.box,unit:'px'}},
    {...screenshot,box:{x:0,y:0,width:1}},null,[],
  ];
  for(const target of invalid)rejects(mark(target));
  rejects({...mark(ref),operationId:'operation-outside-payload'});
  rejects({...mark(ref),unrecognized:true});
});

test('capture mark schema bounds payload values and every observed identity',()=>{
  for(const key of ['id','observationId','ref']){
    const payload=(id:string)=>key==='id'?{...mark(ref),id}:mark({...ref,[key]:id});
    accepts(payload('a'.repeat(101)));
    for(const id of ['', '.invalid','contains.dot','contains space','a'.repeat(102)])rejects(payload(id));
  }
  accepts({title:'a'.repeat(10000)});
  for(const title of ['', ' \n\t', 'a'.repeat(10001),null,1])rejects({title});
  rejects({});rejects({...mark(ref),settled:'true'});
  for(const [key,values] of Object.entries({x:[-1,null,'1'],y:[-1,null,'1'],width:[0,-1,null,'1'],height:[0,-1,null,'1']})){
    for(const value of values)rejects(mark({...screenshot,box:{...screenshot.box,[key]:value}}));
  }
});
