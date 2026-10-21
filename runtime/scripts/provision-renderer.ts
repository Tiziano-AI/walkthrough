import {provisionBrowserCustodyPatch} from '../src/render/browser-custody.ts';
import {provisionCaptureBrowserCustodyPatch} from '../src/capture/browser-custody.ts';
import {provisionFrameTransportPatch} from '../src/render/frame-transport.ts';
import {provisionMemoryAdmissionPatch} from '../src/render/memory-admission.ts';

// Explicit local setup, not called by doctor, capture or compose. No downloads,
// license enrollment, npm hooks or changes to a shared runtime.
const browserCustody=await provisionBrowserCustodyPatch();
const captureBrowserCustody=await provisionCaptureBrowserCustodyPatch();
const frameTransport=await provisionFrameTransportPatch();
const memoryAdmission=await provisionMemoryAdmissionPatch();
console.log(JSON.stringify({status:'provisioned',downloads:false,browserCustody,captureBrowserCustody,frameTransport,memoryAdmission}));
