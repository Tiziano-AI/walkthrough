/** Real browser input evidence, measured on the session worker's Node clock. */
export type Point={x:number;y:number};
export type TargetGeometry=Point&{width:number;height:number};
export type InputEvent={
  kind:'pointermove'|'pointerdown'|'pointerup'|'wheel'|'keyboard'|'input'|'paste'|'fill'|'select'|'upload'|'navigation'|'scroll'|'hold'|'settled';
  atMs:number;source:'browser'|'driver';phase?:'start'|'end'|'down'|'up';
  x?:number;y?:number;bounds?:TargetGeometry;trusted?:boolean;clockUncertaintyMs?:number;inputType?:string;
  button?:number;buttons?:number;gesture?:'drag';deltaX?:number;deltaY?:number;deltaMode?:number;
  altKey?:boolean;ctrlKey?:boolean;metaKey?:boolean;shiftKey?:boolean;
};
export type InteractionPacing={minimumApproachMs:number;distanceMsPerPixel:number;targetDwellMs:number;keyDelayMs:number};
export const deliberatePacing:Readonly<InteractionPacing>={minimumApproachMs:800,distanceMsPerPixel:0.6,targetDwellMs:450,keyDelayMs:65};
