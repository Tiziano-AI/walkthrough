import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {executeLocal} from '../src/render/media.ts';

test('composition network preflight observes the real macOS outbound denial',()=>{
  const root=fileURLToPath(new URL('..',import.meta.url));
  const output=execFileSync('/usr/bin/sandbox-exec',['-f',join(root,'scripts/loopback-only.sb'),process.execPath,'--input-type=module','-e',`import {assertCompositionNetworkIsolation} from ${JSON.stringify(join(root,'src/core/film.ts'))}; await assertCompositionNetworkIsolation(); console.log('denied');`],{encoding:'utf8',timeout:10000});
  assert.equal(output.trim(),'denied');
});

test('render worker gets an explicit runtime cwd independent of the caller',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'film-process-'))),log=join(directory,'cwd.log');
  await executeLocal(process.execPath,['-e','console.log(process.cwd())'],log,10000,undefined,undefined,directory);
  assert.equal((await readFile(log,'utf8')).trim(),directory);
});
test('transient group signal EPERM still requires observed absence before reporting worker failure',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'film-process-')),originalKill=process.kill;
  let denied=false,absent=false;
  const mock=t.mock.method(process,'kill',function(pid:number,signal?:number|NodeJS.Signals){
    if(pid<0&&signal==='SIGKILL'&&!denied){denied=true;throw Object.assign(Error('transient group teardown'),{code:'EPERM'});}
    try{return originalKill.call(process,pid,signal);}catch(error){if(pid<0&&signal===0&&(error as NodeJS.ErrnoException).code==='ESRCH')absent=true;throw error;}
  });
  try{await assert.rejects(executeLocal(process.execPath,['-e','process.exit(23)'],join(directory,'failure.log')),/render:local_process_failed/);assert.equal(denied,true);assert.equal(absent,true);}
  finally{mock.mock.restore();}
});
