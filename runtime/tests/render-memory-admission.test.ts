import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import test,{type TestContext} from 'node:test';
import {patchMemoryAdmissionSource,verifyMemoryAdmissionPatch,readStreamingEncodingRefusal,
  REMOTION_MEMORY_ADMISSION_VERSION,REMOTION_MEMORY_ADMISSION_PATCH_ID,
  REMOTION_MEMORY_ADMISSION_UPSTREAM_SHA256,REMOTION_MEMORY_ADMISSION_PATCHED_SHA256,
  type MemoryAdmission} from '../src/render/memory-admission.ts';

const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const dependencyDirectory=path.dirname(createRequire(import.meta.url).resolve('@remotion/renderer'));

async function upstreamSource(){
  const installed=await fs.readFile(path.join(dependencyDirectory,'prestitcher-memory-usage.js'),'utf8');
  if(digest(installed)===REMOTION_MEMORY_ADMISSION_UPSTREAM_SHA256)return installed;
  assert.equal(digest(installed),REMOTION_MEMORY_ADMISSION_PATCHED_SHA256,'unknown dependency bytes cannot become the test fixture');
  // The independent upstream hash proves every byte outside the narrow sample
  // and its diagnostic is unchanged, including the estimate and strict reserve.
  const original=installed.replace(/    \/\/ walkthrough-memory-admission-v1:[\s\S]*?    const validMemorySample = Number\.isSafeInteger\(freeMemory\) && freeMemory >= 0;/,
    '    const freeMemory = (0, get_available_memory_1.getAvailableMemory)(logLevel);')
    .replace("    const hasEnoughMemory = (process.platform !== 'darwin' || validMemorySample) && (0, exports.hasEnoughMemoryForParallelEncoding)({",'    const hasEnoughMemory = (0, exports.hasEnoughMemoryForParallelEncoding)({')
    .replace(/    \/\/ Keep the actual admission input before onStart[\s\S]*?    \}\) \+ '\\n'\);\n/,'');
  assert.equal(digest(original),REMOTION_MEMORY_ADMISSION_UPSTREAM_SHA256);
  return original;
}

function executeSource(source:string,{platform='darwin',availableBytes=57_000_000_000,upstreamBytes=750_000_000,width=1920,height=1080}:{platform?:string;availableBytes?:number;upstreamBytes?:number;width?:number;height?:number}={}){
  const exports={} as {shouldUseParallelEncoding:(input:{width:number;height:number;logLevel:string})=>{hasEnoughMemory:boolean;freeMemory:number;estimatedUsage:number}};
  const log:string[]=[];let nativeReads=0,upstreamReads=0;
  vm.runInNewContext(source,{exports,Object,process:{platform,availableMemory:()=>{nativeReads++;return availableBytes;},stderr:{write:(line:string)=>log.push(line)}},
    require:(name:string)=>{assert.equal(name,'./memory/get-available-memory');return {getAvailableMemory:()=>{upstreamReads++;return upstreamBytes;}};}});
  const result=exports.shouldUseParallelEncoding({width,height,logLevel:'warn'});
  return {result:{...result},nativeReads,upstreamReads,log};
}

async function fixture(t:TestContext){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'walkthrough-memory-admission-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const dependency=path.join(directory,'node_modules/@remotion/renderer'),dist=path.join(dependency,'dist');
  await fs.mkdir(dist,{recursive:true});
  await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({type:'module'}));
  await fs.writeFile(path.join(dependency,'package.json'),JSON.stringify({version:REMOTION_MEMORY_ADMISSION_VERSION,main:'dist/index.js'}));
  await fs.writeFile(path.join(dist,'index.js'),'exports.unused=true;\n');
  const file=path.join(dist,'prestitcher-memory-usage.js');
  await fs.writeFile(file,await upstreamSource(),{mode:0o640});
  const modulePath=path.join(directory,'memory-admission.ts');
  await fs.copyFile(new URL('../src/render/memory-admission.ts',import.meta.url),modulePath);
  const module=await import(pathToFileURL(modulePath).href) as typeof import('../src/render/memory-admission.ts');
  return {directory,dependency,file,module};
}

test('Darwin admission uses available memory at the actual pinned prestitcher seam, not its free-only fallback',async()=>{
  const upstream=await upstreamSource(),patched=patchMemoryAdmissionSource(upstream);
  const old=executeSource(upstream),current=executeSource(patched);
  assert.equal(old.result.hasEnoughMemory,false,'750 MB of free-only memory triggers the observed upstream refusal');
  assert.deepEqual(current.result,{hasEnoughMemory:true,freeMemory:57_000_000_000,estimatedUsage:2_073_600_000});
  assert.equal(current.nativeReads,1,'the actual admission samples once, not again during onStart');
  assert.equal(current.upstreamReads,0);
  assert.equal(current.log.length,1);
  assert.deepEqual(JSON.parse(current.log[0]),{kind:'walkthrough-render-memory-admission',schemaVersion:1,platform:'darwin',memorySource:'node:process.availableMemory',
    sampleValid:true,availableBytes:57_000_000_000,estimatedUsageBytes:2_073_600_000,minimumRemainingBytes:2_000_000_000,requiredAvailableBytesExclusive:4_073_600_000,width:1920,height:1080,hasEnoughMemory:true});
  assert.equal(digest(patched),REMOTION_MEMORY_ADMISSION_PATCHED_SHA256);
});

test('Darwin keeps the upstream estimate, strict reserve and genuine memory refusal',async()=>{
  const source=patchMemoryAdmissionSource(await upstreamSource());
  // Hand-computed from upstream's 1000 bytes/pixel and 2 GB reserve. Equality
  // must still refuse; this is not a forced-streaming or lowered-threshold patch.
  for(const [availableBytes,expected] of [[4_073_599_999,false],[4_073_600_000,false],[4_073_600_001,true],[0,false]] as const){
    const {result,log}=executeSource(source,{availableBytes});
    assert.equal(result.hasEnoughMemory,expected);assert.equal(result.estimatedUsage,2_073_600_000);
    assert.equal(JSON.parse(log[0]).hasEnoughMemory,expected);
  }
  assert.equal(executeSource(source,{width:3200,height:1800,availableBytes:7_760_000_000}).result.hasEnoughMemory,false);
  assert.equal(executeSource(source,{width:3200,height:1800,availableBytes:7_760_000_001}).result.hasEnoughMemory,true);
});

test('non-Darwin admission preserves the native Remotion sampler and its decision',async()=>{
  const source=patchMemoryAdmissionSource(await upstreamSource());
  for(const platform of ['linux','win32'])for(const upstreamBytes of [4_073_600_000,4_073_600_001]){
    const current=executeSource(source,{platform,upstreamBytes,availableBytes:99_000_000_000});
    assert.deepEqual(current.result,executeSource(await upstreamSource(),{platform,upstreamBytes}).result);
    assert.equal(current.nativeReads,0);assert.equal(current.upstreamReads,1);
    assert.equal(JSON.parse(current.log[0]).memorySource,'@remotion/renderer:getAvailableMemory');
  }
});

test('invalid Darwin native samples refuse streaming rather than treating Infinity or unknown capacity as sufficient',async()=>{
  const source=patchMemoryAdmissionSource(await upstreamSource());
  for(const availableBytes of [NaN,Infinity,-Infinity,-1,4_073_600_001.5,Number.MAX_SAFE_INTEGER+1]){
    const {result,log}=executeSource(source,{availableBytes});
    assert.equal(result.hasEnoughMemory,false);
    const diagnostic=JSON.parse(log[0]);
    assert.equal(diagnostic.sampleValid,false);assert.equal(diagnostic.availableBytes,null);assert.equal(diagnostic.hasEnoughMemory,false);
  }
  assert.equal(executeSource(source,{platform:'linux',upstreamBytes:Infinity}).result.hasEnoughMemory,true,'the Darwin guard cannot reinterpret the non-Darwin sampler');
});

test('installed admission verifies the exact pinned prestitcher bytes',async()=>{
  const identity=await verifyMemoryAdmissionPatch();
  assert.equal(identity.patchId,REMOTION_MEMORY_ADMISSION_PATCH_ID);
  assert.equal(identity.version,REMOTION_MEMORY_ADMISSION_VERSION);
  assert.equal(identity.sha256,REMOTION_MEMORY_ADMISSION_PATCHED_SHA256);
  assert.equal(digest(await fs.readFile(identity.filePath)),identity.sha256);
});

test('explicit provision preserves mode, is idempotent and never changes the global memory sampler',async t=>{
  const f=await fixture(t),other=path.join(path.dirname(f.file),'memory/get-available-memory.js');
  await fs.mkdir(path.dirname(other));await fs.writeFile(other,'untouched cache/thread sampler');
  await assert.rejects(f.module.verifyMemoryAdmissionPatch(),/patch_not_provisioned/);
  const identity=await f.module.provisionMemoryAdmissionPatch();
  assert.deepEqual(await f.module.verifyMemoryAdmissionPatch(),identity);
  assert.deepEqual(await f.module.provisionMemoryAdmissionPatch(),identity);
  assert.equal((await fs.stat(f.file)).mode&0o777,0o640);
  assert.equal(await fs.readFile(other,'utf8'),'untouched cache/thread sampler');
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).filter(name=>name.includes('walkthrough-patch')),[]);
});

test('unknown bytes, changed markers and version drift refuse rather than repairing production silently',async t=>{
  const f=await fixture(t),upstream=await upstreamSource();
  for(const unknown of ['unknown bytes',`${upstream}\n`,patchMemoryAdmissionSource(upstream)])assert.throws(()=>patchMemoryAdmissionSource(unknown),/upstream_hash_mismatch/);
  await f.module.provisionMemoryAdmissionPatch();
  await fs.appendFile(f.file,'\n// foreign edit with the patch marker retained\n');
  const changed=await fs.readFile(f.file);
  await assert.rejects(f.module.verifyMemoryAdmissionPatch(),/patch_not_provisioned/);
  await assert.rejects(f.module.provisionMemoryAdmissionPatch(),/upstream_hash_mismatch/);
  assert.deepEqual(await fs.readFile(f.file),changed);
  await fs.writeFile(path.join(f.dependency,'package.json'),JSON.stringify({version:'4.0.521',main:'dist/index.js'}));
  await assert.rejects(f.module.verifyMemoryAdmissionPatch(),/version_mismatch/);
  await assert.rejects(f.module.provisionMemoryAdmissionPatch(),/version_mismatch/);
});

test('a preexisting patch temporary is not owned or removed by a rejected provision attempt',async t=>{
  const f=await fixture(t),temporary=`${f.file}.walkthrough-patch-${process.pid}`;
  await fs.writeFile(temporary,'preexisting bytes');
  const original=await fs.readFile(f.file);
  await assert.rejects(f.module.provisionMemoryAdmissionPatch(),{code:'EEXIST'});
  assert.equal(await fs.readFile(temporary,'utf8'),'preexisting bytes');
  assert.deepEqual(await fs.readFile(f.file),original);
});

test('structured refusal retains actual numeric admission before secondary cleanup without exposing other log fields',async t=>{
  const f=await fixture(t),diagnosticPath=path.join(f.directory,'renderer.log');
  const line=JSON.parse(executeSource(patchMemoryAdmissionSource(await upstreamSource()),{availableBytes:4_073_600_000}).log[0]) as MemoryAdmission;
  await fs.writeFile(diagnosticPath,`${JSON.stringify({...line,privateText:'never public'})}\nrender:streaming_encoding_required\nTarget.createTarget: Target closed\n`);
  assert.deepEqual(await readStreamingEncodingRefusal(diagnosticPath),{causeCode:'render:streaming_encoding_required',memoryAdmission:line});
  await fs.writeFile(diagnosticPath,`${'unrelated verbose output '.repeat(20_000)}\n${JSON.stringify(line)}\nrender:streaming_encoding_required\n`);
  assert.deepEqual(await readStreamingEncodingRefusal(diagnosticPath),{causeCode:'render:streaming_encoding_required',memoryAdmission:line},'a long discarded line before the admission cannot hide its primary cause');
  await fs.writeFile(diagnosticPath,`${JSON.stringify(line)}\nTarget.createTarget: Target closed\n`);
  assert.equal(await readStreamingEncodingRefusal(diagnosticPath),undefined,'memory refusal is not inferred from a later browser error or a low sample alone');
  for(const invalid of [{...line,hasEnoughMemory:true},{...line,estimatedUsageBytes:1},{...line,memorySource:'private/path'},null]){
    await fs.writeFile(diagnosticPath,`${JSON.stringify(invalid)}\nrender:streaming_encoding_required\n`);
    assert.deepEqual(await readStreamingEncodingRefusal(diagnosticPath),{causeCode:'render:streaming_encoding_required'});
  }
  const invalidNativeSample={...line,sampleValid:false,availableBytes:null,hasEnoughMemory:false};
  await fs.writeFile(diagnosticPath,`${JSON.stringify(invalidNativeSample)}\nrender:streaming_encoding_required\n`);
  assert.deepEqual(await readStreamingEncodingRefusal(diagnosticPath),{causeCode:'render:streaming_encoding_required',memoryAdmission:invalidNativeSample});
});
