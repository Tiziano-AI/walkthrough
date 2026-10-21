export const validArtifactName=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
export const validArtifactFilename=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=255&&!/[\\/\x00-\x1f\x7f]/.test(value)&&value!=='.'&&value!=='..';
export const validMediaType=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(value);
export type DeliveredArtifact={name:string;title:string;mediaType:string;role:'deliverable';relativePath:string;sha256:string;bytes:number;filename?:string};

export function validDeliveredArtifact(value:unknown):value is DeliveredArtifact{
  const a=value as DeliveredArtifact;
  return !!a&&validArtifactName(a.name)&&typeof a.title==='string'&&!!a.title.trim()&&a.title.length<=512&&validMediaType(a.mediaType)&&a.role==='deliverable'
    &&a.relativePath===`deliverables/${a.name}`&&/^[a-f0-9]{64}$/.test(a.sha256)&&Number.isSafeInteger(a.bytes)&&a.bytes>=0&&(a.filename===undefined||validArtifactFilename(a.filename));
}
