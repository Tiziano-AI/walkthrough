import {createRequire} from 'node:module';

const {lookup}=createRequire(import.meta.url)('mime-types') as {lookup(filename:string):string|false};
const genericMediaType='application/octet-stream';

/** Preserve explicit metadata; infer unknown types from the original filename,
 * never from the extensionless path used to retain an artifact. */
export function mediaTypeForFile(filename:string,retainedMediaType?:string):string{
  if(retainedMediaType&&retainedMediaType.toLowerCase()!==genericMediaType)return retainedMediaType;
  return lookup(filename)||genericMediaType;
}
