import {Failure} from '../core/contracts.ts';
import type {FilmSource,SourceSet,TakeRecord} from './contracts.ts';

/** Paging never changes or abbreviates the retained evidence on disk. */
export function pageItems<T>(items:T[],limit=20,offset=0){
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(offset)||offset<0)throw new Failure('INVALID_PAGE','input','Use a positive bounded limit and a nonnegative integer offset.');
  const end=Math.min(items.length,offset+limit);
  return {items:items.slice(offset,end),total:items.length,offset,nextOffset:end<items.length?end:null,truncated:end<items.length};
}
export function sourceSummary(source:FilmSource){
  const {pointer,...summary}=source;return {...summary,pointerSamples:pointer.length};
}
export function takeSummary(take:TakeRecord){
  const {source,marks,...summary}=take;
  return {...summary,...(source?{source:sourceSummary(source)}:{}),marks:pageItems(marks)};
}
export function captureSummary(value:unknown):unknown{
  if(!value||typeof value!=='object')return value;
  const record=value as Record<string,unknown>;
  if(record.schemaVersion===1&&typeof record.sessionId==='string'&&Array.isArray(record.marks))return takeSummary(value as TakeRecord);
  return {...record,...(record.take?{take:captureSummary(record.take)}:{}),...(record.result?{result:captureSummary(record.result)}:{})};
}
export function inspectSourceSet(retained:{sourceSet:SourceSet;sha256:string;directory:string;sourcePaths:Record<string,string>;artifactPaths:Record<string,string>},options:{section?:string;sourceId?:string;limit?:number;offset?:number}={}){
  const {sourceSet:set,sha256,directory}=retained;
  const limit=options.limit??20,offset=options.offset??0;
  const identity={id:set.id,projectId:set.projectId,createdAt:set.createdAt,state:set.state,mediaReview:set.mediaReview,sha256,directory,integrity:'verified',manifestPath:`${directory}/source-set.json`};
  const sources=set.sources.map(source=>({...sourceSummary(source),path:retained.sourcePaths[source.id]}));
  const artifacts=set.artifacts.map(artifact=>({...artifact,path:retained.artifactPaths[artifact.id]}));
  if(options.section===undefined){
    if(options.sourceId)throw new Failure('INSPECTION_SECTION_REQUIRED','input','Use --section pointer with --source <id> to read recorded input samples.');
    return {...identity,sources:pageItems(sources,limit,offset),marks:pageItems(set.marks,limit,offset),artifacts:pageItems(artifacts,limit,offset),records:{total:set.records?.length??0}};
  }
  if(options.section==='pointer'){
    const source=set.sources.find(source=>source.id===options.sourceId);
    if(!source)throw new Failure('SOURCE_NOT_FOUND','sources','Choose a source id from this source set and pass --source <id>.');
    return {...identity,section:'pointer',sourceId:source.id,...pageItems(source.pointer,limit,offset)};
  }
  if(options.sourceId)throw new Failure('INSPECTION_SOURCE_UNUSED','input','--source is used only with --section pointer.');
  const sections={sources,marks:set.marks,artifacts,records:set.records??[]};
  if(!Object.hasOwn(sections,options.section))throw new Failure('INSPECTION_SECTION_INVALID','input','Choose sources, marks, artifacts, records or pointer.');
  return {...identity,section:options.section,...pageItems<unknown>(sections[options.section as keyof typeof sections],limit,offset)};
}
