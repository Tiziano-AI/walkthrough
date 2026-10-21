import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod,lstat,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {SessionEvent} from '../src/session/contracts.ts';
import {writeJson} from '../src/session/journal.ts';
import {MAX_PRINT_PDF_BYTES,reconcilePrintArtifacts,retainPrintArtifact,verifiedPdfArtifact} from '../src/session/print-artifact.ts';

const pdf=Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function reserved():SessionEvent{return {eventId:'event-print',kind:'download',at:'2026-10-08',pageId:'page-report',actionId:'save-print',detail:{artifactId:'artifact-print',downloadId:'artifact-print',filename:'report.pdf',status:'receiving'}};}
async function fixture(){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'walkthrough-print-artifact-')));
  await mkdir(join(directory,'downloads'),{mode:0o700});
  const event=reserved(),other:SessionEvent={eventId:'event-other',kind:'dialog',at:'2026-10-08',pageId:'page-report',detail:{dialogId:'dialog-original',status:'unresolved'}};
  const events=[event,other],path=join(directory,'downloads','artifact-print');
  return {directory,event,other,events,path,persist:()=>writeJson(join(directory,'events.json'),events),cleanup:()=>rm(directory,{recursive:true,force:true})};
}
function retaining(event:SessionEvent,path:string){
  event.detail={...event.detail,origin:'native-print-preview',status:'retaining',path,bytes:pdf.length,sha256:hash(pdf),mediaType:'application/pdf'};
}

test('retention journals exact custody before writing and returns the original PDF',async()=>{
  const f=await fixture(),states:string[]=[];
  try{
    const result=await retainPrintArtifact(f.directory,f.event,pdf,async()=>{
      states.push(String(f.event.detail.status));
      if(states.length===1){
        assert.equal(f.event.detail.path,f.path);assert.equal(f.event.detail.bytes,pdf.length);assert.equal(f.event.detail.sha256,hash(pdf));
        await assert.rejects(lstat(f.path),{code:'ENOENT'});
      }
      await f.persist();
    });
    assert.deepEqual(states,['retaining','retained']);assert.equal(result.origin,'native-print-preview');
    assert.equal(result.mediaType,'application/pdf');assert.equal((await lstat(f.path)).mode&0o777,0o400);
    assert.deepEqual(await verifiedPdfArtifact(f.directory,f.event),pdf);
    assert.deepEqual(JSON.parse(await readFile(join(f.directory,'events.json'),'utf8'))[1],f.other);
  }finally{await f.cleanup();}
});

test('same-length changed bytes are refused rather than served as a retained PDF',async()=>{
  const f=await fixture();try{
    await retainPrintArtifact(f.directory,f.event,pdf,f.persist);
    const changed=Buffer.from(pdf);changed[changed.indexOf('Catalog')]='X'.charCodeAt(0);
    await chmod(f.path,0o600);await writeFile(f.path,changed);await chmod(f.path,0o400);
    await assert.rejects(verifiedPdfArtifact(f.directory,f.event),{code:'ARTIFACT_CHANGED'});
  }finally{await f.cleanup();}
});

test('a crash after the file write recovers the exact original artifact without another write',async()=>{
  const f=await fixture();let persists=0;
  try{
    await assert.rejects(retainPrintArtifact(f.directory,f.event,pdf,async()=>{
      if(++persists===2)throw new Error('synthetic stopped worker');await f.persist();
    }),/synthetic stopped worker/);
    const before=await lstat(f.path);
    assert.equal(JSON.parse(await readFile(join(f.directory,'events.json'),'utf8'))[0].detail.status,'retaining');
    const recovered=await reconcilePrintArtifacts(f.directory),after=await lstat(f.path);
    assert.equal(recovered[0].detail.status,'retained');assert.equal(recovered[0].detail.error,undefined);
    assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
    assert.deepEqual(await verifiedPdfArtifact(f.directory,recovered[0]),pdf);assert.deepEqual(recovered[1],f.other);
    assert.deepEqual(await reconcilePrintArtifacts(f.directory),recovered);
  }finally{await f.cleanup();}
});

test('an interrupted partial write remains uncertain and its bytes are not replaced',async()=>{
  const f=await fixture();try{
    retaining(f.event,f.path);await f.persist();const partial=pdf.subarray(0,12);await writeFile(f.path,partial);
    const recovered=await reconcilePrintArtifacts(f.directory);
    assert.equal(recovered[0].detail.status,'retaining');assert.equal((recovered[0].detail.error as {code:string}).code,'ARTIFACT_CHANGED');
    assert.deepEqual(await readFile(f.path),partial);
    await assert.rejects(verifiedPdfArtifact(f.directory,recovered[0]),{code:'ARTIFACT_NOT_RETAINED'});
  }finally{await f.cleanup();}
});

test('missing print bytes remain uncertain without changing unrelated downloads',async()=>{
  const f=await fixture();try{
    retaining(f.event,f.path);
    const unrelated=reserved();unrelated.eventId='ordinary-download';unrelated.detail.status='retaining';f.events.push(unrelated);
    await f.persist();const recovered=await reconcilePrintArtifacts(f.directory);
    assert.equal(recovered[0].detail.status,'retaining');assert.equal((recovered[0].detail.error as {code:string}).code,'ENOENT');
    assert.deepEqual(recovered[1],f.other);assert.deepEqual(recovered[2],unrelated);
    await assert.rejects(lstat(f.path),{code:'ENOENT'});
  }finally{await f.cleanup();}
});

test('invalid PDF bytes are refused before custody is journaled or written',async()=>{
  const f=await fixture();let persisted=false;
  try{
    await assert.rejects(retainPrintArtifact(f.directory,f.event,Buffer.from('<html>not a PDF</html>'),async()=>{persisted=true;}),{code:'PRINT_ARTIFACT_NOT_PDF'});
    assert.equal(persisted,false);assert.equal(f.event.detail.status,'receiving');await assert.rejects(lstat(f.path),{code:'ENOENT'});
  }finally{await f.cleanup();}
});

test('an existing destination or symlink is never overwritten or followed',async()=>{
  for(const linked of [false,true]){
    const f=await fixture();try{
      const external=join(f.directory,'unrelated.pdf');await writeFile(external,pdf);
      if(linked)await symlink(external,f.path);else await writeFile(f.path,Buffer.from('original private bytes'));
      await assert.rejects(retainPrintArtifact(f.directory,f.event,pdf,f.persist),{code:'EEXIST'});
      assert.deepEqual(await readFile(external),pdf);
      if(linked){
        const recovered=await reconcilePrintArtifacts(f.directory);assert.equal(recovered[0].detail.status,'retaining');
        assert.equal((recovered[0].detail.error as {code:string}).code,'PRINT_ARTIFACT_PATH_UNSAFE');
      }else assert.equal(await readFile(f.path,'utf8'),'original private bytes');
    }finally{await f.cleanup();}
  }
});

test('verification refuses paths outside the exact session identity and invalid byte bounds',async()=>{
  const f=await fixture();try{
    await retainPrintArtifact(f.directory,f.event,pdf,f.persist);
    const original=structuredClone(f.event.detail);
    f.event.detail.path=join(f.directory,'some-other.pdf');await assert.rejects(verifiedPdfArtifact(f.directory,f.event),{code:'PRINT_ARTIFACT_PATH_UNSAFE'});
    for(const bytes of [NaN,Infinity,-1,1.5,MAX_PRINT_PDF_BYTES+1]){
      f.event.detail={...original,bytes};await assert.rejects(verifiedPdfArtifact(f.directory,f.event),{code:'DOWNLOAD_SIZE_LIMIT'});
    }
  }finally{await f.cleanup();}
});

test('a failed first journal persist prevents the file effect',async()=>{
  const f=await fixture();try{
    await assert.rejects(retainPrintArtifact(f.directory,f.event,pdf,async()=>{throw new Error('journal unavailable');}),/journal unavailable/);
    await assert.rejects(lstat(f.path),{code:'ENOENT'});
  }finally{await f.cleanup();}
});
