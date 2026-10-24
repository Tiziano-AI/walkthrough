import type {Page} from 'playwright';
import type {InteractionPacing, Point} from './events.ts';
import type {LocalTools} from '../core/contracts.ts';
import type {Box} from '../project/contracts.ts';

/** Session scope is an operator mandate, not a claim about API semantics or
 * network isolation. Only document destinations and local file custody are
 * mechanically narrowed here; ordinary application traffic remains native. */
export type SessionConfig = {
  directory: string;
  projectId: string;
  projectPath: string;
  startUrl: string;
  allowedOrigins: string[];
  uploadRoots: string[];
  network:'web'|'loopback-only';
  mediaReview?:'private-local'|'agent-reviewable'|'agent-reviewable-synthetic';
  profileDirectory?:string;
  tools?:LocalTools;
  executablePath?: string;
  headless?: boolean;
  idleTimeoutMs?: number;
  pacing?: Partial<InteractionPacing>;
};
export type SessionInfo = {
  version: 1; sessionId: string; projectId: string; projectPath:string; directory: string;
  status: 'starting'|'open'|'authentication'|'closed'|'interrupted';
  createdAt: string; updatedAt: string; pid?: number; selectedPageId?: string;
  captureActive: boolean; socketPath: string; closeReason?: string;
  /** Original resolved browser profile. Absent in old records; null in readback
   * means retained evidence cannot establish it. This is not login validity. */
  profileDirectory?:string|null;
  /** The original open coordinator can still spawn until its process lifetime
   * ends. Retained before reservation; never used as signal authority. */
  launchIdentity?:ProcessIdentity;
  workerToken?:string; processIdentity?:ProcessIdentity; processes?:ProcessIdentity[];
};
export type ProcessIdentity={pid:number;pgid:number;startedAt:string;commandSha256:string};
export type ElementTarget = {ref: string};
export type SurfaceTarget = {surfaceId: string; x: number; y: number};
export type SessionTarget = ElementTarget|SurfaceTarget;
export type SessionAction =
  | {kind:'navigate'; url:string; pageId?:string}
  | {kind:'select-page'; pageId:string}
  | {kind:'click'; target:SessionTarget; button?:'left'|'middle'|'right'; clickCount?:number; modifiers?:Array<'Alt'|'Control'|'Meta'|'Shift'>;expectPrintPreview?:true}
  | {kind:'hover'; target:SessionTarget}
  | {kind:'text'; target:SessionTarget; text:string; mode?:'type'|'insert'|'replace'}
  | {kind:'keys'; target?:SessionTarget; keys:string;expectPrintPreview?:true}
  | {kind:'select'; target:ElementTarget; values:string[]}
  | {kind:'wheel'; target:SessionTarget; deltaX:number; deltaY:number}
  | {kind:'drag'; from:SessionTarget; to:SessionTarget; button?:'left'|'middle'|'right'; modifiers?:Array<'Alt'|'Control'|'Meta'|'Shift'>; durationMs?:number}
  /** The observed file input, or a visible control whose native click opens an input-backed chooser. */
  | {kind:'upload'; target:ElementTarget; paths?:string[];artifactIds?:string[];sourceArtifacts?:Array<{sourceSetId:string;artifactId:string}>}
  | {kind:'dialog'; dialogId:string; response:'accept'|'dismiss'; promptText?:string}
  | {kind:'save-print-preview';pageId:string;observationId:string;filename:string}
  | {kind:'close-print-preview';pageId:string}
  | {kind:'open-artifact';artifactId:string}
  | {kind:'auth-begin'}
  | {kind:'auth-resume'};
export type ActionRequest = {actionId:string; action:SessionAction};
export type SessionEvent = {
  eventId:string; kind:'popup'|'download'|'dialog'|'navigation-blocked'|'page-closed'|'print-preview';
  at:string; pageId:string; actionId?:string;
  detail:Record<string,unknown>;
};
export type ActionRecord = {
  version:1; actionId:string; payloadSha256:string; action:SessionAction;
  status:'not-dispatched'|'input-completed'|'outcome-uncertain';
  createdAt:string; updatedAt:string; dispatchedAt?:string;
  startedAtMs?:number; completedAtMs?:number;
  error?:{code:string;message:string}; eventIds:string[];
  result?:{artifactId?:string;pageId?:string;print?:{
    input:{status:'pending'|'completed'|'failed';error?:{code:string;message:string}};
    discovery:{status:'pending'|'found'|'failed';error?:{code:string;message:string}};
  }};
  resolution?:{outcome:'effect-observed'|'no-effect-observed'|'uncertain';note:string;at:string};
};
export type PageInfo = {pageId:string; selected:boolean; url?:string; title?:string; closed:boolean;kind?:'native-print';sourcePageId?:string;actionId?:string};
export type NativePrintState={sourcePageId:string;actionId:string;sourceBinding:'exclusive-action-and-browser-context';state:string;generation?:{requestId:number;ticketSha256:string;previewToken:string;frameId:string}};
export type SelectOption = {index:number;value:string;label:string;disabled:boolean;selected:boolean};
export type ElementRef = {
  ref:string; pageId:string; frameId:string; documentId:string;
  tag:string; role:string; name:string; text:string; value?:string;
  /** Exact option strings from this snapshot; never shortened into an actionable value. */
  options?:SelectOption[];optionsTotal?:number;optionsRetainedTotal?:number;optionsTruncated?:boolean;
  optionsOffset?:number;optionsNextOffset?:number;multiple?:boolean;
  enabled:boolean; bounds:{x:number;y:number;width:number;height:number}|null;
};
export type Observation = {
  observationId:string;observedAt:string; pageId:string; surfaceId:string; documentId:string;
  width:number; height:number; coordinateSpace:'css'; pages:PageInfo[];
  frames:Array<{frameId:string;documentId:string;url:string;parentFrameId?:string}>;
  refs:ElementRef[]; truncated:boolean;refsTotal:number;refsTruncated:boolean;offset:number;nextOffset?:number;screenshotPath?:string;screenshotPixels?:{width:number;height:number}; text:string;
  events:SessionEvent[];
  nativePrint?:NativePrintState;
};
export type ObserveOptions = {pageId?:string;screenshot?:boolean;limit?:number;observationId?:string;offset?:number;ref?:string};

/** A static framing from one current observation, never an input or tracking target. */
export type CaptureMarkTarget = {observationId:string;ref:string}|{observationId:string;box:Box;coordinateSpace:'screenshot'};
export type CaptureRequest = {operationId:string;kind:'start'|'mark'|'stop';request?:{title?:string;id?:string;settled?:boolean;target?:CaptureMarkTarget}};
/** Content-free boundaries for diagnosing an original close attempt. */
export type SessionClosePhase = 'starting'|'print-close'|'print-discovery-cancel'|'print-discovery-settle'|
  'context-close-before-capture'|'capture-stop'|'context-close'|'parked-capture-stop'|
  'print-dispose'|'input-dispose'|'pending-input-settle'|'events-settle'|'journal-save'|'marker-remove'|'closed'|'failed';
export type SessionRuntimeOptions = {onClosed?:()=>void;onClosePhase?:(phase:SessionClosePhase)=>void|Promise<void>};
export type ResolvedTarget = {
  page:Page;point:Point;element?:import('playwright').ElementHandle<HTMLElement|SVGElement>;
  /** Pointer input must still reach the resolved point without retargeting. */
  verifyPointer:()=>Promise<void>;
  /** Keyboard input retains identity and readiness, but may change layout. */
  verifyKeyboard:()=>Promise<void>;
};

export class SessionError extends Error {
  code:string;
  constructor(code:string,message=code){super(message);this.name='SessionError';this.code=code;}
}
export const sessionError = (error:unknown) => ({code:error instanceof Error&&'code'in error&&typeof error.code==='string'?error.code:'SESSION_OPERATION_FAILED',message:error instanceof Error?error.message:String(error),...(error instanceof Error&&'recovery'in error&&typeof error.recovery==='string'?{recovery:error.recovery}:{})});
