import {createHash} from 'node:crypto';
import {readFile, lstat, realpath, open, rename} from 'node:fs/promises';
import {resolve, sep, isAbsolute} from 'node:path';
import {Failure} from './contracts.ts';

export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export const fileDigest = async (path: string) => sha256(await readFile(path));
export async function assertPrivateFile(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Failure('UNTRUSTED_POLICY_FILE', 'authority', 'Provision the operator-owned policy as a private regular file (0600).');
  if (await realpath(path) !== resolve(path)) throw new Failure('POLICY_SYMLINK_REJECTED', 'authority', 'Use a literal policy path.');
}
export function within(root: string, target: string) {
  return isAbsolute(target) && resolve(target).startsWith(resolve(root) + sep);
}
export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.tmp`;
  const file=await open(temporary,'w',0o600);
  try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
  await rename(temporary,path);
}
