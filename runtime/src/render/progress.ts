import {constants} from 'node:fs';
import {lstat,open,realpath,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import type {RenderMediaProgress} from '@remotion/renderer';

const phases=['staging-sources','staging-audio','bundling-renderer','selecting-composition','rendering-frames','rendering-and-encoding','encoding','muxing','finishing-media'] as const;
type RenderPhase=typeof phases[number];
export type RenderProgressUpdate={phase:RenderPhase;frames?:{rendered:number;total:number};source?:{index:number;total:number;stagedFrames:number;selectedFrames:number}};
export type RenderProgressRecord=RenderProgressUpdate&{schemaVersion:1;kind:'render-progress';recordedAt:string};
const maximumBytes=4096;
const minimumWriteIntervalMs=1000;
const sourceProgress=(source:NonNullable<RenderProgressUpdate['source']>)=>({index:source.index,total:source.total,stagedFrames:source.stagedFrames,selectedFrames:source.selectedFrames});

/** Only renderedFrames is an actual frame count. Remotion's encodedFrames is
 * a weighted encode/mux aggregate, so neither it nor its ETA is exposed. */
export function remotionProgress(progress:RenderMediaProgress,total:number):RenderProgressUpdate{
  return {phase:progress.stitchStage==='muxing'?'muxing':progress.renderedFrames<total?'rendering-and-encoding':'encoding',
    frames:{rendered:progress.renderedFrames,total}};
}

function validRecord(value:unknown):value is RenderProgressRecord{
  const p=value as RenderProgressRecord;
  return !!p&&p.schemaVersion===1&&p.kind==='render-progress'&&phases.includes(p.phase)
    &&typeof p.recordedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(p.recordedAt)&&Number.isFinite(Date.parse(p.recordedAt))
    &&(p.frames===undefined||!!p.frames&&Number.isSafeInteger(p.frames.total)&&p.frames.total>0
      &&Number.isSafeInteger(p.frames.rendered)&&p.frames.rendered>=0&&p.frames.rendered<=p.frames.total)
    &&(p.source===undefined||p.phase==='staging-sources'&&!!p.source&&Number.isSafeInteger(p.source.index)&&p.source.index>0
      &&Number.isSafeInteger(p.source.total)&&p.source.total>=p.source.index&&Number.isSafeInteger(p.source.selectedFrames)&&p.source.selectedFrames>0
      &&Number.isSafeInteger(p.source.stagedFrames)&&p.source.stagedFrames>=0&&p.source.stagedFrames<=p.source.selectedFrames);
}

/** Supervision uses advancing work, never the timestamp or an unchanged rewrite. */
export async function readRenderWorkCounter(directory:string):Promise<number|undefined>{
  const file=await open(join(directory,'progress.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    if(!(await file.stat()).isFile())return;
    const bytes=Buffer.alloc(maximumBytes+1),{bytesRead}=await file.read(bytes,0,bytes.length,0);
    if(bytesRead>maximumBytes)return;
    const record:unknown=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));
    if(!validRecord(record))return;
    // Frame count is bounded by total; phase steps remain strictly above it.
    return phases.indexOf(record.phase)+(record.frames?record.frames.rendered/(record.frames.total+1):0);
  }finally{await file.close();}
}

async function writeProgress(directory:string,record:RenderProgressRecord){
  const destination=join(directory,'progress.json'),temporary=`${destination}.${randomUUID()}.tmp`;
  const file=await open(temporary,'wx',0o600);
  try{
    try{await file.writeFile(JSON.stringify(record)+'\n');}finally{await file.close();}
    await rename(temporary,destination);
  }finally{await unlink(temporary).catch(()=>{});}
}

/** One pending snapshot, one atomic write at a time. Callbacks are coalesced;
 * phases and explicit flushes bypass the interval. No heartbeat or liveness inference.
 * A reporting failure keeps the previous record and never changes the media outcome. */
export function createRenderProgressWriter(directory:string,dependencies:{
  now?:()=>number;write?:(record:RenderProgressRecord)=>Promise<void>;warn?:(message:string)=>void;
}={}){
  const now=dependencies.now??Date.now,write=dependencies.write??((record)=>writeProgress(directory,record));
  const warn=dependencies.warn??((message)=>process.stderr.write(message+'\n'));
  let pending:RenderProgressRecord|undefined,writing:Promise<void>|undefined;
  let lastWriteAt=-Infinity,lastPhase:RenderPhase|undefined,failed=false;
  const disable=()=>{
    failed=true;pending=undefined;
    try{warn('render:progress_unavailable; retained progress may be outdated; composition status remains authoritative');}catch{}
  };
  const pump=(force=false)=>{
    if(failed||writing||!pending||!force&&pending.phase===lastPhase&&now()-lastWriteAt<minimumWriteIntervalMs)return;
    const record=pending;pending=undefined;lastWriteAt=now();lastPhase=record.phase;
    writing=(async()=>{try{await write(record);}catch{disable();}})().finally(()=>{writing=undefined;pump();});
  };
  return {
    record(update:RenderProgressUpdate){
      if(failed)return;
      const record:RenderProgressRecord={schemaVersion:1,kind:'render-progress',recordedAt:new Date(now()).toISOString(),phase:update.phase,
        ...(update.frames===undefined?{}:{frames:{rendered:update.frames.rendered,total:update.frames.total}}),
        ...(update.source===undefined?{}:{source:sourceProgress(update.source)})};
      if(!validRecord(record)){disable();return;}
      pending=record;pump();
    },
    async flush(){while(!failed&&(writing||pending)){if(!writing)pump(true);await writing;}},
  };
}

type ProgressState='recorded'|'not-recorded'|'invalid'|'unsafe'|'unreadable';
/** Missing progress is valid for older compositions. Re-reading a record does not
 * refresh its recordedAt or establish that the worker still exists. */
export async function inspectRenderProgress(compositionDirectory:string,manifest:{status:string;stage?:string}){
  let state:ProgressState='not-recorded',record:RenderProgressRecord|null=null,handle;
  const directory=join(compositionDirectory,'render');
  try{
    const info=await lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(directory)!==directory)state='unsafe';
    else{
      handle=await open(join(directory,'progress.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const info=await handle.stat();
      if(!info.isFile())state='unsafe';
      else if(info.size>maximumBytes)state='invalid';
      else{
        // Bound the read itself as well as the stat, even if a foreign writer grows the file.
        const bytes=Buffer.alloc(maximumBytes+1),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
        const value:unknown=bytesRead<=maximumBytes?JSON.parse(bytes.subarray(0,bytesRead).toString('utf8')):null;
        if(validRecord(value)){
          record={schemaVersion:1,kind:'render-progress',recordedAt:value.recordedAt,phase:value.phase,
            ...(value.frames?{frames:{rendered:value.frames.rendered,total:value.frames.total}}:{}),...(value.source?{source:sourceProgress(value.source)}:{})};
          state='recorded';
        }else state='invalid';
      }
    }
  }catch(error){state=error instanceof SyntaxError?'invalid':(error as NodeJS.ErrnoException).code==='ENOENT'?'not-recorded':(error as NodeJS.ErrnoException).code==='ELOOP'?'unsafe':'unreadable';}
  finally{await handle?.close();}
  return {state,statusBasis:'last-recorded-render-progress' as const,processLiveness:'not-observed' as const,
    historical:manifest.status!=='running'||manifest.stage!=='rendering',record};
}
