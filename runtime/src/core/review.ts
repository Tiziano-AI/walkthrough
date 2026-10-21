import {createHash} from 'node:crypto';
import {validDeliveredArtifact,type DeliveredArtifact} from './deliverables.ts';
import type {TemporalPresentation} from './quality.ts';
import {OUTPUT_FPS} from '../render/timeline.ts';

export interface ReviewPageInput {
  /** The retained encode's identity, not a viewer preference or a new render option. */
  presentation: TemporalPresentation;
  runId: string;
  title: string;
  goal: string;
  /** Canonical, source-authored narration, not text extracted from a capture. */
  narration: string;
  /** Exact VTT delivered beside this page, compiled from timeline captions. */
  captionsVtt: string;
  deliverables?: DeliveredArtifact[];
}

const styles = `
:root{color-scheme:dark;--bg:#131917;--ink:#f2f2e9;--muted:#b7c4ba;--accent:#cbe6b4;--line:#46534a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
a{color:var(--accent);text-underline-offset:.22em}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--accent);outline-offset:6px}
.skip{position:absolute;left:1rem;top:1rem;transform:translateY(-200%);padding:.6rem 1rem;background:var(--ink);color:var(--bg);z-index:1}
.skip:focus{transform:none}
.shell{max-width:1200px;margin:auto;padding:28px 36px 56px}
header{padding:0 0 24px;max-width:920px}
h1{font-size:clamp(2rem,4.5vw,3.5rem);line-height:1.1;letter-spacing:-.035em;margin:0 0 16px;overflow-wrap:anywhere}
.goal{color:var(--muted);font-size:1.1rem;max-width:72ch;margin:0;overflow-wrap:anywhere}
figure{margin:0}
video{display:block;width:100%;aspect-ratio:16/9;background:#080c0a;border-radius:10px;box-shadow:0 16px 50px #0004}
figcaption{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:.85rem;padding:12px 0}
.downloads{display:flex;gap:12px 24px;flex-wrap:wrap;margin:8px 0 32px;font-size:.95rem}
.primary{font-weight:700}
p{margin:0 0 16px}
.muted{color:var(--muted);font-size:.9rem}
.narration{max-width:78ch;padding-top:18px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted)}
.player-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0}
button{font:inherit;color:var(--ink);background:#26342c;border:1px solid var(--line);border-radius:6px;padding:7px 12px;cursor:pointer}
button:hover{background:#35483d}
.timestamp-copy{font: .85rem ui-monospace,SFMono-Regular,Consolas,monospace;width:80ch;max-width:100%;color:var(--ink);background:#080c0a;border:1px solid var(--line);border-radius:4px;padding:8px}
.transcript-list{list-style:none;padding:0;margin:16px 0;max-width:85ch}
.transcript-list li{display:flex;gap:14px;align-items:baseline;margin:8px 0}
.transcript-list button{font:.82rem ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;padding:4px 7px}
.transcript-list span{overflow-wrap:anywhere}
details{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:18px 0}
details+details{border-top:0}
summary{cursor:pointer;font-weight:650;list-style-position:inside}
.technical{padding-top:18px}
.technical ul{display:flex;flex-wrap:wrap;gap:10px 26px;padding:0;list-style:none;margin:14px 0 0}
.technical li{margin:0}
code{font: .85rem/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
@media(max-width:640px){.shell{padding:20px 18px 36px}.downloads{gap:14px 22px}video{border-radius:6px}}
@media(prefers-reduced-motion:no-preference){a{transition:color .12s ease}}
`;

const escapeText = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

const seconds=(value:string)=>value.split(':').reduce((sum,part)=>sum*60+Number(part),0);
/** VTT is delivered separately; cue text here is escaped again as ordinary text. */
function transcriptCues(vtt:string){
  return [...vtt.matchAll(/(\d{2,}:\d{2}:\d{2}\.\d{3}) --> (\d{2,}:\d{2}:\d{2}\.\d{3})\n([^\n]+(?:\n(?!\n)[^\n]+)?)/g)].map(match=>({start:seconds(match[1]),label:match[1],text:match[3].replace(/\n/g,' ').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')}));
}

// No application content enters executable code. The same hashed script only
// operates the local player and bounded numeric cue attributes.
// currentTime is a media clock, not evidence of the displayed frame. Copy the
// clock with its original seconds and explicitly identify the nearest output
// edit boundary, which can be the film end. boundary/FPS retains enough precision
// for the public frame-alignment validator.
const playerScript=`const video=document.querySelector('video');
const stamp=value=>{const ms=Math.round(value*1000);const s=Math.floor(ms/1000);return [Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n=>String(n).padStart(2,'0')).join(':')+'.'+String(ms%1000).padStart(3,'0');};
const feedback=value=>{const boundary=Math.round(value*${OUTPUT_FPS});if(!Number.isFinite(value)||value<0||!Number.isSafeInteger(boundary))return null;return stamp(value)+' (media '+value+' s) · nearest output edit boundary '+boundary+' at ${OUTPUT_FPS} fps (zero-based; '+(boundary/${OUTPUT_FPS})+' s)';};
document.querySelectorAll('[data-seek]').forEach(button=>button.addEventListener('click',()=>{video.currentTime=Number(button.dataset.seek);video.focus();}));
document.getElementById('fullscreen').addEventListener('click',async()=>{try{if(video.requestFullscreen)await video.requestFullscreen();else if(video.webkitEnterFullscreen)video.webkitEnterFullscreen();}catch{document.getElementById('player-status').textContent='Use the player full-screen control.';}});
document.getElementById('copy-timestamp').addEventListener('click',async()=>{const value=feedback(video.currentTime);const output=document.getElementById('timestamp-copy');const status=document.getElementById('player-status');output.value=value??'';output.hidden=true;if(value===null){status.textContent='Timestamp unavailable.';return;}try{if(!navigator.clipboard)throw Error();await navigator.clipboard.writeText(value);status.textContent='Copied '+value;}catch{output.hidden=false;output.focus();output.select();status.textContent='Timestamp selected. Copy it with your keyboard.';}});`;

/** A portable local entry point; artifact links are confined to the
 * explicitly delivered directory and display their recorded titles and types. */
export function createReviewPage({presentation, runId, title, goal, narration, captionsVtt, deliverables=[]}: ReviewPageInput): string {
  if(presentation!=='full-frame-visible-captions'&&presentation!=='full-frame-subtitles')throw new Error('INVALID_REVIEW_PRESENTATION');
  if(!Array.isArray(deliverables)||deliverables.some(artifact=>!validDeliveredArtifact(artifact)))throw new Error('INVALID_DELIVERED_ARTIFACT');
  if(typeof captionsVtt!=='string'||!captionsVtt.startsWith('WEBVTT\n'))throw new Error('INVALID_REVIEW_CAPTIONS');
  // Historical retained encodes have no burned text. Keep their original
  // portable track; new visible-caption films must never acquire a second layer.
  const switchableCaptions=presentation==='full-frame-subtitles';
  const captionsUrl=switchableCaptions?`data:text/vtt;charset=utf-8;base64,${Buffer.from(captionsVtt,'utf8').toString('base64')}`:null;
  const pageStyles=styles+(switchableCaptions?'video::cue{background:rgba(0,0,0,.8);color:#fff;font-family:system-ui,sans-serif;font-size:clamp(14px,1.5vw,28px);font-weight:400;text-shadow:none}\n':'');
  const styleHash = createHash('sha256').update(pageStyles).digest('base64');
  const scriptHash = createHash('sha256').update(playerScript).digest('base64');
  const cues=transcriptCues(captionsVtt);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'sha256-${styleHash}'; img-src file:; media-src file:${switchableCaptions?' data:':''}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${escapeText(title)} — Walkthrough</title>
<style>${pageStyles}</style>
</head>
<body>
<a class="skip" href="#watch">Skip to video</a>
<div class="shell">
<main>
<header><h1>${escapeText(title)}</h1><p class="goal">${escapeText(goal)}</p></header>
<figure id="watch">
<video controls playsinline preload="metadata" poster="poster.png" aria-label="Narrated walkthrough" aria-describedby="video-help">
<source src="walkthrough.mp4" type="video/mp4">
${switchableCaptions?`<track kind="captions" label="Captions" srclang="en" src="${captionsUrl}">`:''}
Your browser cannot play this video. <a href="walkthrough.mp4" download>Download the MP4</a> and open it in a local video player.
</video>
<figcaption id="video-help">${switchableCaptions?'<span>Captions start off; use the player to switch them on.</span>':''}<span>Use full screen to inspect product text.</span></figcaption>
<div class="player-tools"><button id="fullscreen" type="button">Full screen</button><button id="copy-timestamp" type="button" title="Copy the media clock and nearest 60 fps output edit boundary">Copy timestamp</button><input id="timestamp-copy" class="timestamp-copy" aria-label="Current timestamp and nearest output edit boundary" readonly hidden><span id="player-status" class="muted" role="status"></span></div>
</figure>
<nav class="downloads" aria-label="Download walkthrough files">
<a class="primary" href="walkthrough.mp4" download>Download video · MP4</a>
<a href="captions.vtt" download>Captions · VTT</a>
<a href="narration.txt" download>Narration · TXT</a>
${deliverables.map(artifact=>`<a href="${escapeText(artifact.relativePath)}" download="${escapeText(artifact.filename??artifact.name)}">${escapeText(artifact.title)} · ${escapeText(artifact.mediaType)}</a>`).join('\n')}
</nav>
${narration?`<details id="transcript"><summary>Transcript</summary>${cues.length?`<ol class="transcript-list">${cues.map(cue=>`<li><button type="button" data-seek="${cue.start}" aria-label="Seek to ${cue.label}">${cue.label}</button><span>${escapeText(cue.text)}</span></li>`).join('')}</ol>`:`<div class="narration">${escapeText(narration)}</div>`}</details>`:''}
<details id="technical-files"><summary>Technical files</summary><div class="technical">
<p class="muted">Run <code>${escapeText(runId)}</code></p>
<ul><li><a href="poster.png" download>Poster · PNG</a></li><li><a href="edit-plan.json" download>Edit plan · JSON</a></li><li><a href="qa.json" download>QA report · JSON</a></li><li><a href="provenance.json" download>Provenance · JSON</a></li><li><a href="checksums.json" download>Checksums · JSON</a></li></ul>
</div></details>
</main>
</div>
<script>${playerScript}</script>
</body>
</html>
`;
}
