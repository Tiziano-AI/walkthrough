import {
  CAPTION_STRIP_HEIGHT, DEFAULT_CAPTION_PLACEMENT, OUTPUT_HEIGHT, OUTPUT_WIDTH,
  secondsToFrames, type Box, type CaptionPlacement, type Timeline,
} from './timeline.ts';

export const CAPTION_FONT_SIZE = 30;
export const CAPTION_LINE_HEIGHT = 38;
export const CAPTION_PADDING_X = 14;
export const CAPTION_PADDING_Y = 3;
export const CAPTION_LINE_GAP = 4;
export const CAPTION_FONT_FAMILY = 'Arial, sans-serif';

export interface CaptionLine { text: string; box: Box }
export interface CaptionOverlay { text: string; placement: CaptionPlacement; lines: CaptionLine[] }

// Arial's Latin advance widths in thousandths of an em. Kerning is disabled in
// the renderer, so both Node QA and Chromium use this deterministic line fit.
// Non-Latin glyphs receive a conservative advance; no text is ever abbreviated.
const latinWidths = [
  278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,
];

function glyphWidth(character: string): number {
  const code = character.codePointAt(0)!;
  if (code >= 32 && code <= 126) return latinWidths[code - 32];
  if (/\p{M}/u.test(character)) return 0;
  if (character === '\u00a0') return 278;
  if (/\s/u.test(character)) return 1000;
  if (/[‘’]/u.test(character)) return 222;
  if (/[“”]/u.test(character)) return 333;
  if (character === '–') return 556;
  if (character === '—' || character === '…') return 1000;
  const decomposed = character.normalize('NFD');
  if (decomposed !== character && [...decomposed].slice(1).every(char => /\p{M}/u.test(char))) return glyphWidth([...decomposed][0]);
  return code > 0xffff ? 2000 : 1100;
}

/** Conservative ink width, with a small guard for font rasterization. */
export function captionTextWidth(text: string): number {
  return Math.ceil([...text].reduce((sum, character) => sum + glyphWidth(character), 0) * CAPTION_FONT_SIZE / 1000) + 4;
}

function lineTexts(text: string, availableWidth: number): string[] {
  if (!text.trim()) throw new Error('render:empty_caption');
  const explicit = text.split('\n');
  if (explicit.length > 2) throw new Error('render:caption_does_not_fit');
  if (explicit.length === 2) {
    if (explicit.some(line => !line.trim() || captionTextWidth(line) > availableWidth)) throw new Error('render:caption_does_not_fit');
    return explicit;
  }
  if (captionTextWidth(text) <= availableWidth) return [text];
  let best: {lines: string[]; imbalance: number} | undefined;
  for (const match of text.matchAll(/\s+/gu)) {
    const lines = [text.slice(0, match.index), text.slice(match.index + match[0].length)];
    const widths = lines.map(captionTextWidth);
    if (lines.some(line => !line) || widths.some(width => width > availableWidth)) continue;
    const imbalance = Math.abs(widths[0] - widths[1]);
    if (!best || imbalance < best.imbalance) best = {lines, imbalance};
  }
  if (!best) throw new Error('render:caption_does_not_fit');
  return best.lines;
}

/** The strip is a placement constraint, never a painted rail. Each actual line
 * gets its own text-sized backing. These exact boxes are also the QA masks. */
export function layoutCaption(text: string, placement: CaptionPlacement = DEFAULT_CAPTION_PLACEMENT): CaptionOverlay {
  if (![placement.x, placement.y, placement.width].every(Number.isFinite) || placement.width <= 2 * CAPTION_PADDING_X
    || placement.x < 0 || placement.y < 0 || placement.x + placement.width > OUTPUT_WIDTH || placement.y + CAPTION_STRIP_HEIGHT > OUTPUT_HEIGHT) {
    throw new Error('render:invalid_caption_placement');
  }
  const texts = lineTexts(text, placement.width - 2 * CAPTION_PADDING_X);
  const height = CAPTION_LINE_HEIGHT + 2 * CAPTION_PADDING_Y;
  const totalHeight = texts.length * height + (texts.length - 1) * CAPTION_LINE_GAP;
  if (totalHeight > CAPTION_STRIP_HEIGHT) throw new Error('render:caption_does_not_fit');
  return {text, placement, lines: texts.map((line, index) => {
    const width = captionTextWidth(line) + 2 * CAPTION_PADDING_X;
    return {text: line, box: {
      x: placement.x + (placement.width - width) / 2,
      y: placement.y + (CAPTION_STRIP_HEIGHT - totalHeight) / 2 + index * (height + CAPTION_LINE_GAP),
      width, height,
    }};
  })};
}

/** Aligned intervals are start-inclusive and end-exclusive. No narration or
 * caption gap produces a backing, and a cut uses its own placement immediately. */
export function captionOverlayAtFrame(timeline: Timeline, frame: number): CaptionOverlay | null {
  const segment = timeline.segments.find(segment => frame >= secondsToFrames(segment.outputStartSeconds)
    && frame < secondsToFrames(segment.outputStartSeconds) + secondsToFrames(segment.durationSeconds));
  if (!segment) return null;
  for (const narration of timeline.narration) {
    const localFrame = frame - secondsToFrames(narration.outputStartSeconds);
    if (localFrame < 0 || localFrame >= secondsToFrames(narration.durationSeconds)) continue;
    const caption = narration.captions.find(caption => localFrame >= secondsToFrames(caption.startSeconds) && localFrame < secondsToFrames(caption.endSeconds));
    if (caption) return layoutCaption(caption.text, segment.captionPlacement);
  }
  return null;
}

export function captionOverlayBoxesAtFrame(timeline: Timeline, frame: number): Box[] {
  return captionOverlayAtFrame(timeline, frame)?.lines.map(line => line.box) ?? [];
}
