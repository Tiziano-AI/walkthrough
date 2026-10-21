#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,chmod,rename,unlink} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Explicit development/release setup only. Runtime never invokes a compiler.
if(process.argv.length!==2)throw new Error('SESSION_PROVISION_ACCEPTS_NO_ARGUMENTS');
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('SESSION_PROVISION_REQUIRES_DARWIN_ARM64');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),directory=join(root,'native');
const source=join(root,'src/session/native/process-reader.c'),binary=join(directory,'walkthrough-process-reader');
const temporary=join(directory,`.process-reader-${randomUUID()}`);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(directory,{recursive:true,mode:0o755});
try{
  const sourceSha256=hash(await readFile(source));
  execFileSync('/usr/bin/xcrun',['clang','-std=c11','-O2','-Wall','-Wextra','-Werror','-Wno-deprecated-declarations',source,'-o',temporary],{stdio:'pipe',env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME}});
  if(hash(await readFile(source))!==sourceSha256)throw new Error('SESSION_READER_SOURCE_CHANGED_DURING_BUILD');
  await chmod(temporary,0o755);
  const probe=JSON.parse(execFileSync(temporary,[],{encoding:'utf8',maxBuffer:16*1024*1024}));
  if(probe.schemaVersion!==1||!Array.isArray(probe.processes)||!probe.processes.some(row=>row.pid===process.pid&&row.commandSha256))throw new Error('SESSION_READER_BUILD_PROBE_FAILED');
  const manifest={schemaVersion:1,platform:process.platform,arch:process.arch,sourceSha256,binarySha256:hash(await readFile(temporary))};
  await rename(temporary,binary);
  await writeFile(join(directory,'process-reader.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o644});
  console.log(JSON.stringify({status:'provisioned',binary,manifest}));
}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
