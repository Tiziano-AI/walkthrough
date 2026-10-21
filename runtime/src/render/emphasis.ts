import {OUTPUT_FPS,secondsToFrames,type Box,type FramingTransform,type RenderEmphasis} from './timeline.ts';

export const EMPHASIS_STROKE_WIDTH = 3;
export const EMPHASIS_BACKING_WIDTH = 5;
export const SPOTLIGHT_DIM_OPACITY = 0.28;
const FADE_FRAMES = Math.round(0.2 * OUTPUT_FPS);
const smooth=(value:number)=>value*value*value*(value*(value*6-15)+10);

/** The camera projects the retained subject; stroke and fade stay in output space. */
export function emphasisAtFrame(emphasis:RenderEmphasis,localFrame:number,transform:FramingTransform):{id:string;kind:RenderEmphasis['kind'];box:Box;opacity:number}|null {
  const start=secondsToFrames(emphasis.startSeconds),end=secondsToFrames(emphasis.endSeconds);
  if(localFrame<start||localFrame>=end)return null;
  const fade=Math.min(FADE_FRAMES,(end-start)/2);
  // Sample at the frame center, so even an admitted one-frame interval has a
  // visible treatment rather than entering and exiting without ever appearing.
  const progress=Math.min(1,(localFrame-start+0.5)/fade,(end-localFrame-0.5)/fade);
  return {id:emphasis.id,kind:emphasis.kind,opacity:smooth(progress),box:{
    x:emphasis.target.x*transform.scale+transform.x,y:emphasis.target.y*transform.scale+transform.y,
    width:emphasis.target.width*transform.scale,height:emphasis.target.height*transform.scale,
  }};
}
