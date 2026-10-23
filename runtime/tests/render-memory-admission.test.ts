import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import {streamingMemoryAdmission,requireStreamingMemory,verifyStreamingEncodingStrategy,readStreamingEncodingRefusal,
  REMOTION_MEMORY_ADMISSION_VERSION,REMOTION_STREAMING_STRATEGY_SHA256} from '../src/render/memory-admission.ts';

const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const dependencyDirectory=path.dirname(createRequire(import.meta.url).resolve('@remotion/renderer'));

test('the reviewed upstream strategy has no capacity-driven all-frame fallback',async()=>{
  const identity=await verifyStreamingEncodingStrategy(),source=await fs.readFile(identity.filePath,'utf8');
  assert.equal(identity.version,REMOTION_MEMORY_ADMISSION_VERSION);
  assert.equal(identity.sha256,REMOTION_STREAMING_STRATEGY_SHA256);
  assert.equal(digest(source),identity.sha256);
  assert.equal(identity.admission,'walkthrough-worker');
  await assert.rejects(fs.access(path.join(dependencyDirectory,'prestitcher-memory-usage.js')),{code:'ENOENT'});
  const decision=source.match(/^    const parallelEncoding = (.*);$/m)?.[1];
  assert.ok(decision);assert.doesNotMatch(decision,/Memory|memory/);
  for(const disallowParallelEncoding of [false,true]){
    assert.equal(vm.runInNewContext(decision,{disallowParallelEncoding,codec:'h264',can_use_parallel_encoding_1:{canUseParallelEncoding:(codec:string)=>codec==='h264'}}),!disallowParallelEncoding);
  }
});

test('worker capacity admission keeps the strict estimate and reserve independently of upstream strategy',()=>{
  for(const [available,expected] of [[4_073_599_999,false],[4_073_600_000,false],[4_073_600_001,true],[0,false]] as const){
    const result=streamingMemoryAdmission(1920,1080,available);
    assert.equal(result.hasEnoughMemory,expected);assert.equal(result.estimatedUsageBytes,2_073_600_000);
    assert.equal(result.minimumRemainingBytes,2_000_000_000);assert.equal(result.requiredAvailableBytesExclusive,4_073_600_000);
    assert.equal(result.memorySource,'node:process.availableMemory');assert.equal(result.sampleValid,true);
  }
  assert.equal(streamingMemoryAdmission(3200,1800,7_760_000_000).hasEnoughMemory,false);
  assert.equal(streamingMemoryAdmission(3200,1800,7_760_000_001).hasEnoughMemory,true);
});

test('invalid native samples and dimensions refuse instead of forcing streaming',()=>{
  for(const sample of [NaN,Infinity,-Infinity,-1,4_073_600_001.5,Number.MAX_SAFE_INTEGER+1]){
    const result=streamingMemoryAdmission(1920,1080,sample);
    assert.equal(result.hasEnoughMemory,false);assert.equal(result.sampleValid,false);assert.equal(result.availableBytes,null);
  }
  for(const [width,height] of [[0,1080],[-1,1080],[1920.5,1080],[Number.MAX_SAFE_INTEGER,1080]])assert.throws(()=>streamingMemoryAdmission(width,height,99_000_000_000),/dimensions_invalid/);
});

test('the actual worker admission samples once and retains the primary cause before throwing',t=>{
  const log:string[]=[];let reads=0;
  t.mock.method(process,'availableMemory',()=>{reads++;return 4_073_600_000;});
  t.mock.method(process.stderr,'write',(line:string)=>{log.push(line);return true;});
  assert.throws(()=>requireStreamingMemory(1920,1080),/streaming_encoding_required/);
  assert.equal(reads,1);assert.equal(log.length,2);assert.equal(log[1],'render:streaming_encoding_required\n');
  assert.equal(JSON.parse(log[0]).hasEnoughMemory,false);
});

test('strategy verification rejects unknown bytes/version without provisioning or modifying dependencies',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'walkthrough-memory-strategy-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const dependency=path.join(directory,'node_modules/@remotion/renderer'),dist=path.join(dependency,'dist');
  await fs.mkdir(dist,{recursive:true});await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({type:'module'}));
  const manifest=path.join(dependency,'package.json');
  await fs.writeFile(manifest,JSON.stringify({version:REMOTION_MEMORY_ADMISSION_VERSION,main:'dist/index.js'}));
  await fs.writeFile(path.join(dist,'index.js'),'exports.unused=true;\n');
  const file=path.join(dist,'render-media.js'),original=await fs.readFile(path.join(dependencyDirectory,'render-media.js'));
  await fs.writeFile(file,original);const modulePath=path.join(directory,'memory-admission.ts');
  await fs.copyFile(new URL('../src/render/memory-admission.ts',import.meta.url),modulePath);
  const module=await import(pathToFileURL(modulePath).href) as typeof import('../src/render/memory-admission.ts');
  assert.equal((await module.verifyStreamingEncodingStrategy()).sha256,REMOTION_STREAMING_STRATEGY_SHA256);
  await fs.appendFile(file,'\n// unknown bytes\n');const changed=await fs.readFile(file);
  await assert.rejects(module.verifyStreamingEncodingStrategy(),/strategy_hash_mismatch/);assert.deepEqual(await fs.readFile(file),changed);
  await fs.writeFile(manifest,JSON.stringify({version:'4.0.539',main:'dist/index.js'}));
  await assert.rejects(module.verifyStreamingEncodingStrategy(),/version_mismatch/);
});

test('structured refusal retains numeric admission before secondary cleanup without exposing other log fields',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'walkthrough-memory-refusal-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));const diagnosticPath=path.join(directory,'renderer.log');
  const line=streamingMemoryAdmission(1920,1080,4_073_600_000);
  await fs.writeFile(diagnosticPath,`${JSON.stringify({...line,privateText:'never public'})}\nrender:streaming_encoding_required\nTarget.createTarget: Target closed\n`);
  assert.deepEqual(await readStreamingEncodingRefusal(diagnosticPath),{causeCode:'render:streaming_encoding_required',memoryAdmission:line});
  await fs.writeFile(diagnosticPath,`${'unrelated verbose output '.repeat(20_000)}\n${JSON.stringify(line)}\nrender:streaming_encoding_required\n`);
  assert.deepEqual(await readStreamingEncodingRefusal(diagnosticPath),{causeCode:'render:streaming_encoding_required',memoryAdmission:line});
  await fs.writeFile(diagnosticPath,`${JSON.stringify(line)}\nTarget.createTarget: Target closed\n`);
  assert.equal(await readStreamingEncodingRefusal(diagnosticPath),undefined,'a low sample or later cleanup error alone is not the cause');
  for(const invalid of [{...line,hasEnoughMemory:true},{...line,estimatedUsageBytes:1},{...line,memorySource:'private/path'},null]){
    await fs.writeFile(diagnosticPath,`${JSON.stringify(invalid)}\nrender:streaming_encoding_required\n`);
    assert.deepEqual(await readStreamingEncodingRefusal(diagnosticPath),{causeCode:'render:streaming_encoding_required'});
  }
  const invalidNativeSample={...line,sampleValid:false,availableBytes:null,hasEnoughMemory:false};
  await fs.writeFile(diagnosticPath,`${JSON.stringify(invalidNativeSample)}\nrender:streaming_encoding_required\n`);
  assert.deepEqual(await readStreamingEncodingRefusal(diagnosticPath),{causeCode:'render:streaming_encoding_required',memoryAdmission:invalidNativeSample});
});
