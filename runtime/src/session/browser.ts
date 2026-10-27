import {chromium} from 'playwright';
import {qualifiedBrowserPath} from '../core/environment.ts';
import {enableCaptureBrowserGroupCustody,verifyCaptureBrowserCustodyPatch} from '../capture/browser-custody.ts';

/** One fixed browser launch seam for persistent authoring and custody tests.
 * Navigation/file authority is enforced by SessionRuntime; ordinary web
 * subresource traffic is native rather than replayed through a second client. */
export async function openSessionBrowser(input:{profileDirectory:string;executablePath?:string;headless?:boolean;network:'web'|'loopback-only'}){
  if(process.env.WALKTHROUGH_STAGE_CUSTODY==='fd3-v1')await enableCaptureBrowserGroupCustody();
  else await verifyCaptureBrowserCustodyPatch();
  if(process.env.WALKTHROUGH_SESSION_WORKER==='1')process.env.WALKTHROUGH_CAPTURE_GROUP_PID=String(process.pid);
  return chromium.launchPersistentContext(input.profileDirectory,{
    // Preserve the launcher-owned Seatbelt boundary. Enabling Chromium's own
    // sandbox broke initialization inside the qualified outer loopback profile.
    // Playwright's default leaves that separate Chromium sandbox disabled.
    executablePath:input.executablePath??qualifiedBrowserPath(),headless:input.headless??false,
    // Native filesystem pickers abort in qualified headless Chromium and are
    // outside session input in headed mode. Advertise that capability honestly
    // so applications can select their own download/file-input paths. Disable
    // only local filesystem access: origin-private storage (OPFS) stays native.
    args:['--screen-info={3200x1800 devicePixelRatio=2}','--disable-blink-features=FileSystemAccessLocal'],viewport:{width:1600,height:900},deviceScaleFactor:2,
    locale:'en-GB',timezoneId:'UTC',acceptDownloads:true,serviceWorkers:input.network==='loopback-only'?'block':'allow',
  });
}
