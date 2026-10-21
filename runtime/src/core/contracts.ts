export class Failure extends Error {
  code: string;
  owner: string;
  recovery: string;
  constructor(code: string, owner: string, recovery: string) {
    super(code);
    this.code = code; this.owner = owner; this.recovery = recovery;
  }
}

export type MediaReview = 'private-local'|'agent-reviewable-synthetic'|'agent-reviewable';
export type LocalTools = {nodePath:string;browserPath:string;ffmpegPath:string;ffprobePath:string};
export type Box = {x:number;y:number;width:number;height:number};
export type PointerSample = {timeSeconds:number;x:number;y:number;type:'move'|'down'|'up';gesture?:'drag'};
