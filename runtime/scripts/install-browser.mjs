// Explicit dependency preparation only; production never imports this module.
import {resolve} from 'node:path';
import {Browser, install} from '@puppeteer/browsers';
import {browserQualification, verifyBrowserMetadata} from '../src/core/browser-qualification.ts';

if(process.argv.length!==3)throw new Error('Supply the product-owned browser directory.');
await verifyBrowserMetadata();
const browser=await install({browser:Browser.CHROME,buildId:browserQualification.version,cacheDir:resolve(process.argv[2])});
console.log(JSON.stringify({version:browserQualification.version,metadataSha256:browserQualification.metadataSha256,executable:browser.executablePath}));
