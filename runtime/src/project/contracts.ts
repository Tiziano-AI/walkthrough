import type {Box, PointerSample, LocalTools, MediaReview} from '../core/contracts.ts';
export type {Box, PointerSample, LocalTools, MediaReview};

/** The creator's mandate is not a semantic classifier of the application's requests. */
export interface ProjectBrief {
  title:string; brief:string; audience:string;
  mandate:{applicationUrl:string;navigationOrigins:string[];network:'web'|'loopback-only';
    allowedEffects:string;dataDescription:string;inputRoots:string[];mediaReview:MediaReview;delivery:'local'};
}
export interface FilmProject extends ProjectBrief {
  schemaVersion:1;kind:'walkthrough-project';id:string;createdAt:string;
}
export interface RetainedFile {relativePath:string;sha256:string;bytes:number}
export interface FilmSource {
  id:string;media:RetainedFile;width:number;height:number;durationSeconds:number;frameCount:number;
  clock:{offsetSeconds:number;uncertaintySeconds:number;driftSeconds:number};pointer:PointerSample[];
  usableRange:{startSeconds:number;endSeconds:number};
}
export interface SourceMark {
  id:string;title:string;sourceId:string;timeSeconds:number;target:Box|null;
  /** Original observed geometry; target above is the canonical source raster. */
  targetObservation?:MarkTargetObservation;
  settled?:{startSeconds:number;endSeconds:number;method:'observed-stability'};
}
export interface MarkTargetObservation {
  observationId:string;observedAt:string;pageId:string;frameId:string;documentId:string;markId:string;
  ref?:string;coordinateSpace:'css'|'screenshot';box:Box;viewport:{width:number;height:number};
  screenshotPixels?:{width:number;height:number};
}
export interface FilmArtifact extends RetainedFile {
  id:string;title:string;filename:string;mediaType:string;role:'deliverable'|'source';
}
/** Sealing establishes source integrity, not application success or human acceptance. */
export interface SourceSet {
  schemaVersion:1;kind:'source-set';id:string;projectId:string;createdAt:string;state:'sealed';
  mediaReview:MediaReview;sources:FilmSource[];marks:SourceMark[];artifacts:FilmArtifact[];
  records?:RetainedFile[];provenance?:unknown;
}
export interface TakeRecord {
  schemaVersion:1;id:string;sessionId:string;pageId:string;title:string;createdAt:string;
  state:'recording'|'stopped'|'failed';source?:FilmSource;marks:SourceMark[];
  eventsPath:string;error?:{code:string;recovery:string};
  recovery?:{recordPath:string;analysis:RetainedFile;windowBasis:'recorded-capture-window'|'retained-event-and-mark-envelope'};
}
