import {createHash} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {lstat,open,readFile,realpath,type FileHandle} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {SessionError,sessionError,type SessionEvent} from './contracts.ts';
import {validId,writeJson} from './journal.ts';

export const MAX_PRINT_PDF_BYTES=512*1024*1024;
const origin='native-print-preview';
const pdfMagic=Buffer.from('%PDF-');
const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export type PrintArtifactDetail=Record<string,unknown>&{
  artifactId:string;downloadId:string;origin:'native-print-preview';
  status:'retaining'|'retained';path:string;bytes:number;sha256:string;mediaType:'application/pdf';
};

function identity(event:SessionEvent){
  const {artifactId,downloadId}=event.detail;
  if(event.kind!=='download'||!validId(artifactId)||(downloadId!==undefined&&downloadId!==artifactId))throw new SessionError('INVALID_PRINT_ARTIFACT');
  return artifactId;
}
function pdf(bytes:Buffer){
  if(!Buffer.isBuffer(bytes)||!Number.isSafeInteger(bytes.length)||bytes.length>MAX_PRINT_PDF_BYTES)throw new SessionError('DOWNLOAD_SIZE_LIMIT');
  if(bytes.length<pdfMagic.length||!bytes.subarray(0,pdfMagic.length).equals(pdfMagic))throw new SessionError('PRINT_ARTIFACT_NOT_PDF');
}
function sameInode(a:BigIntStats,b:BigIntStats){return a.dev===b.dev&&a.ino===b.ino;}
function unchanged(a:BigIntStats,b:BigIntStats){
  return sameInode(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.mode===b.mode&&a.nlink===b.nlink;
}
async function exactDirectory(path:string){
  const info=await lstat(path,{bigint:true});
  if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw new SessionError('PRINT_ARTIFACT_PATH_UNSAFE');
  return info;
}
async function destination(directory:string,event:SessionEvent){
  if(resolve(directory)!==directory)throw new SessionError('SESSION_PATH_NOT_ABSOLUTE');
  await exactDirectory(directory);await exactDirectory(join(directory,'downloads'));
  return join(directory,'downloads',identity(event));
}
function expected(event:SessionEvent,path:string){
  const detail=event.detail;
  if(detail.path!==path)throw new SessionError('PRINT_ARTIFACT_PATH_UNSAFE');
  if(typeof detail.bytes!=='number'||!Number.isSafeInteger(detail.bytes)||detail.bytes<pdfMagic.length||detail.bytes>MAX_PRINT_PDF_BYTES)throw new SessionError('DOWNLOAD_SIZE_LIMIT');
  if(typeof detail.sha256!=='string'||!/^[a-f0-9]{64}$/.test(detail.sha256))throw new SessionError('INVALID_PRINT_ARTIFACT');
  return {bytes:detail.bytes,sha256:detail.sha256};
}
function regular(info:BigIntStats){
  if(!info.isFile()||info.nlink!==1n||info.uid!==BigInt(process.getuid!()))throw new SessionError('PRINT_ARTIFACT_PATH_UNSAFE');
}
async function readExact(file:FileHandle,size:number,bytes:Buffer=Buffer.allocUnsafe(size)){
  let offset=0;
  while(offset<size){
    const chunk=await file.read(bytes,offset,size-offset,offset);
    if(chunk.bytesRead===0)throw new SessionError('ARTIFACT_CHANGED');offset+=chunk.bytesRead;
  }
  if((await file.read(Buffer.alloc(1),0,1,size)).bytesRead!==0)throw new SessionError('ARTIFACT_CHANGED');
  return bytes;
}
async function verifiedContents(file:FileHandle,path:string,claim:ReturnType<typeof expected>,reuse?:Buffer){
  const literal=await lstat(path,{bigint:true});regular(literal);
  if(await realpath(path)!==path)throw new SessionError('PRINT_ARTIFACT_PATH_UNSAFE');
  const before=await file.stat({bigint:true});regular(before);
  if(!unchanged(literal,before)||before.size!==BigInt(claim.bytes))throw new SessionError('ARTIFACT_CHANGED');
  const bytes=await readExact(file,claim.bytes,reuse),after=await file.stat({bigint:true});
  if(!unchanged(before,after)||!unchanged(after,await lstat(path,{bigint:true})))throw new SessionError('ARTIFACT_CHANGED');
  pdf(bytes);if(sha256(bytes)!==claim.sha256)throw new SessionError('ARTIFACT_CHANGED');
  return bytes;
}
async function verifiedBytes(directory:string,event:SessionEvent,seal=false){
  const path=await destination(directory,event),claim=expected(event,path);
  regular(await lstat(path,{bigint:true}));
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const bytes=await verifiedContents(file,path,claim);
    if(seal){
      await file.sync();await file.chmod(0o400);await file.sync();
      await verifiedContents(file,path,claim,bytes);
      const parent=await open(join(directory,'downloads'),constants.O_RDONLY|constants.O_NOFOLLOW);
      try{await parent.sync();}finally{await parent.close();}
    }
    await destination(directory,event);
    return bytes;
  }finally{await file.close();}
}

/** Read only the exact retained session artifact; this never opens a browser. */
export async function verifiedPdfArtifact(directory:string,event:SessionEvent):Promise<Buffer>{
  if(event.detail.status!=='retained')throw new SessionError('ARTIFACT_NOT_RETAINED');
  return verifiedBytes(directory,event);
}

async function writeArtifact(directory:string,event:SessionEvent,bytes:Buffer){
  const path=await destination(directory,event),parentPath=join(directory,'downloads');
  const parent=await open(parentPath,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const parentBefore=await parent.stat({bigint:true});
    if(!sameInode(parentBefore,await exactDirectory(parentPath)))throw new SessionError('PRINT_ARTIFACT_PATH_UNSAFE');
    const file=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{await file.writeFile(bytes);await file.sync();await file.chmod(0o400);await file.sync();}finally{await file.close();}
    await parent.sync();
    if(!sameInode(parentBefore,await exactDirectory(parentPath)))throw new SessionError('PRINT_ARTIFACT_PATH_UNSAFE');
    await verifiedBytes(directory,event);
  }finally{await parent.close();}
}
function uncertain(event:SessionEvent,error:unknown){
  event.detail={...event.detail,status:'retaining',error:sessionError(error)};
}

/** The caller reserves the download event and action result before fetching.
 * Persist the expected bytes before their exclusive write; never overwrite or
 * reacquire a PDF when custody is uncertain. A failed final persist is recovered
 * offline from the original event, path and digest. */
export async function retainPrintArtifact(directory:string,event:SessionEvent,bytes:Buffer,persist:()=>Promise<void>):Promise<PrintArtifactDetail>{
  pdf(bytes);const artifactId=identity(event);
  if(event.detail.status!=='receiving'||(event.detail.origin!==undefined&&event.detail.origin!==origin))throw new SessionError('PRINT_ARTIFACT_ALREADY_ATTEMPTED');
  const copy=Buffer.from(bytes),path=await destination(directory,event);
  event.detail={...event.detail,artifactId,downloadId:artifactId,origin,status:'retaining',path,bytes:copy.length,sha256:sha256(copy),mediaType:'application/pdf'};
  delete event.detail.error;
  await persist();
  try{await writeArtifact(directory,event,copy);}catch(error){
    uncertain(event,error);
    try{await persist();}catch(persistError){throw new AggregateError([error,persistError],'PRINT_ARTIFACT_RETENTION_UNCERTAIN');}
    throw error;
  }
  event.detail={...event.detail,status:'retained'};
  try{await persist();}catch(error){uncertain(event,error);throw error;}
  return event.detail as PrintArtifactDetail;
}

/** Call only after the session worker has stopped. Reconciliation changes no
 * effect identity and never prints or fetches again. Other events are preserved. */
export async function reconcilePrintArtifacts(directory:string):Promise<SessionEvent[]>{
  if(resolve(directory)!==directory)throw new SessionError('SESSION_PATH_NOT_ABSOLUTE');
  await exactDirectory(directory);
  const path=join(directory,'events.json');let original:string,info:BigIntStats;
  try{
    info=await lstat(path,{bigint:true});regular(info);
    if(await realpath(path)!==path)throw new SessionError('PRINT_ARTIFACT_PATH_UNSAFE');
    original=await readFile(path,'utf8');
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const events:SessionEvent[]=JSON.parse(original);
  if(!Array.isArray(events))throw new SessionError('INVALID_SESSION_EVENTS');
  let changed=false;
  for(const event of events){
    if(event?.kind!=='download'||event.detail?.origin!==origin||event.detail.status!=='retaining')continue;
    const before=JSON.stringify(event.detail);
    try{await verifiedBytes(directory,event,true);event.detail={...event.detail,status:'retained'};delete event.detail.error;}
    catch(error){uncertain(event,error);}
    changed||=before!==JSON.stringify(event.detail);
  }
  if(changed){
    if(!unchanged(info,await lstat(path,{bigint:true}))||await readFile(path,'utf8')!==original)throw new SessionError('SESSION_EVENTS_CHANGED','The session journal changed during offline reconciliation; no event changes were saved.');
    await writeJson(path,events);
  }
  return events;
}
