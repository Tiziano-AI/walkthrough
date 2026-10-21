import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createProject} from '../src/project/store.ts';
import {closeSession,dispatchSession,observeSession,openSession} from '../src/session/index.ts';
import type {SessionConfig} from '../src/session/contracts.ts';

async function fixture(html:string){
  const root=await mkdtemp('/private/tmp/wts-options-'),project=join(root,'project'),directory=join(project,'sessions','options');
  const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end(html);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const prior=process.env.WALKTHROUGH_STATE_ROOT;process.env.WALKTHROUGH_STATE_ROOT=join(root,'state');
  const created=await createProject(project,{title:'Select observation qualification',brief:'Choose actual option values from retained observations.',audience:'Test author',mandate:{applicationUrl:origin,navigationOrigins:[origin],network:'loopback-only',allowedEffects:'Synthetic option selection only.',dataDescription:'Generated test data',inputRoots:[],mediaReview:'agent-reviewable-synthetic',delivery:'local'}});
  const config:SessionConfig={directory,projectPath:project,projectId:created.project.id,startUrl:origin,allowedOrigins:[origin],uploadRoots:[],network:'loopback-only',mediaReview:'agent-reviewable-synthetic',headless:true};
  const close=async()=>{try{await closeSession(directory);}catch{}await new Promise<void>(resolve=>server.close(()=>resolve()));if(prior===undefined)delete process.env.WALKTHROUGH_STATE_ROOT;else process.env.WALKTHROUGH_STATE_ROOT=prior;await rm(root,{recursive:true,force:true});};
  try{await openSession(config);}catch(error){await close();throw error;}
  return {directory,close};
}

test('select observations expose exact opaque values and effective disabled states, with retained option paging',async()=>{
  const html=`<!doctype html><select aria-label="Choice" onchange="document.querySelector('output').textContent='Chosen '+this.value">
    <option value="opaque-id" label="Readable label" selected>Different text</option>
    <option value="disabled-id" disabled>Unavailable</option>
    <optgroup label="Unavailable group" disabled><option value="group-id">Grouped</option></optgroup>
    ${Array.from({length:42},(_,index)=>`<option value="record-${index}">Record ${index}</option>`).join('')}
    </select><fieldset disabled><select aria-label="Disabled choice"><option value="blocked">Blocked</option></select></fieldset><button>Other control</button>
    <select aria-label="Multiple choices" multiple><option value="first" selected>First</option><option value="second" selected>Second</option></select><output></output>`;
  const f=await fixture(html);
  try{
    const observation=await observeSession(f.directory,{limit:1,screenshot:true}),choice=observation.refs[0];
    assert.equal(choice.name,'Choice');assert.equal(choice.multiple,false);assert.equal(choice.options?.length,20);
    assert.deepEqual(choice.options?.slice(0,3),[
      {index:0,value:'opaque-id',label:'Readable label',disabled:false,selected:true},
      {index:1,value:'disabled-id',label:'Unavailable',disabled:true,selected:false},
      {index:2,value:'group-id',label:'Grouped',disabled:true,selected:false},
    ]);
    assert.equal(choice.optionsTotal,45);assert.equal(choice.optionsRetainedTotal,45);assert.equal(choice.optionsTruncated,false);assert.equal(choice.optionsOffset,0);assert.equal(choice.optionsNextOffset,20);
    const otherRefs=await observeSession(f.directory,{observationId:observation.observationId,offset:observation.nextOffset,limit:3});
    assert.equal(otherRefs.refs[0].options?.[0].disabled,true,'a disabled ancestor disables the whole select');
    assert.equal(otherRefs.refs[1].options,undefined,'ordinary refs do not acquire option fields');
    assert.equal(Object.hasOwn(otherRefs.refs[1],'multiple'),false,'ordinary refs do not acquire select multiplicity');
    assert.equal(otherRefs.refs[2].multiple,true);assert.deepEqual(otherRefs.refs[2].options?.filter(option=>option.selected).map(option=>option.value),['first','second']);
    const detail=await observeSession(f.directory,{observationId:observation.observationId,ref:choice.ref,offset:20,limit:10});
    assert.equal(detail.refs.length,1);assert.equal(detail.observedAt,observation.observedAt);assert.equal(detail.screenshotPath,observation.screenshotPath);assert.equal(detail.surfaceId,observation.surfaceId);
    const options=detail.refs[0];assert.equal(options.multiple,false);assert.equal(options.options?.length,10);assert.equal(options.optionsOffset,20);assert.equal(options.optionsNextOffset,30);
    const selected=options.options!.find(option=>option.label==='Record 24')!;assert.ok(selected);assert.equal(selected.value,'record-24');
    assert.equal((await dispatchSession(f.directory,{actionId:'choose-observed-value',action:{kind:'select',target:{ref:choice.ref},values:[selected.value]}})).status,'input-completed');
    const after=await observeSession(f.directory,{screenshot:false});assert.match(after.text,/Chosen record-24/);
    const current=await observeSession(f.directory,{observationId:after.observationId,ref:after.refs[0].ref,offset:20,limit:10});
    assert.equal(current.refs[0].options?.find(option=>option.value===selected.value)?.selected,true);
    assert.deepEqual(await observeSession(f.directory,{observationId:observation.observationId,ref:choice.ref,offset:20,limit:10}),detail,'paging never rereads changed application state');
    const tail=await observeSession(f.directory,{observationId:observation.observationId,ref:choice.ref,offset:40,limit:10});
    assert.equal(tail.refs[0].options?.length,5);assert.equal(tail.refs[0].optionsNextOffset,undefined);assert.equal(tail.refs[0].optionsTruncated,false);
    await assert.rejects(observeSession(f.directory,{ref:choice.ref,screenshot:false}),{code:'OBSERVATION_ID_REQUIRED'});
    await assert.rejects(observeSession(f.directory,{observationId:observation.observationId,ref:otherRefs.refs[1].ref}),/OBSERVATION_REF_NOT_SELECT/);
    await assert.rejects(observeSession(f.directory,{observationId:observation.observationId,ref:'missing'}),/OBSERVATION_REF_NOT_FOUND/);
  }finally{await f.close();}
});

test('option retention caps distinguish omitted options from an available retained page',async()=>{
  const f=await fixture(`<!doctype html><select aria-label="Large choice">${Array.from({length:2005},(_,index)=>`<option value="id-${index}">Label ${index}</option>`).join('')}</select><select aria-label="After cap"><option value="later">Later</option></select>`);
  try{
    const observation=await observeSession(f.directory,{screenshot:false}),choice=observation.refs[0];
    assert.equal(choice.optionsTotal,2005);assert.equal(choice.optionsRetainedTotal,2000);assert.equal(choice.optionsTruncated,true);assert.equal(choice.options?.length,20);assert.equal(choice.optionsNextOffset,20);
    const tail=await observeSession(f.directory,{observationId:observation.observationId,ref:choice.ref,offset:1995,limit:10});
    assert.deepEqual(tail.refs[0].options?.map(option=>option.value),['id-1995','id-1996','id-1997','id-1998','id-1999']);
    assert.equal(tail.refs[0].optionsNextOffset,undefined);assert.equal(tail.refs[0].optionsTruncated,true);assert.equal(tail.truncated,true);
    assert.equal(observation.refs[1].optionsTotal,1);assert.equal(observation.refs[1].optionsRetainedTotal,0);assert.equal(observation.refs[1].optionsTruncated,true);assert.deepEqual(observation.refs[1].options,[]);
  }finally{await f.close();}
});

test('option character bounds retain exact values and labels or explicitly omit the whole option',async()=>{
  const value='x'.repeat(10000),label='L'.repeat(5000),oversized='Z'.repeat(250001);
  const f=await fixture(`<!doctype html><select aria-label="Long choice"><option value="${value}" label="${label}">Short text</option><option value="do-not-shorten" label="${oversized}">Oversized label</option><option value="after">After</option></select>`);
  try{
    const observation=await observeSession(f.directory,{screenshot:false}),choice=observation.refs[0];
    assert.deepEqual(choice.options,[{index:0,value,label,disabled:false,selected:true}]);
    assert.equal(choice.optionsTotal,3);assert.equal(choice.optionsRetainedTotal,1);assert.equal(choice.optionsTruncated,true);assert.equal(choice.optionsNextOffset,undefined);
    const detail=await observeSession(f.directory,{observationId:observation.observationId,ref:choice.ref,limit:1});assert.deepEqual(detail.refs[0].options,choice.options);
  }finally{await f.close();}
});
