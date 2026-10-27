# Quality and acceptance

A walkthrough makes a real product understandable through use: its purpose,
main capabilities and defining interactions. A concrete task connects the
journey; a correct report about its outcome is insufficient. Installation,
input completion, source integrity, rendering and viewer comprehension establish
different facts.

This document defines acceptance. It does not declare that every supported
journey or quality gate has passed. A release's recorded observations must name
the actual host, installed artifact, source and result tested.

## 0.4.3 launcher compatibility correction

Version 0.4.2 added Chromium's internal sandbox independently of its browser
security update. Its installed public launcher failed to open the loopback
fixture: Chrome reported `sandbox initialization failed: Operation not permitted`
before any page existed, then terminated. Both page-order diagnostic arms failed
at that same boundary; closing the last page did not explain the failure.
Earlier direct-source checks had not qualified the installed launcher boundary.

Version 0.4.3 removes only that added sandbox toggle, retaining the patched
browser, existing Seatbelt network profiles, routing and process custody.
Playwright's default means the Chromium internal sandbox is disabled; the
[security limits](SECURITY.md#browser-runtime) remain explicit.

Observed source qualification on 27 October 2026 used macOS arm64 and Node
24.22.1. TypeScript checking passed, and the selected serial browser identity,
package/install, recorder-start, public-launcher and supervisor-custody gate
passed all 107 tests without skips. Its real public launcher exercised both
existing network mandates through observe, trusted native input, calibrated
capture, sealing and closed process-group absence. A separate public launcher
preflight observed native OS non-loopback TCP denial independently of browser
routing. This selected gate is not a full-suite run or an installed-release
qualification.

Bootstrap-candidate qualification on that host prepared the committed correction
`a90707d` through the public installer in an isolated home. Its independent
launcher selected prepared release `0.4.3-76e0dec9a25a1062` and CfT
156.0.8078.47, outside the source checkout. Both `loopback-only` and `web`
completed public open, observe, trusted native input, calibrated capture,
settled before/after marks, source sealing and close. The retained 3200×1800
sources visibly contained the unchanged fixture and actual trusted-click
response; the source integrity checks passed. Both exact worker groups were
absent after closure. The public loopback preflight independently observed
native OS non-loopback TCP denial; browser routing alone did not establish it.

This qualifies that synthetic packaged consumer and the restored launch path,
not complete-film quality, real-product authorization or equivalence with
Chromium's disabled internal sandbox. No existing user CLI or native plugin
selection changed, no audio inference ran and no model was acquired.

## 0.4.2 browser security qualification

This maintenance pins Chrome for Testing 156.0.8078.47 independently of
Playwright 1.64.1, using the locked upstream CfT downloader 3.2.6 only during
explicit preparation. Acquisition checks the reviewed versioned metadata;
that digest is not an independently published archive SHA-256. Setup and
preflight require the exact reported version. The internal Chromium sandbox
added in that release failed under the public loopback launcher, as described
above. [Security](SECURITY.md) describes the current selection and limits.

Observed source qualification on 27 October 2026 used macOS arm64,
Node 24.22.1 and an isolated browser/toolchain selection, without activating a
user installation:

- TypeScript checking passed. The selected serial browser-identity, setup,
  package-install and package-release gate passed 47 tests. After deriving the
  package preparation identity from its single owner, the affected browser and
  packaging gate passed all 7 tests. These overlapping gates are not a full
  suite run. The resolved lockfile audit reports zero known vulnerabilities;
  that does not scan browser bytes or establish absence of compromise.
- The real acquisition helper verified live official metadata and selected
  the exact scratch-owned browser. All 12 scrollbar regressions and all 3
  synthetic renderer integrations passed with that browser, retaining source
  frames, PCM timing, captions and camera behavior.
- An initial repeated-take capture refused startup with
  `CAPTURE_CLOCK_UNCERTAIN` and stopped its recorder: the measured uncertainty
  exceeded the existing admission limit. Its cause is unestablished. An
  isolated rerun passed both repeated takes and the public session capture
  path with native input, a calibrated retained source and sealing. Those
  passes establish a usable synthetic capture, not a causal repair of the
  earlier refusal. Clock tolerances were not weakened.

These are source and synthetic consumer checks. They do not establish a
published archive, refreshed native plugin, activated installation, new author
trial or complete-film viewing/listening acceptance. No real product account
or historical production was used.

## 0.4.1 maintenance qualification

The maintenance updates the direct runtime and development
dependencies on macOS arm64 with Node 24.22.1. It selects Playwright 1.64.1
and Chrome for Testing 156.0.8078.4 (revision 1248), Remotion 4.0.538 and
React 19.3.1. Checked launch-custody and complete-byte frame-transport repairs
remain. Because Remotion removed its prestitcher capacity check, the existing
Walkthrough worker now owns the strict memory admission described in
[Architecture](ARCHITECTURE.md).

Observed source qualification on 24 October 2026:

- The complete serial `tests/*.test.ts` gate passed 724 tests, with no failures
  or skips, including both opted-in headed browser/media tests. Real native
  print retained one original input, calibrated product/preview/viewer sources
  and the full original PDF. The headed geometry test measured the actual
  document-to-native capture mapping rather than correcting it.
- Chromium 156 exposed viewport scrollbars outside the calibration cover. The
  recorder now paints root/body scrollbar parts and reserved gutters without
  changing application geometry, scroll or focus. Twelve pixel-exact browser
  regressions cover native/custom/standard scrollbars and preserve concurrent
  application style changes. Clock detection tolerances were not weakened.
- A subsequent recorder-start containment prevents new session work after an
  uncertain start. Four passing deterministic tests retain the original error and ID,
  rejoin without dispatch, and require explicit original-context closure.
  Successful starts and pre-dispatch refusals remain usable. A further selected
  session/public-launch/framing/plugin-guidance gate passed 33 tests after the
  runtime change; it is not presented as a second full-suite run.
- An earlier public-loopback close exceeded the harness limit. Its cause is
  still unestablished: later isolated and complete gates pass that path, not
  prove a causal repair. The harness now retains original failures and failed
  fixtures; content-free close-phase diagnostics identify the outstanding
  boundary without introducing a timeout, kill or retry.
- TypeScript checking passes. The resolved lockfile's audit reports zero known
  vulnerabilities after the Zod 4.6.6 override. This does not establish absence
  of supply-chain compromise. Real synthetic renderer integrations exercise
  source/frame/audio identity, captions, camera and strict memory admission;
  they do not establish complete-film perceptual quality.

These checks qualify the maintenance source, not film comprehension or a new
author trial. Foreground-application preservation was not independently
observed in the headed tests; isolated synthetic windows alone do not prove it.
Archive publication, independent installation and native Codex/Claude selection
are separate consumer checks recorded with the release. Current Voices
inference and full-film viewing/listening are not claimed by this maintenance.

## The finished viewing experience

Watch and listen to the whole encoded film at normal speed and delivery size.
Judge what the viewer sees without adding implementation knowledge:

- Is the product's purpose apparent, with its main working areas oriented
  before detail?
- Do defining interactions receive meaningful use, with a visible gesture and
  readable response rather than a control catalogue?
- Do speech, action, camera and the next capability form a connected passage?
- Does each pause leave a new relationship to follow, read or compare? Is a
  still comparison useful rather than merely labelled a reading hold?
- Do camera and emphasis locate the subject without concealing context,
  chasing every click or implying an application state that did not happen?
- Are text, captions, pointer, real click/drag feedback and exported files
  legible at delivery size?
- Is the voice intelligible, natural and accurate, without omitted/repeated
  words or distracting transitions?

A viewer unfamiliar with the product should explain what it enables, recognize
its main working areas and understand how to begin its defining interaction.
The example's conclusion alone does not answer these questions. A film can
pass structural QA and still fail this viewing standard.

Stills, contact sheets, decoded-frame checks, ASR agreement and loudness metrics
are distinct evidence. They cannot establish full viewing/listening or viewer
understanding. State an unavailable review narrowly rather than calling it
complete. `awaiting-human-review` is a delivery state, not acceptance.

## Installed product and native discovery

Qualify the creator's actual route, not just files on disk:

1. Install the native plugin through Codex and Claude Code separately. Inspect
   the host's loaded identity and skill discovery, including a natural film
   request and a nearby written-guide request that should not start recording.
2. Install the bootstrap archive in an isolated home outside the source
   checkout. Verify exact acquisition, checked patches, browser reuse,
   interrupted preparation/activation recovery and subsequent operation without
   dependency downloads.
3. Confirm one canonical skill, no competing runtime-created projection, and
   the intended standalone CLI on PATH. Plugin discovery, selected CLI and
   cached running-host metadata are separate observations.
4. Use fresh independent authors, one for each host, with the same installed
   release and ordinary product/audience/intent brief. No private history,
   adapter, prepared action sequence or technical coaching supplies the result.
5. Revise with the application unavailable and checkout inaccessible. Reuse
   sealed sources and compatible retained audio without the historical Voices
   installation. New text or analysis must still require its relevant setup.

Each author must explore, select meaningful input, record, narrate, compose and
deliver through public tools. A real creator clarification is legitimate;
giving the trial's answer is not. Success from one author does not compensate
for failure from another. Repair the responsible guidance or operation and
repeat the affected test with a fresh author, not a coached rescue.

Update and uninstall must preserve projects, configuration, profiles, audio and
shared dependencies. Active/unresolved custody prevents switching releases.
An interrupted transaction recovers its original targets. Plugin removal
withdraws guidance without silently abandoning browser custody under the CLI.

## Setup and recovery

- `help` and `--version` work without operational-state writes or supervisor
  startup. A command's presence does not establish configured readiness.
- Setup distinguishes a missing prerequisite, missing selection and changed
  identity. A candidate remains unselected until apply revalidates it.
- Operator tools, saved default voice and Remotion assertion are not personal
  developer defaults. No model installation or shared-tool mutation hides in
  setup inspection/preparation.
- A changed Voices runtime requires explicit verification, not a silent new
  hash. Retained media keep their original receipts and provenance.
- A session interrupted before worker identity registration can be inspected
  and closed once original launch custody is proven stopped. It must not
  launch a replacement browser to recover an old identity.
- Audio attempt inspection reports the exact stage, identity, settlement,
  products and next action without inference. Resolution first proves worker
  and process-group settlement, then adopts valid output or releases only the
  incomplete stage. It does not discard diagnostics or replay completed stages.

Errors must identify surviving state and an operation the caller can use.
Recovery must not require source reading, deleting a cache or choosing a fresh
identity to bypass uncertainty.

## Acquisition gates

### Authority, input and uncertainty

- The project mandate and application prerequisites admit the intended work.
  Descriptive effects are not a semantic firewall or server receipt.
- Navigation, observed-target, upload and authentication boundaries hold
  without claiming that all browser requests are restricted to navigation
  origins. `web` includes normal HTTP(S), including non-standard ports.
- An action ID and exact payload are durable before input. Repeating the same
  identity recovers the original attempt; a changed payload conflicts.
- `not-dispatched`, `input-completed` and `outcome-uncertain` describe input.
  Timeouts do not cancel effects. Dependent consequential work waits for
  reconciliation of the original uncertain effect.
- `action resolve` adds observed evidence without rewriting dispatch or
  sending input. Fresh IDs are not uncertain-action retries.
- Actual clicks, drag, wheel, keys, text, selections and files supply the
  interaction. No injected application state or fabricated post-hoc motion.
- Popups require explicit selection. Modifiers release during failure and
  cancellation. Authentication stops capture and observations; resume clears
  old handles and leaves recording off.
- Downloads retain actual bytes/hash, original name and meaningful media type,
  including Blob exports. Reimport uses that exact file. Export-click success
  alone does not establish a usable artifact.
- A framing target binds a fresh observation, page/frame/document and unchanged
  view. It is static geometry, not object tracking or proof of a business result.
- Stopped calibrated takes qualify for sealing. `applicationSuccess:
  "not-attested"` remains explicit; integrity does not certify application success.
- Close must establish stopped custody, not merely record a request. A worker
  failure does not imply every child stopped or in-flight footage survived.

Synthetic tests cover stale DOM/canvas targets, changed sources, lost responses,
cancellation, downloads, input release, navigation and duplicate identity.
Real capture checks qualify the actual browser, compositor and source cadence.
Run recording/clock tests serially; competing recordings can starve frames and
must not be hidden by lowering production thresholds.

### Print and files

Native print requires its own real-browser qualification: exactly one newly
observed preview for expected real input, explicit selection, readable settings
and completed generation. The exclusive action/browser context binding is not a
browser-proved opener relationship. Concurrent manual input is excluded.

Retaining the PDF verifies generation/settings before and after retrieval.
Changed or incomplete generations fail. Saving, deliberate preview closure and
opening the same retained PDF are separate actions. Product, preview and viewer
have separate calibrated takes; edits omit suspended source intervals.
Lost responses keep original identities; viewer failure preserves saved bytes.
Native settings automation, native Save and OS chooser control are unavailable.

Only explicitly selected `deliverable` artifacts enter delivery. Verify each
copy. Zero artifacts is valid when a product journey has no file payoff.

### Privacy

Credentials, emailed links, unrelated records and private accounts must not
enter footage or agent-readable inputs. Profiles remain outside projects.
Generic text input is not a credential mechanism. Review class admits only
the relevant real or synthetic evidence, never credentials or unrelated data.
Hosted authors cannot inspect private-local frames, DOM/AX, traces or audio.
Local shell access does not make a hosted model local.

## Edit, audio and media gates

Pictures set film length. Narration has independent output placements and may
cross cuts. Actual speech must not overlap or overrun pictures. Shorten or
reposition a thought, select meaningful footage or use an appropriate settled
hold; do not pad pictures, freeze spinners or accelerate speech/product motion.

Live ranges remain 1×. Holds select a frame inside an explicitly observed
settled interval. Pixel stability alone does not make pending work a legitimate
hold. Offline framing and emphasis resolve only on the exact selected source.
Caption boxes must remain clear of declared subjects and active emphasis
through camera movement and cuts, not merely at one inspected frame.

Blocking objective errors remain separate from nonblocking editorial
observations. Camera movement during a gesture and `NARRATION_GAP` locate
passages to inspect. Alignment-derived gaps are not acoustic silence or a
perceptual defect score. Complete timings may expose internal gaps; incomplete
timings conservatively cover measured speech. Unknown duration cannot establish
silence. Pointer activity must not suppress a reported gap.

Verify output container/streams, dimensions, timestamps, authored frame count,
decodability, readable product text at maximum zoom, complete VTT and visible
short phrase captions without a permanent rail or duplicate player captions.
Check current bundle hashes and original delivered artifacts.

For narrated full-film delivery, measure final AAC at −16 LUFS ±0.5 LU and at
most −1 dBTP. Two-pass normalization must preserve timing. Preview keeps source
gain and reports loudness `not-evaluated-preview`; a short/silent excerpt does
not need padding to satisfy a full-film gate. Numeric conformance does not
establish intelligibility or comfortable listening.

New audio binds an included voice, language and reviewed provision. Test English
and Italian through actual installed Voices before claiming their real-model
quality. Historical absent language keeps English meaning without byte rewrites.
Alignment estimates canonical word timing; independent ASR retains recognized
words and lexical differences with its own identity. Names, accents, numbers,
order and contractions must not be normalized away. A mismatch does not rewrite
captions or trigger regeneration; a match does not prove spoken accuracy.

Explicit audio reuse verifies retained WAVs, alignment, any recorded ASR and their original
text/voice/language/provenance. In an entirely compatible revision it performs
no new inference and does not require the former or current Voices installation.
New/incompatible phrases require current setup; matching corrupted bytes fail.
Changed ASR identity must not regenerate speech. Incomplete alignment or ASR
recovery must preserve valid synthesis and diagnostics.

Preview must exactly match `[from,to)` on the absolute 60 fps clock, including
speech already in progress, original camera and caption positions. Failed
replacement preserves the previous current preview. Successful replacement
retires only its exact unchanged owned files; changed/foreign data remain.
Preview MP4 integrity is narrower than complete source/bundle verification.

## Genuine 1080p60

Separate source motion, clock evidence, composition, encoding and playback.
Deliver 1920×1080/60 fps from measured 3200×1800 source with at most 1.5× zoom.
Nominal fps, duplicated/interpolated footage and a smooth pointer overlay
cannot qualify weak source cadence. Static views and explicit reading holds
are not automatically freeze defects.

Source probes preserve native timestamps without demuxer fill-in. Calibration
must observe complete return phases and exclude slate frames. Causal VFR staging
must preserve selected original frames across nonzero origins, cold seeks,
disjoint/reordered ranges and one-frame holds. Original timestamps own cadence
evidence, not derivative duplicates. Frame order/count and PCM clock must
survive native streaming and final encoding; CRF 1 does not promise pixel equality.

Measure renderer scratch, process advancement and native frame-response behavior
where relevant. A small final directory does not establish peak footprint, and
a Node mock does not establish sustained Chrome memory behavior. Observe the
real consumer before attributing a failure to a runtime change.

## Retention and defect ownership

Completed compaction verifies the bundle and inputs before retiring only known
regenerable staging, renderer bundle, master and decoded samples. Settled failed
compaction requires a recorded error and verified edit/sources/audio; it retains
diagnostics and sole MP4/poster. Failed non-current previews use the same
admission and deletion owner, with their exact range and measured narration
subset checked; the preview lock, current sample and active metadata are
preserved. An early failure without scratch is already compact. Live or unresolved
custody and unexpected paths refuse removal.
Compaction does not delete whole projects or superseded films. Logical removed
bytes are not measured physical storage savings.

| Defect | Repair owner |
| --- | --- |
| Film became a report or disconnected feature catalogue | Authoring/story and shot selection |
| Unready target, wrong application result or unknown effect | Application owner/original action evidence |
| Required gesture is missing or source motion is unreadable | Capture, within existing authority |
| Confusing explanation, pacing, crop, emphasis or captions | Edit against retained sources |
| Wrong words or pronunciation | Affected speech, checked against canonical text and sound |
| Correct speech with bad timing | Alignment/caption placement, preserving speech |
| Failed alignment/ASR after valid synthesis | Exact incomplete audio stage |
| Encoding, loudness or bundle defect | Renderer/finisher/delivery |
| Update, discovery or uninstall loses access/work | Native plugin or release installer, according to the failing boundary |

Repair the nearest sufficient owner and rerun downstream checks whose inputs
changed. Do not repeat application work to prove an editorial repair. Do not
recreate explicitly retired productions to fill a historical checklist. Report
what was observed, what remains open and what the evidence actually supports.
