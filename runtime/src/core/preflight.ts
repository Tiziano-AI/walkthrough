import {execFileSync} from 'node:child_process';
import {Failure,type LocalTools} from './contracts.ts';
import {localEnvironment,qualifiedNode} from './environment.ts';
import {resolveLocalTools} from './toolchain.ts';
import {verifyCaptureBrowserCustodyPatch} from '../capture/browser-custody.ts';
import {verifyProcessReader} from '../session/process.ts';
import {SessionError} from '../session/contracts.ts';

export const localTools:LocalTools=resolveLocalTools();
export async function inspectPrerequisites(input:{phase?:'capture'|'compose'|'all';signal?:AbortSignal}={}){
  const phase=input.phase??'all';
  if(!['capture','compose','all'].includes(phase))throw new Failure('INVALID_PHASE','input','Choose capture, compose or all.');
  const checks:Array<{name:string;ok:boolean;detail?:unknown;code?:string}>=[];
  if(phase!=='compose'){
    const check=async(name:string,fn:()=>unknown)=>{try{checks.push({name,ok:true,detail:await fn()});}catch(error){checks.push({name,ok:false,detail:{code:error instanceof Failure||error instanceof SessionError?error.code:'LOCAL_PREREQUISITE_UNAVAILABLE'}});}};
    await check('capture-tools',()=>{
      if(!qualifiedNode(process.version))throw new Error('unqualified Node');
      const version=(path:string,args:string[])=>execFileSync(path,args,{encoding:'utf8',timeout:10000,env:localEnvironment(),stdio:['ignore','pipe','pipe']}).split('\n')[0];
      const browser=version(localTools.browserPath,['--version']);if(!browser.includes('156.0.8078.4'))throw new Error('unqualified Chrome');
      return {node:process.version,browser,ffmpeg:version(localTools.ffmpegPath,['-version']),ffprobe:version(localTools.ffprobePath,['-version'])};
    });
    await check('capture-browser-custody',verifyCaptureBrowserCustodyPatch);
    await check('session-process-reader',verifyProcessReader);
  }
  if(phase!=='capture'){const {filmPreflight}=await import('./film.ts');const film=await filmPreflight({narration:true,signal:input.signal});checks.push(...film.checks);}
  return {schemaVersion:1,status:checks.every(c=>c.ok)?'provisioned':'not-ready',scope:'local-prerequisites',phase,tools:localTools,checks,appAccess:false,downloads:false,nextStep:checks.every(c=>c.ok)?'Open an explicitly authorized project session or compose retained sources.':'Resolve only the reported prerequisite; no target was opened.'};
}
