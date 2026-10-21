import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {validDeliveredArtifact,type DeliveredArtifact} from './deliverables.ts';

export const bundleFiles=['walkthrough.mp4','poster.png','captions.vtt','narration.txt','edit-plan.json','qa.json','provenance.json','review.html'] as const;
type FileState='present'|'missing'|'unreadable'|'unsafe';
type FileObservation={name:string;state:FileState;checksum:'match'|'mismatch'|'unverified'};
export type BundleObservation={
  observedAt:string;
  availability:'complete'|'partial'|'missing'|'not-produced';
  integrity:'verified'|'mismatch'|'unverified';
  checksums:'present'|'missing'|'unreadable'|'unsafe'|'invalid';
  files:FileObservation[];
  reviewPath:string|null;
  deliverables:Array<DeliveredArtifact&{path:string|null}>;
};
const failureState=(error:unknown):FileState => (error as NodeJS.ErrnoException).code==='ENOENT'?'missing':(error as NodeJS.ErrnoException).code==='ELOOP'?'unsafe':'unreadable';

/** Re-observe delivery files, never rewrite the recorded production outcome.
 * Named artifacts are admitted only through the bounded delivery manifest;
 * checksum keys alone cannot redirect reads. Bytes stay local. Hashes compare to a local record,
 * not a signature, semantic acceptance or a promise of future availability.
 */
export async function observeBundle(directory:string,status:string):Promise<BundleObservation>{
  let expected:Record<string,string>|undefined;
  let deliverables:DeliveredArtifact[]=[];
  let named=false;
  let checksums:BundleObservation['checksums']='missing';
  let directorySafe=false;
  try{const stat=await lstat(directory);directorySafe=stat.isDirectory()&&!stat.isSymbolicLink();}catch{}
  if(directorySafe){
    let handle;
    try{
      handle=await open(join(directory,'checksums.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=await handle.stat();
      if(!stat.isFile())checksums='unsafe';
      else if(stat.size>65536)checksums='invalid';
      else{
        const value:unknown=JSON.parse(await handle.readFile('utf8'));
        const digests=value as Record<string,string>;
        named=!!value&&typeof value==='object'&&Object.hasOwn(value,'deliverables.json');
        if(named){
          const metadata=await open(join(directory,'deliverables.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
          try{
            const stat=await metadata.stat();if(!stat.isFile()||stat.size>65536)throw Error('INVALID_DELIVERABLE_MANIFEST');
            const bytes=await metadata.readFile();
            if(createHash('sha256').update(bytes).digest('hex')!==digests['deliverables.json'])throw Error('INVALID_DELIVERABLE_MANIFEST');
            const manifest=JSON.parse(bytes.toString('utf8'));
            if(!manifest||manifest.schemaVersion!==1||!Array.isArray(manifest.artifacts)||manifest.artifacts.length>64||manifest.artifacts.some((artifact:unknown)=>!validDeliveredArtifact(artifact))||new Set(manifest.artifacts.map((artifact:DeliveredArtifact)=>artifact.name.toLowerCase())).size!==manifest.artifacts.length)throw Error('INVALID_DELIVERABLE_MANIFEST');
            deliverables=manifest.artifacts;
          }finally{await metadata.close();}
        }
        const allowed:readonly string[]=[...bundleFiles,...(named?['deliverables.json',...deliverables.map(artifact=>artifact.relativePath)]:[])];
        if(value&&typeof value==='object'&&!Array.isArray(value)&&bundleFiles.every(name=>Object.hasOwn(value,name))
          &&(!named||deliverables.every(artifact=>digests[artifact.relativePath]===artifact.sha256))
          &&Object.keys(value).every(name=>allowed.includes(name)&&typeof digests[name]==='string'&&/^[a-f0-9]{64}$/.test(digests[name]))){
          expected=value as Record<string,string>;checksums='present';
        }else checksums='invalid';
      }
    }catch(error){checksums=error instanceof SyntaxError||(error as Error).message==='INVALID_DELIVERABLE_MANIFEST'?'invalid':failureState(error) as Exclude<FileState,'present'>;deliverables=[];}
    finally{await handle?.close();}
  }else checksums='unsafe';
  const files:FileObservation[]=[];
  // Sequential streaming bounds memory even for a long high-bitrate video.
  for(const name of [...bundleFiles,...(expected&&named?['deliverables.json']:[]),...(expected?deliverables.map(artifact=>artifact.relativePath):[])]){
    let state:FileState='unsafe';let checksum:FileObservation['checksum']='unverified';let handle;
    if(directorySafe)try{
      if(name.startsWith('deliverables/')){
        const artifactDirectory=join(directory,'deliverables'),stat=await lstat(artifactDirectory);
        if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(artifactDirectory)!==join(await realpath(directory),'deliverables'))throw Object.assign(Error('UNSAFE_DELIVERABLE_DIRECTORY'),{code:'ELOOP'});
      }
      handle=await open(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const before=await handle.stat();
      if(before.isFile()){
        state='present';
        if(expected){
          const digest=createHash('sha256');
          for await(const chunk of handle.createReadStream({autoClose:false}))digest.update(chunk);
          const after=await handle.stat();
          const artifact=deliverables.find(artifact=>artifact.relativePath===name);
          checksum=before.size===after.size&&before.mtimeMs===after.mtimeMs&&(!named||!artifact||before.size===artifact.bytes)&&digest.digest('hex')===expected[name]?'match':'mismatch';
          if(!named&&artifact)artifact.bytes=before.size;
        }
      }
    }catch(error){state=failureState(error);}
    finally{await handle?.close();}
    files.push({name,state,checksum});
  }
  const present=files.filter(file=>file.state==='present').length;
  const availability=present===files.length?'complete':present>0?'partial':status==='awaiting-human-review'?'missing':'not-produced';
  const integrity=files.some(file=>file.checksum==='mismatch')?'mismatch':checksums==='present'&&files.every(file=>file.checksum==='match')?'verified':'unverified';
  const ready=status==='awaiting-human-review'&&availability==='complete'&&integrity==='verified';
  return {observedAt:new Date().toISOString(),availability,integrity,checksums,files,reviewPath:ready?join(directory,'review.html'):null,deliverables:deliverables.map(artifact=>({...artifact,path:ready?join(directory,artifact.relativePath):null}))};
}
