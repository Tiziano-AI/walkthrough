import React from "react";
import { AbsoluteFill, Audio, Composition, Freeze, OffthreadVideo, Sequence, registerRoot, staticFile, useCurrentFrame, type AnyZodObject } from "remotion";
import { OUTPUT_HEIGHT, OUTPUT_WIDTH, frameState, secondsToFrames, validateTimeline, type Timeline } from "./timeline.ts";
import { EMPHASIS_BACKING_WIDTH, EMPHASIS_STROKE_WIDTH, SPOTLIGHT_DIM_OPACITY, emphasisAtFrame } from './emphasis.ts';
import { captionOverlayAtFrame, CAPTION_FONT_FAMILY, CAPTION_FONT_SIZE, CAPTION_LINE_HEIGHT, CAPTION_PADDING_X, CAPTION_PADDING_Y } from './captions.ts';
import { renderPictures, stagedSourceFrame, type RenderFrameRange, type RenderSourceFile } from './source-plan.ts';

export type CompositionProps = { presentation: 'full-frame-visible-captions'; timeline: Timeline; sourceFiles: Record<string, RenderSourceFile>; audioFiles: Record<string, string>; frameRange?: RenderFrameRange };
const h = React.createElement;

export function Walkthrough(props: CompositionProps) {
  return h(WalkthroughFrame, { ...props, frame: useCurrentFrame() });
}

/** Full-frame product footage with restrained, phrase-sized visible captions. */
export function WalkthroughFrame(props: CompositionProps & { frame: number }) {
  const state = frameState(props.timeline, props.frame);
  const transform = state.transform;
  const layers: React.ReactNode[] = renderPictures(props.timeline, props.frameRange).map(({ segment, outputStartFrame, durationInFrames, sourceStartFrame }) => {
    const source = props.sourceFiles[segment.sourceId];
    const trimBefore = stagedSourceFrame(source.windows, sourceStartFrame, segment.kind === 'hold' ? 1 : durationInFrames);
    const video = h(OffthreadVideo, { src: staticFile(source.file), trimBefore, muted: true,
      style: { position: "absolute", left: transform.x, top: transform.y, width: props.timeline.sourceWidth * transform.scale, height: props.timeline.sourceHeight * transform.scale, maxWidth: "none" } });
    return h(Sequence, { key: segment.id, from: outputStartFrame, durationInFrames, layout: "none" },
      segment.kind === "hold" ? h(Freeze, { frame: 0, children: video }) : video);
  });
  for (const narration of props.timeline.narration) layers.push(h(Sequence, { key: `audio-${narration.id}`, from: secondsToFrames(narration.outputStartSeconds), durationInFrames: secondsToFrames(narration.durationSeconds), layout: "none" },
    h(Audio, { src: staticFile(props.audioFiles[narration.id]) })));
  // Editorial attention sits above footage but below real pointer feedback and
  // captions. It never changes the recorded application or tracks an object.
  for (const emphasis of state.segment.emphasis ?? []) {
    const active=emphasisAtFrame(emphasis,state.localFrame,transform);
    if(!active)continue;
    const {box,opacity}=active,shapes:React.ReactNode[]=[];
    if(active.kind==='spotlight')shapes.push(h('path',{key:'dim','data-emphasis-dim':active.id,
      d:`M0 0H${OUTPUT_WIDTH}V${OUTPUT_HEIGHT}H0Z M${box.x} ${box.y}H${box.x+box.width}V${box.y+box.height}H${box.x}Z`,
      fill:'#000',fillRule:'evenodd',opacity:SPOTLIGHT_DIM_OPACITY}));
    for(const [key,stroke,strokeWidth] of [['backing','#102c4a',EMPHASIS_BACKING_WIDTH],['outline','#ffd58a',EMPHASIS_STROKE_WIDTH]] as const)
      shapes.push(h('rect',{key,'data-emphasis-stroke':key,x:box.x,y:box.y,width:box.width,height:box.height,fill:'none',stroke,strokeWidth,strokeLinejoin:'round'}));
    layers.push(h('svg',{key:`emphasis-${active.id}`,'data-emphasis-id':active.id,'data-emphasis-kind':active.kind,width:OUTPUT_WIDTH,height:OUTPUT_HEIGHT,
      viewBox:`0 0 ${OUTPUT_WIDTH} ${OUTPUT_HEIGHT}`,style:{position:'absolute',left:0,top:0,opacity,pointerEvents:'none'}},...shapes));
  }
  if (state.cursor) {
    if (state.cursor.pulse > 0) layers.push(h("div", { key: "pulse", style: { position: "absolute", left: state.cursor.haloX - 32, top: state.cursor.haloY - 32, width: 64, height: 64, boxSizing: "border-box", borderRadius: "50%", border: "4px solid #53beff", background: "#168be233", opacity: state.cursor.pulse } }));
    layers.push(h("svg", { key: "cursor", width: 36, height: 36, viewBox: "0 0 36 36", style: { position: "absolute", left: state.cursor.x, top: state.cursor.y, overflow: "visible", filter: "drop-shadow(0 2px 2px #0008)" } },
      h("path", { d: "M1 1 L1 29 L9 22 L16 35 L22 32 L15 19 L27 18 Z", fill: "#fff", stroke: "#102c4a", strokeWidth: 2, strokeLinejoin: "round" })));
  }
  const caption = captionOverlayAtFrame(props.timeline, props.frame);
  for (const [index, line] of (caption?.lines ?? []).entries()) layers.push(h('div', {
    key: `caption-${index}`, 'data-caption-line': index,
    style: {
      position: 'absolute', left: line.box.x, top: line.box.y, width: line.box.width, height: line.box.height,
      boxSizing: 'border-box', padding: `${CAPTION_PADDING_Y}px ${CAPTION_PADDING_X}px`, overflow: 'hidden',
      backgroundColor: 'rgba(0,0,0,0.68)', borderRadius: 5, color: '#fff', fontFamily: CAPTION_FONT_FAMILY,
      fontSize: CAPTION_FONT_SIZE, fontWeight: 400, lineHeight: `${CAPTION_LINE_HEIGHT}px`, fontKerning: 'none',
      fontVariantLigatures: 'none', textAlign: 'center', whiteSpace: 'pre', pointerEvents: 'none',
    },
  }, line.text));
  return h(AbsoluteFill, { style: { backgroundColor: "#000", overflow: "hidden" } }, ...layers);
}

registerRoot(() => h(Composition<AnyZodObject, CompositionProps>, { id: "Walkthrough", component: Walkthrough, fps: 60, width: 1920, height: 1080, durationInFrames: 60,
  defaultProps: { presentation: 'full-frame-visible-captions', timeline: { sourceWidth: 3200, sourceHeight: 1800, sources: {}, segments: [], narration: [] }, sourceFiles: {}, audioFiles: {} },
  calculateMetadata: ({ props }) => ({ durationInFrames: validateTimeline(props.timeline).durationInFrames }) }));
