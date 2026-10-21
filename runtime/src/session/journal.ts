import {createHash,randomUUID} from 'node:crypto';
import {open,readFile,rename,mkdir,readdir,stat,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {ActionRecord,SessionInfo} from './contracts.ts';
import {SessionError} from './contracts.ts';

export const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(id);
export const timestamp=()=>new Date().toISOString();
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
}
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export async function privateDirectory(directory:string){
  if(resolve(directory)!==directory)throw new SessionError('SESSION_PATH_NOT_ABSOLUTE');
  await mkdir(directory,{recursive:true,mode:0o700});
  const info=await stat(directory);
  if(await realpath(directory)!==directory||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)throw new SessionError('SESSION_DIRECTORY_NOT_PRIVATE');
}
export async function writeJson(path:string,value:unknown){
  const temporary=`${path}.${randomUUID()}.tmp`;
  const file=await open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
  await rename(temporary,path);
  const parent=await open(resolve(path,'..'),'r');
  try{await parent.sync();}finally{await parent.close();}
}
export async function readJson<T>(path:string):Promise<T>{return JSON.parse(await readFile(path,'utf8')) as T;}
export const infoPath=(directory:string)=>join(directory,'session.json');
export const actionPath=(directory:string,id:string)=>{
  if(!validId(id))throw new SessionError('INVALID_ACTION_ID','Use a stable actionId containing letters, numbers, underscores, or hyphens.');
  return join(directory,'actions',`${id}.json`);
};
export async function readAction(directory:string,id:string):Promise<ActionRecord|undefined>{
  try{return await readJson<ActionRecord>(actionPath(directory,id));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
}
export async function saveInfo(info:SessionInfo){info.updatedAt=timestamp();await writeJson(infoPath(info.directory),info);}
export async function recoverInterruptedActions(directory:string){
  let names:string[];
  try{names=await readdir(join(directory,'actions'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  for(const name of names.filter(name=>name.endsWith('.json'))){
    const path=join(directory,'actions',name),record=await readJson<ActionRecord>(path);
    if(record.status==='not-dispatched'&&record.dispatchedAt){
      record.status='outcome-uncertain';record.updatedAt=timestamp();
      record.error={code:'SESSION_INTERRUPTED',message:'The worker stopped after dispatch admission. Inspect the product; do not replay this action under a new ID.'};
      await writeJson(path,record);
    }
  }
}
