import type {Page} from 'playwright';
import {startRecording,type Recording} from './chromium.ts';

export type SlateCover={color(value:string):Promise<void>;remove():Promise<void>};

/** One observed 1600×900 CSS surface at device scale 2. The adapter preserves
 * its native raster; take analysis still verifies the recorded 3200×1800. */
export type CaptureSurface={
  cover():Promise<SlateCover>;
  startRecording(destination:string):Promise<Recording>;
  screenshot():Promise<Buffer>;
};

/** Runs in the captured document, with no caller closure. A scoped CDP adapter
 * can install the same slate and retain its remote object until removal.
 * The manual popover covers existing dialogs without taking focus; its closed
 * shadow tree excludes application styles and pseudo-elements. */
export async function installSlateCover(){
  const host=document.createElement('div');
  host.style.setProperty('display','contents','important');
  const root=host.attachShadow({mode:'closed'});
  const layer=document.createElement('div');
  layer.popover='manual';
  layer.style.cssText='all:initial!important;position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;box-sizing:border-box!important;background:#000!important;opacity:1!important;visibility:visible!important;transform:none!important;filter:none!important;animation:none!important;transition:none!important;pointer-events:auto!important;';
  root.append(layer);document.documentElement.append(host);
  const check=()=>{
    const box=layer.getBoundingClientRect();
    if(!host.isConnected||!layer.matches(':popover-open')||box.x!==0||box.y!==0||box.width<innerWidth||box.height<innerHeight)throw new Error('CAPTURE_SLATE_NOT_COVERING');
  };
  const paint=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  // A dialog/popover opened while covered must not overpaint the slate.
  // These synchronous top-layer changes settle before the next paint.
  const raise=()=>{if(host.isConnected){layer.hidePopover();layer.showPopover();}};
  const observer=new MutationObserver(raise);
  const onToggle=(event:Event)=>{if(event.target!==layer)queueMicrotask(raise);};
  document.addEventListener('beforetoggle',onToggle,true);
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
  try{layer.showPopover();await paint();check();}
  catch(error){observer.disconnect();document.removeEventListener('beforetoggle',onToggle,true);host.remove();throw error;}
  return {
    async color(value:string){check();layer.style.setProperty('background',value,'important');await paint();check();},
    remove(){observer.disconnect();document.removeEventListener('beforetoggle',onToggle,true);host.remove();},
  };
}

/** Existing Page callers keep their native screenshot and CDP behavior. */
export function pageCaptureSurface(page:Page):CaptureSurface{
  return {
    async cover(){
      const handle=await page.evaluateHandle(installSlateCover);
      let removed=false;
      return {
        color:(value:string)=>handle.evaluate((overlay,value)=>overlay.color(value),value),
        async remove(){if(removed)return;removed=true;try{await handle.evaluate(overlay=>overlay.remove());}finally{await handle.dispose();}},
      };
    },
    startRecording:destination=>startRecording(page,destination),
    screenshot:()=>page.screenshot({animations:'allow',caret:'initial',scale:'device'}),
  };
}

export function asCaptureSurface(source:Page|CaptureSurface):CaptureSurface{
  return 'cover'in source?source:pageCaptureSurface(source);
}
