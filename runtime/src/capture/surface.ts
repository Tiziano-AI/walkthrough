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
  const html=document.documentElement,body=document.body;
  const geometry=()=>JSON.stringify([innerWidth,innerHeight,scrollX,scrollY,...[html,body].map(element=>{
    if(!element)return null;const box=element.getBoundingClientRect();
    return [box.x,box.y,box.width,box.height,element.clientWidth,element.clientHeight,element.scrollWidth,element.scrollHeight,element.scrollLeft,element.scrollTop];
  })]);
  const originalGeometry=geometry();
  const standard=getComputedStyle(html);
  const standardScrollbar=standard.scrollbarColor!=='auto'||standard.scrollbarWidth!=='auto';
  // A non-auto standard color suppresses legacy scrollbar dimensions. Keep
  // that existing mode; otherwise paint legacy parts without changing sizes.
  // Body can own Chromium's viewport scrollbar even in a standards document.
  const scrollbarPaint=document.createElement('style');
  const parts=['','-track','-track-piece','-thumb','-button','-corner'].map(part=>`:is(:root,:root>body)::-webkit-scrollbar${part}`).join(',');
  const saved=[html,...body?[body]:[]].map(element=>({element,attribute:element.getAttribute('style'),
    value:element.style.getPropertyValue('scrollbar-color'),priority:element.style.getPropertyPriority('scrollbar-color'),
    background:['background-color','background-image','background-position-x','background-position-y','background-size','background-repeat','background-attachment','background-origin','background-clip'].map(property=>({property,value:element.style.getPropertyValue(property),priority:element.style.getPropertyPriority(property)})),
    inherited:getComputedStyle(element).scrollbarColor,changed:false,owned:undefined as string|undefined,expected:undefined as string|null|undefined}));
  const backgroundOwned=new Map<string,{value:string;priority:string}>();
  const paintScrollbars=(value:string)=>{
    for(const item of saved)if(item.expected!==undefined&&item.element.getAttribute('style')!==item.expected){
      item.changed=true;
      // Repainting must not erase the app's newer restoration baseline. Keep
      // externally changed properties before replacing our temporary paint.
      if(item.owned!==undefined&&(item.element.style.getPropertyValue('scrollbar-color')!==item.owned||item.element.style.getPropertyPriority('scrollbar-color')!=='important')){
        item.value=item.element.style.getPropertyValue('scrollbar-color');
        item.priority=item.element.style.getPropertyPriority('scrollbar-color');
      }
      if(item.element===html)for(const previous of item.background){
        const owned=backgroundOwned.get(previous.property);
        if(owned&&(html.style.getPropertyValue(previous.property)!==owned.value||html.style.getPropertyPriority(previous.property)!==owned.priority)){
          previous.value=html.style.getPropertyValue(previous.property);
          previous.priority=html.style.getPropertyPriority(previous.property);
        }
      }
    }
    scrollbarPaint.textContent=`@layer{${parts}{background:${value}!important;background-clip:border-box!important;border-color:${value}!important;box-shadow:none!important;outline:none!important;filter:none!important;opacity:1!important}}`;
    // Reserved empty gutters are painted by the root canvas, not scrollbar
    // parts or the fixed popover. Paint that canvas without changing layout.
    html.style.setProperty('background',value,'important');
    for(const {property} of saved[0].background)backgroundOwned.set(property,{value:html.style.getPropertyValue(property),priority:html.style.getPropertyPriority(property)});
    if(standardScrollbar)for(const [index,item] of saved.entries()){
      // Preserve body's inherited color so nested custom scrollbar geometry
      // does not change when only the viewport receives the slate color.
      item.owned=index===0?`${value} ${value}`:item.inherited;
      item.element.style.setProperty('scrollbar-color',item.owned,'important');
      item.owned=item.element.style.getPropertyValue('scrollbar-color');
    }
    for(const item of saved)item.expected=item.element.getAttribute('style');
  };
  const restoreScrollbars=()=>{
    scrollbarPaint.remove();
    for(const item of saved){
      if(item.element!==html&&item.owned===undefined)continue;
      if(!item.changed&&item.element.getAttribute('style')===item.expected){
        if(item.attribute===null)item.element.removeAttribute('style');else item.element.setAttribute('style',item.attribute);
      }else{
        if(item.owned!==undefined&&item.element.style.getPropertyValue('scrollbar-color')===item.owned&&item.element.style.getPropertyPriority('scrollbar-color')==='important'){
          if(item.value)item.element.style.setProperty('scrollbar-color',item.value,item.priority);else item.element.style.removeProperty('scrollbar-color');
        }
        if(item.element===html)for(const previous of item.background){
          const owned=backgroundOwned.get(previous.property);
          if(owned&&html.style.getPropertyValue(previous.property)===owned.value&&html.style.getPropertyPriority(previous.property)===owned.priority){
            if(previous.value)html.style.setProperty(previous.property,previous.value,previous.priority);else html.style.removeProperty(previous.property);
          }
        }
      }
    }
  };
  const host=document.createElement('div');
  host.style.setProperty('display','contents','important');
  const root=host.attachShadow({mode:'closed'});
  const layer=document.createElement('div');
  layer.popover='manual';
  layer.style.cssText='all:initial!important;position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;box-sizing:border-box!important;background:#000!important;opacity:1!important;visibility:visible!important;transform:none!important;filter:none!important;animation:none!important;transition:none!important;pointer-events:auto!important;';
  root.append(layer);
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
  const remove=()=>{observer.disconnect();document.removeEventListener('beforetoggle',onToggle,true);host.remove();restoreScrollbars();};
  try{
    // The first anonymous important layer paints only scrollbar parts, leaving
    // application widths, overflow and scroll offsets under their own owner.
    html.prepend(scrollbarPaint);html.append(host);paintScrollbars('#000');layer.showPopover();
    // Stable gutters can offset the fixed containing block. Correct the cover,
    // not the application or its viewport, before any frame is recorded.
    const box=layer.getBoundingClientRect();layer.style.setProperty('transform',`translate(${-box.x}px,${-box.y}px)`,'important');
    if(geometry()!==originalGeometry)throw new Error('CAPTURE_SLATE_LAYOUT_CHANGED');
    document.addEventListener('beforetoggle',onToggle,true);
    observer.observe(html,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
    await paint();check();
  }catch(error){remove();throw error;}
  return {
    async color(value:string){
      check();const before=geometry();layer.style.setProperty('background',value,'important');paintScrollbars(value);
      if(geometry()!==before)throw new Error('CAPTURE_SLATE_LAYOUT_CHANGED');
      await paint();check();
    },
    remove,
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
