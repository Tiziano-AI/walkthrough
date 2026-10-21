export const OUTPUT_FPS = 60;
export const OUTPUT_WIDTH = 1920;
export const OUTPUT_HEIGHT = 1080;
/** Two subtitle lines plus their padding, in final output pixels. */
export const CAPTION_STRIP_HEIGHT = 96;
export const DEFAULT_CAPTION_PLACEMENT: Readonly<CaptionPlacement> = Object.freeze({ x: 360, y: 948, width: 1200 });

export interface Box { x: number; y: number; width: number; height: number }
export interface CameraMove { startSeconds: number; durationSeconds: number; zoom: number; target: Box | null }
/** A fixed source-space subject, active on the picture-local clock. */
export interface RenderEmphasis { id: string; kind: 'outline' | 'spotlight'; target: Box; startSeconds: number; endSeconds: number }
/** Top-left and width of the subtitle text strip, never source coordinates. */
export interface CaptionPlacement { x: number; y: number; width: number }
export interface FramingTransform { scale: number; x: number; y: number }
export interface RenderAction { timeSeconds: number; target: Box; kind: "click" | "input" | "select"; consequence?: Box; settledSeconds?: number }
export interface RenderCaption { text: string; startSeconds: number; endSeconds: number }
export interface RenderNarration { id: string; outputStartSeconds: number; durationSeconds: number; wavPath?: string; captions: RenderCaption[] }
/** Actual dispatched pointer samples, in source pixels and the capture's clock. */
export interface PointerSample { timeSeconds: number; x: number; y: number; type: "move" | "down" | "up"; gesture?: "drag" }
export interface RenderSegment {
  id: string;
  sourceId: string;
  kind: "live" | "hold";
  transition: "cut" | "continuous";
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  outputStartSeconds: number;
  durationSeconds: number;
  zoom: number;
  target: Box | null;
  cameraMove?: CameraMove;
  emphasis?: RenderEmphasis[];
  captionPlacement?: CaptionPlacement;
  actions?: RenderAction[];
}
export interface Timeline {
  sourceWidth: number;
  sourceHeight: number;
  sources: Record<string, { pointer: PointerSample[] }>;
  segments: RenderSegment[];
  narration: RenderNarration[];
}

/** Preserve the responsible emphasis identity across authoring and render validation. */
export class TimelineEmphasisFailure extends Error {
  segmentId: string;
  emphasisId?: string;
  localFrame?: number;
  constructor(code: string, segmentId: string, emphasisId?: string, localFrame?: number) {
    super(code); this.segmentId = segmentId; this.emphasisId = emphasisId; this.localFrame = localFrame;
  }
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
export const secondsToFrames = (seconds: number) => Math.round(seconds * OUTPUT_FPS);
export const isFrameAligned = (seconds: number) => Number.isFinite(seconds) && Math.abs(secondsToFrames(seconds) - seconds * OUTPUT_FPS) <= 0.000001;
const isBox = (value: unknown): value is Box => !!value && typeof value === 'object' &&
  ["x", "y", "width", "height"].every(key => Number.isFinite((value as Record<string,unknown>)[key])) && (value as Box).width > 0 && (value as Box).height > 0;
export const isCameraMove = (value: unknown, clipDurationSeconds: number): value is CameraMove => {
  if (!value || typeof value !== 'object') return false;
  const move = value as CameraMove;
  return [move.startSeconds,move.durationSeconds,move.zoom].every(Number.isFinite) && move.startSeconds >= 0 && move.durationSeconds > 0 &&
    move.startSeconds + move.durationSeconds <= clipDurationSeconds + 1e-9 && move.zoom >= 1 && move.zoom <= 1.5 && (move.target === null || isBox(move.target));
};
export const isCaptionPlacement = (value: unknown): value is CaptionPlacement => {
  if (!value || typeof value !== 'object') return false;
  const placement = value as CaptionPlacement;
  return [placement.x,placement.y,placement.width].every(Number.isFinite) && placement.x >= 0 && placement.y >= 0 && placement.width > 0 &&
    placement.width <= OUTPUT_WIDTH && placement.x + placement.width <= OUTPUT_WIDTH && placement.y + CAPTION_STRIP_HEIGHT <= OUTPUT_HEIGHT;
};

/** Framing is editorial, never inferred from live action or pointer positions. */
function camera(timeline: Timeline, framing: Pick<RenderSegment, 'zoom' | 'target'>): FramingTransform {
  // Product footage owns the entire frame. Only an explicit detail zoom crops
  // the source; captions never reserve a separate output rail.
  const scale = Math.min(OUTPUT_WIDTH / timeline.sourceWidth, OUTPUT_HEIGHT / timeline.sourceHeight) * framing.zoom;
  const target = framing.target;
  const centerX = target ? target.x + target.width / 2 : timeline.sourceWidth / 2;
  const centerY = target ? target.y + target.height / 2 : timeline.sourceHeight / 2;
  const width = timeline.sourceWidth * scale;
  const height = timeline.sourceHeight * scale;
  return {
    scale,
    x: width <= OUTPUT_WIDTH ? (OUTPUT_WIDTH - width) / 2 : clamp(OUTPUT_WIDTH / 2 - centerX * scale, OUTPUT_WIDTH - width, 0),
    y: height <= OUTPUT_HEIGHT ? (OUTPUT_HEIGHT - height) / 2 : clamp(OUTPUT_HEIGHT / 2 - centerY * scale, OUTPUT_HEIGHT - height, 0)
  };
}

export function segmentTransform(timeline: Timeline, index: number, localFrame = 0): FramingTransform {
  const segment = timeline.segments[index];
  const start = camera(timeline,segment), move = segment.cameraMove;
  if (!move || localFrame <= secondsToFrames(move.startSeconds)) return start;
  const end = camera(timeline,move);
  const progress = clamp((localFrame - secondsToFrames(move.startSeconds)) / secondsToFrames(move.durationSeconds),0,1);
  if (progress === 1) return end;
  // Quintic smoothstep has zero velocity and acceleration at both resting
  // frames. A convex interpolation of clamped affine framing preserves source
  // coverage throughout, including pans between opposite source edges.
  const eased = progress * progress * progress * (progress * (progress * 6 - 15) + 10);
  return { scale: start.scale + (end.scale - start.scale) * eased, x: start.x + (end.x - start.x) * eased, y: start.y + (end.y - start.y) * eased };
}

export function validateTimeline(timeline: Timeline) {
  if (![timeline.sourceWidth,timeline.sourceHeight].every(Number.isFinite) || timeline.sourceWidth < 2880 || timeline.sourceHeight < 1620 || Math.abs(timeline.sourceWidth / timeline.sourceHeight - 16 / 9) > 0.001) throw new Error("render:insufficient_or_invalid_source_geometry");
  if (!timeline.segments.length) throw new Error("render:empty_timeline");
  if (!timeline.sources || !Object.keys(timeline.sources).length) throw new Error("render:missing_sources");
  for (const source of Object.values(timeline.sources)) {
    if (!Array.isArray(source.pointer)) throw new Error("render:invalid_pointer_samples");
    let previous = -Infinity;
    for (const sample of source.pointer) {
      if (![sample.timeSeconds,sample.x,sample.y].every(Number.isFinite) || sample.timeSeconds < 0 || sample.timeSeconds < previous || sample.x < 0 || sample.y < 0 || sample.x > timeline.sourceWidth || sample.y > timeline.sourceHeight || !["move","down","up"].includes(sample.type)) throw new Error("render:invalid_pointer_samples");
      if (sample.gesture !== undefined && sample.gesture !== "drag") throw new Error("render:invalid_pointer_gesture");
      previous = sample.timeSeconds;
    }
  }
  const ids = new Set<string>();
  let next = 0;
  for (const [index,segment] of timeline.segments.entries()) {
    const numbers = [segment.sourceStartSeconds, segment.sourceEndSeconds, segment.outputStartSeconds, segment.durationSeconds, segment.zoom];
    if (!numbers.every(Number.isFinite) || !segment.id || ids.has(segment.id) || segment.sourceStartSeconds < 0 || secondsToFrames(segment.durationSeconds) <= 0 || segment.zoom < 1 || segment.zoom > 1.5 || !["live","hold"].includes(segment.kind) || !["cut","continuous"].includes(segment.transition)) throw new Error("render:invalid_segment");
    if (![segment.sourceStartSeconds,segment.sourceEndSeconds,segment.outputStartSeconds,segment.durationSeconds].every(isFrameAligned)) throw new Error("render:time_not_frame_aligned");
    if (segment.cameraMove !== undefined) {
      if (!isCameraMove(segment.cameraMove,segment.durationSeconds)) throw new Error("render:invalid_camera_move");
      if (![segment.cameraMove.startSeconds,segment.cameraMove.durationSeconds].every(isFrameAligned)) throw new Error("render:camera_move_not_frame_aligned");
    }
    if (segment.captionPlacement !== undefined && !isCaptionPlacement(segment.captionPlacement)) throw new Error("render:invalid_caption_placement");
    if (!Object.hasOwn(timeline.sources,segment.sourceId)) throw new Error("render:unknown_source");
    ids.add(segment.id);
    if (secondsToFrames(segment.outputStartSeconds) !== next) throw new Error("render:noncontiguous_segments");
    const sourceFrames = secondsToFrames(segment.sourceEndSeconds) - secondsToFrames(segment.sourceStartSeconds);
    if (segment.kind === "live" && (sourceFrames <= 0 || secondsToFrames(segment.durationSeconds) !== sourceFrames)) throw new Error("render:live_time_scaling_or_padding_forbidden");
    if (segment.kind === "hold" && segment.sourceEndSeconds !== segment.sourceStartSeconds) throw new Error("render:hold_requires_single_frame");
    if (segment.transition === "continuous") {
      const prior = timeline.segments[index - 1];
      if (!prior || prior.sourceId !== segment.sourceId || secondsToFrames(prior.sourceEndSeconds) !== secondsToFrames(segment.sourceStartSeconds)) throw new Error("render:discontinuous_source_requires_cut");
      const ending = segmentTransform(timeline,index-1,secondsToFrames(prior.durationSeconds)), starting = segmentTransform(timeline,index);
      if (Math.abs(ending.scale-starting.scale)>1e-9 || Math.abs(ending.x-starting.x)>1e-6 || Math.abs(ending.y-starting.y)>1e-6) throw new Error("render:continuous_framing_change_forbidden");
    }
    const validateTarget = (box: Box | null, localFrame: number) => {
      if (box === null) return;
      if (!isBox(box) || box.x < 0 || box.y < 0 || box.x + box.width > timeline.sourceWidth + 1 || box.y + box.height > timeline.sourceHeight + 1) throw new Error("render:target_outside_source");
      const transform = segmentTransform(timeline,index,localFrame);
      if (box.x * transform.scale + transform.x < -1 || (box.x + box.width) * transform.scale + transform.x > OUTPUT_WIDTH + 1 || box.y * transform.scale + transform.y < -1 || (box.y + box.height) * transform.scale + transform.y > OUTPUT_HEIGHT + 1) throw new Error("render:target_hidden_by_framing");
    };
    validateTarget(segment.target,0);
    if (segment.cameraMove) validateTarget(segment.cameraMove.target,secondsToFrames(segment.cameraMove.startSeconds)+secondsToFrames(segment.cameraMove.durationSeconds));
    if (segment.emphasis !== undefined) {
      if (!Array.isArray(segment.emphasis)) throw new TimelineEmphasisFailure('render:invalid_emphasis',segment.id);
      const emphasisIds = new Set<string>();
      const spotlights: RenderEmphasis[] = [];
      for (const emphasis of segment.emphasis) {
        if (!emphasis || typeof emphasis !== 'object' || Array.isArray(emphasis) ||
          Object.keys(emphasis).some(key => !['id','kind','target','startSeconds','endSeconds'].includes(key)) ||
          typeof emphasis.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(emphasis.id) || emphasisIds.has(emphasis.id) ||
          !['outline','spotlight'].includes(emphasis.kind) || !isBox(emphasis.target) ||
          Object.keys(emphasis.target).some(key => !['x','y','width','height'].includes(key)) ||
          ![emphasis.startSeconds,emphasis.endSeconds].every(isFrameAligned) ||
          emphasis.startSeconds < 0 || emphasis.endSeconds <= emphasis.startSeconds || emphasis.endSeconds > segment.durationSeconds + 1e-9 ||
          ![emphasis.startSeconds,emphasis.endSeconds].every(seconds => Number.isSafeInteger(secondsToFrames(seconds)))) {
          throw new TimelineEmphasisFailure('render:invalid_emphasis',segment.id,typeof emphasis?.id === 'string' ? emphasis.id : undefined);
        }
        emphasisIds.add(emphasis.id);
        if (emphasis.kind === 'spotlight') {
          if (spotlights.some(other => emphasis.startSeconds < other.endSeconds && other.startSeconds < emphasis.endSeconds))
            throw new TimelineEmphasisFailure('render:overlapping_spotlights',segment.id,emphasis.id);
          spotlights.push(emphasis);
        }
        // Every displayed active frame uses the same transform as footage and
        // pointer. Checking only camera endpoints misses clipped intermediate subjects.
        const from = secondsToFrames(emphasis.startSeconds), to = secondsToFrames(emphasis.endSeconds);
        for (let localFrame = from; localFrame < to;) {
          try { validateTarget(emphasis.target,localFrame); }
          catch (error) {
            if (!(error instanceof Error) || !['render:target_outside_source','render:target_hidden_by_framing'].includes(error.message)) throw error;
            throw new TimelineEmphasisFailure(error.message === 'render:target_outside_source' ? 'render:emphasis_outside_source' : 'render:emphasis_hidden_by_framing',segment.id,emphasis.id,localFrame);
          }
          const move = segment.cameraMove, moveStart = move ? secondsToFrames(move.startSeconds) : 0, moveEnd = move ? moveStart + secondsToFrames(move.durationSeconds) : 0;
          if (!move || localFrame >= moveEnd) break;
          localFrame = localFrame < moveStart ? moveStart : localFrame + 1;
        }
      }
    }
    for (const action of segment.actions || []) {
      if (!Number.isFinite(action.timeSeconds) || action.timeSeconds < 0 || action.timeSeconds > segment.durationSeconds) throw new Error("render:invalid_action_time");
      if (action.consequence && (!Number.isFinite(action.settledSeconds) || action.settledSeconds! < action.timeSeconds || action.settledSeconds! > segment.durationSeconds)) throw new Error("render:invalid_consequence_time");
      if (action.settledSeconds !== undefined && !action.consequence) throw new Error("render:consequence_missing");
      validateTarget(action.target,action.timeSeconds*OUTPUT_FPS);
      if (action.consequence) validateTarget(action.consequence,action.settledSeconds!*OUTPUT_FPS);
    }
    next += secondsToFrames(segment.durationSeconds);
  }
  let narrationEnd = 0;
  const narrationIds = new Set<string>();
  for (const narration of timeline.narration) {
    if (!narration.id || narrationIds.has(narration.id) || ![narration.outputStartSeconds,narration.durationSeconds].every(Number.isFinite) || secondsToFrames(narration.outputStartSeconds) < narrationEnd || secondsToFrames(narration.durationSeconds) <= 0) throw new Error("render:invalid_narration");
    narrationIds.add(narration.id);
    narrationEnd = secondsToFrames(narration.outputStartSeconds) + secondsToFrames(narration.durationSeconds);
    if (narrationEnd > next) throw new Error("render:narration_exceeds_timeline");
    let captionEnd = 0;
    for (const caption of narration.captions) {
      if (![caption.startSeconds,caption.endSeconds].every(Number.isFinite) || !caption.text.trim() || caption.startSeconds < captionEnd || caption.endSeconds <= caption.startSeconds || caption.endSeconds > narration.durationSeconds + 1 / OUTPUT_FPS || caption.text.split("\n").length > 2 || caption.text.split("\n").some(line => !line.trim() || [...line].length > 76)) throw new Error("render:invalid_caption");
      captionEnd = caption.endSeconds;
    }
  }
  return { durationInFrames: next, fps: OUTPUT_FPS, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT };
}

export function frameState(timeline: Timeline, frame: number) {
  const index = timeline.segments.findIndex((segment) => frame >= secondsToFrames(segment.outputStartSeconds) && frame < secondsToFrames(segment.outputStartSeconds) + secondsToFrames(segment.durationSeconds));
  if (index < 0) throw new Error("render:frame_outside_timeline");
  const segment = timeline.segments[index];
  const localFrame = frame - secondsToFrames(segment.outputStartSeconds);
  const seconds = localFrame / OUTPUT_FPS;
  const sourceFrame = secondsToFrames(segment.sourceStartSeconds) + (segment.kind === "live" ? localFrame : 0);
  const sourceSeconds = sourceFrame / OUTPUT_FPS;
  const transform = segmentTransform(timeline,index,localFrame);
  const samples = timeline.sources[segment.sourceId].pointer;
  // Step through observed positions; never invent a trajectory or anticipate down.
  const sample = samples.findLast(item => item.timeSeconds <= sourceSeconds);
  const down = samples.findLast(item => item.type === "down" && item.timeSeconds <= sourceSeconds);
  const release = down ? samples.find(item => item.type === "up" && item.timeSeconds >= down.timeSeconds) : undefined;
  const pressed = !!down && (!release || release.timeSeconds > sourceSeconds);
  // Classify retained gestures from their complete measured trajectory. The
  // feedback follows current observed positions, never a future sample.
  const dragging = !!down && (down.gesture === "drag" || samples.some(item => item.type === "move" && item.timeSeconds > down.timeSeconds &&
    (!release || item.timeSeconds < release.timeSeconds) && Math.hypot(item.x-down.x,item.y-down.y)>3));
  const pulse = segment.kind !== "live" ? 0 : dragging ? (pressed ? 0.8 : 0) : down ? clamp(1 - (sourceSeconds - down.timeSeconds) / 0.35,0,1) : 0;
  const halo = dragging && pressed ? sample : down;
  const cursor = sample ? { x: sample.x * transform.scale + transform.x, y: sample.y * transform.scale + transform.y, pulse, pressed, dragging: dragging && pressed,
    haloX: halo ? halo.x * transform.scale + transform.x : 0, haloY: halo ? halo.y * transform.scale + transform.y : 0 } : null;
  return { index, segment, localFrame, sourceFrame, seconds, transform, cursor, hold: segment.kind === "hold" };
}
