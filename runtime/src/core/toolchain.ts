import {accessSync,constants,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {delimiter,isAbsolute,join,resolve} from 'node:path';
import {Failure,type LocalTools} from './contracts.ts';
import {runtimePaths} from './runtime-paths.ts';

export type ToolchainSelection={schemaVersion:1;tools:LocalTools};
export const toolchainSelectionPath=()=>join(runtimePaths().configRoot,'toolchain.json');

function selection(path:string):ToolchainSelection|null {
  let data:unknown;
  try{data=JSON.parse(readFileSync(path,'utf8'));}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
    throw new Failure('TOOLCHAIN_SELECTION_INVALID','setup',`Inspect setup and prepare a verified candidate to replace the unreadable selection at ${path}. No tool was launched.`);
  }
  const value=data as ToolchainSelection;
  if(!value||value.schemaVersion!==1||!value.tools||Object.keys(value.tools).sort().join(',')!=='browserPath,ffmpegPath,ffprobePath,nodePath'||
    !Object.values(value.tools).every(path=>typeof path==='string'&&isAbsolute(path)&&resolve(path)===path))
    throw new Failure('TOOLCHAIN_SELECTION_INVALID','setup',`Run setup inspect and select a verified candidate. Tool paths in ${path} must be absolute and normalized.`);
  return value;
}

/** Reads operator selection without changing it or probing shared installations. */
export function readToolchainSelection():ToolchainSelection|null {return selection(toolchainSelectionPath());}

function onPath(name:string):string {
  for(const directory of (process.env.PATH??'').split(delimiter)){
    if(!isAbsolute(directory))continue;
    const path=resolve(directory,name);
    try{accessSync(path,constants.X_OK);return path;}catch{/* Discovery does not install a missing prerequisite. */}
  }
  // A concrete missing path keeps doctor useful without selecting another tool.
  return join('/usr/bin',name);
}

/** Discovery is a setup candidate, not silent acceptance of changed identities. */
export function discoverLocalTools():LocalTools {
  return {nodePath:process.execPath,
    browserPath:join(homedir(),'.local/share/walkthrough/browsers/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    ffmpegPath:onPath('ffmpeg'),ffprobePath:onPath('ffprobe')};
}

/** Installed paths are receipt-owned; an explicit setup selection takes precedence. */
export function resolveLocalTools():LocalTools {
  return (readToolchainSelection()??selection(join(runtimePaths().runtimeRoot,'runtime-tools.json')))?.tools??discoverLocalTools();
}
