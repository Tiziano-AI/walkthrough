import {homedir} from 'node:os';
import {dirname} from 'node:path';
import {resolveLocalTools} from './toolchain.ts';

/** Deliberate allowlist, not a filtered copy of the caller's credentials. */
export function localEnvironment():NodeJS.ProcessEnv {
  const tools=resolveLocalTools();
  return {HOME:homedir(),PATH:[...new Set([dirname(process.execPath),dirname(tools.ffmpegPath),dirname(tools.ffprobePath),'/usr/bin','/bin','/usr/sbin','/sbin'])].join(':'),LANG:'en_US.UTF-8',TZ:'UTC',DO_NOT_TRACK:'1',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'1',CI:'1'};
}

/** The operator-selected Node is checked against this qualified version line. */
export const qualifiedNodePath=()=>resolveLocalTools().nodePath;
export function qualifiedNode(version:string):boolean {const m=/^v24\.(\d+)\.(\d+)$/.exec(version.trim());return m!==null&&(Number(m[1])>22||Number(m[1])===22&&Number(m[2])>=1);}

/** Product-owned installed browser, or an explicit operator selection. No download. */
export const qualifiedBrowserPath=()=>resolveLocalTools().browserPath;
