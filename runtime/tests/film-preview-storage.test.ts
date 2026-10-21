import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,realpath,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beginPreview} from '../src/core/film-preview-storage.ts';

const moduleUrl=new URL('../src/core/film-preview-storage.ts',import.meta.url).href;
const staleId='preview-12345678-1234-1234-1234-123456789abc',stalePid=2147483647;
const childSource=`
import {readSync,writeSync} from 'node:fs';
const [moduleUrl,projectPath,mode]=process.argv.slice(1);
const print=value=>writeSync(1,JSON.stringify(value)+'\\n');
const wait=()=>{if(readSync(0,Buffer.alloc(1),0,1,null)!==1)throw new Error('test-controller-closed');};
if(mode==='pause-stale'){
  const kill=process.kill.bind(process);
  process.kill=(pid,signal)=>{if(pid===${stalePid}&&signal===0){print({kind:'stale-observed'});wait();}return kill(pid,signal);};
}
const {beginPreview}=await import(moduleUrl);
try{
  const attempt=await beginPreview(projectPath);
  print({kind:'result',status:'acquired',id:attempt.id,directory:attempt.directory,pid:process.pid});
  wait();await attempt.release();print({kind:'released'});
}catch(error){print({kind:'result',status:'failed',code:error.code??error.message});}
`;

async function fixture(t:TestContext){
  const path=await mkdtemp(join(await realpath(tmpdir()),'film-preview-storage-'));
  t.after(()=>rm(path,{recursive:true,force:true}));
  return path;
}
function contender(t:TestContext,path:string,mode='normal'){
  const child=spawn(process.execPath,['--input-type=module','-e',childSource,moduleUrl,path,mode],{stdio:['pipe','pipe','pipe']});
  const messages:any[]=[],waiting:Array<(value:any)=>void>=[];let buffer='',stderr='';
  const deliver=(value:any)=>{const resolve=waiting.shift();if(resolve)resolve(value);else messages.push(value);};
  child.stdout.on('data',chunk=>{buffer+=chunk.toString();for(let index;(index=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);deliver(JSON.parse(line));}});
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const closed=new Promise<void>((resolve)=>child.once('close',()=>{while(waiting.length)deliver({kind:'closed',stderr});resolve();}));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;});
  return {child,closed,next:()=>messages.length?Promise.resolve(messages.shift()):new Promise<any>(resolve=>waiting.push(resolve)),resume:()=>child.stdin.write('1')};
}

test('a paused stale-owner observation cannot let a second preview take ownership', {timeout:20000},async t=>{
  const path=await fixture(t),root=join(path,'previews');await mkdir(root);
  await writeFile(join(root,'active.json'),JSON.stringify({schemaVersion:1,id:staleId,pid:stalePid}),{mode:0o600});
  const first=contender(t,path,'pause-stale');assert.equal((await first.next()).kind,'stale-observed');
  const second=contender(t,path);assert.deepEqual(await second.next(),{kind:'result',status:'failed',code:'FILM_PREVIEW_ACTIVE'});await second.closed;
  first.resume();const acquired=await first.next();assert.equal(acquired.status,'acquired');
  assert.equal(JSON.parse(await readFile(join(root,'active.json'),'utf8')).id,acquired.id);
  const inode=(await lstat(join(root,'ownership.lock'))).ino;
  first.resume();assert.equal((await first.next()).kind,'released');await first.closed;
  const next=await beginPreview(path);await next.release();
  assert.equal((await lstat(join(root,'ownership.lock'))).ino,inode,'normal release preserves the locked inode');
});

test('process death releases the native lock and preserves the abandoned attempt', {timeout:20000},async t=>{
  const path=await fixture(t),first=contender(t,path),acquired=await first.next();assert.equal(acquired.status,'acquired');
  await assert.rejects(beginPreview(path),/FILM_PREVIEW_ACTIVE/);
  const inode=(await lstat(join(path,'previews','ownership.lock'))).ino;
  first.child.kill('SIGKILL');await first.closed;
  const recovered=await beginPreview(path);
  assert.notEqual(recovered.id,acquired.id);assert.equal((await lstat(acquired.directory)).isDirectory(),true);
  assert.equal((await lstat(join(path,'previews','ownership.lock'))).ino,inode);
  await recovered.release();
  await assert.rejects(lstat(join(path,'previews','active.json')),{code:'ENOENT'});
});
