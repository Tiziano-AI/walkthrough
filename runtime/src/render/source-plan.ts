import { secondsToFrames, type Timeline } from "./timeline.ts";

/** Inclusive absolute composition frames; the original timeline is never cut. */
export type RenderFrameRange = [number, number];
export interface SourceFrameWindow { sourceStartFrame: number; frameCount: number }
export interface PackedSourceWindow extends SourceFrameWindow { stagedStartFrame: number }
export interface RenderSourcePlan { windows: PackedSourceWindow[]; frameCount: number }
export interface RenderSourceFile { file: string; windows: PackedSourceWindow[] }

/** Intersect pictures before deriving media trims, including mid-picture previews. */
export function renderPictures(timeline: Timeline, frameRange?: RenderFrameRange) {
  return timeline.segments.flatMap(segment => {
    const segmentStart = secondsToFrames(segment.outputStartSeconds);
    const outputStartFrame = Math.max(segmentStart, frameRange?.[0] ?? 0);
    const outputEndFrame = Math.min(segmentStart + secondsToFrames(segment.durationSeconds), frameRange ? frameRange[1] + 1 : Infinity);
    if (outputStartFrame >= outputEndFrame) return [];
    return [{ segment, outputStartFrame, durationInFrames: outputEndFrame - outputStartFrame,
      sourceStartFrame: secondsToFrames(segment.sourceStartSeconds) + (segment.kind === "live" ? outputStartFrame - segmentStart : 0) }];
  });
}

/** One packed derivative per source. Omitted intervals are decoded, not encoded. */
export function planRenderSources(timeline: Timeline, frameRange?: RenderFrameRange): Record<string, RenderSourcePlan> {
  const selections: Record<string, SourceFrameWindow[]> = {};
  for (const picture of renderPictures(timeline, frameRange)) {
    const { sourceId, kind } = picture.segment;
    (selections[sourceId] ??= []).push({ sourceStartFrame: picture.sourceStartFrame, frameCount: kind === "hold" ? 1 : picture.durationInFrames });
  }
  return Object.fromEntries(Object.entries(selections).map(([id, selected]) => {
    const merged: SourceFrameWindow[] = [];
    for (const window of selected.sort((a, b) => a.sourceStartFrame - b.sourceStartFrame)) {
      const previous = merged.at(-1);
      if (previous && window.sourceStartFrame <= previous.sourceStartFrame + previous.frameCount) {
        previous.frameCount = Math.max(previous.sourceStartFrame + previous.frameCount, window.sourceStartFrame + window.frameCount) - previous.sourceStartFrame;
      } else merged.push({ ...window });
    }
    let frameCount = 0;
    const windows = merged.map(window => {
      const packed = { ...window, stagedStartFrame: frameCount };
      frameCount += window.frameCount;
      return packed;
    });
    return [id, { windows, frameCount }];
  }));
}

/** The whole picture must fit one retained interval; never bridge an omitted gap. */
export function stagedSourceFrame(windows: PackedSourceWindow[], sourceStartFrame: number, frameCount: number) {
  const window = windows.find(window => sourceStartFrame >= window.sourceStartFrame
    && sourceStartFrame + frameCount <= window.sourceStartFrame + window.frameCount);
  if (!window || !Number.isSafeInteger(sourceStartFrame) || !Number.isSafeInteger(frameCount) || frameCount <= 0) throw new Error('render:source_staging_trim_out_of_bounds');
  return window.stagedStartFrame + sourceStartFrame - window.sourceStartFrame;
}
