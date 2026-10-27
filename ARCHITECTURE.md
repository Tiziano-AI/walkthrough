# Architecture

## One product, separate owners

Walkthrough combines native plugin guidance and an independent executable
runtime. The agent supplies product and editorial judgment. One generic
Playwright-controlled, product-owned browser supplies real input and recording;
sealed local sources supply offline composition. There is no second planner
or product-integration framework.

```mermaid
flowchart LR
    A[Native plugin: authoring skill] --> B[Agent and creator brief]
    B --> C[Independent film project]
    C --> D[Generic observe and act session]
    D --> E[Stopped takes and actual downloads]
    E --> F[Sealed source set]
    F --> G[Independent picture and narration tracks]
    G --> H[Verified retained or new local audio]
    G --> I[Single Remotion renderer]
    H --> I
    I --> J[Local film and review bundle]
```

`plugin.json` carries the portable plugin identity and OpenAI presentation.
`.claude-plugin/plugin.json` carries native Claude metadata. Both discover the
one source under `skills/walkthrough/`. The plugin root has no Node package or
installation hook; runtime code and its dependency manifests live under
`runtime/`, outside native plugin dependency discovery. Guidance installation
does not download dependencies, launch a browser or run inference. A host owns
plugin discovery, caching and removal.
The CLI remains independently reachable after plugin disable/removal so active
session custody is not orphaned.

## Release, configuration and project

The macOS arm64 bootstrap archive contains owned program source, skill,
documentation, exact lockfile, checked patch procedures and the compiled
non-privileged process reader. It does not redistribute npm dependencies or
their native libraries. The existing installer prepares an immutable release
by explicitly acquiring exact production dependencies with generic lifecycle
scripts disabled, applying qualified patches and acquiring the pinned browser.
Activation follows verification inside the same recoverable transaction.

The browser store is Walkthrough-owned and shared by exact CfT version across its
releases. Node 24, npm, FFmpeg/ffprobe and Voices are external installations,
resolved explicitly rather than through a mandatory Homebrew path. Production
does not install or download dependencies. The C toolchain is a release-build
prerequisite, not a consumer prerequisite.

The installer owns immutable releases, the selected `current` link, launcher
and transaction receipts. It verifies owned outputs, preserves foreign changes,
retains the selected release and its immediate predecessor, and refuses
replacement under active or unresolved work. Check is read-only; recovery
continues the exact transaction. Uninstall preserves film projects, settings,
audio, profiles and shared prerequisites. Legacy standalone skill links are
retired only when receipt-owned and native discovery is verified; no new
standalone projections compete with the plugin.

`setup inspect` distinguishes absent tools, absent configuration and identity
drift. `setup prepare` reads actual installations and creates a candidate;
`setup apply` verifies it again before selection. Tools, included voices, the
saved default narrator and the operator's renderer assertion are explicit.
Preparation does not acquire models or change shared Voices assets. Updating
Voices does not silently change the selected provision.

The program and project are independent. An explicit `.walkthrough` directory
contains `project.json`, `sessions/`, `takes/`, `sources/`, `edits/`,
`compositions/` and `previews/`. User runtime state, audio provision/cache,
configuration and authentication profiles live outside immutable releases.
Profiles also remain outside projects and never become source material.
Runtime discovery does not depend on the caller's working directory.

## Component ownership

| Owner | Responsibility |
| --- | --- |
| `skills/walkthrough/` | Recognition, exploration, authoring judgment and recovery guidance |
| `runtime/bin/walkthrough.mjs` | Public supervision, clean environment, network profiles and worker custody |
| `runtime/src/cli.ts`, `runtime/src/command-help.ts` | Public grammar, inputs, dispatch and JSON results |
| `runtime/src/project/` | Mandate, independent storage, source seals and retained integrity |
| `runtime/src/session/` | Bounded browser worker, observations, real input, events and handoff |
| `runtime/src/project/capture.ts`, `runtime/src/capture/` | Recording, source clocks, input evidence, marks and finalization |
| `runtime/src/core/film-edit.ts`, `film.ts`, `film-editorial.ts` | Independent tracks, structural checks, observations and composition |
| `runtime/src/core/film-preview-storage.ts`, `film-storage.ts` | Exact preview replacement and bounded render-scratch compaction |
| `runtime/src/audio/`, `runtime/src/render/` | Local speech/alignment/ASR, retained audio and one renderer/finisher |
| `runtime/src/core/review.ts`, `bundle.ts` | Viewer-centered local playback and current bundle integrity |
| `runtime/scripts/package-release.mjs`, `install-local.mjs` | Bootstrap inventory, dependency preparation, activation and recovery |

## Session and observed input

The project records application URL, permitted navigation origins, `web` or
`loopback-only`, descriptive allowed effects, data/input scope, review class and
local delivery. `allowedEffects` is the author's mandate, not an API classifier
or server-effect guarantee. The runtime does not inject application state,
simulate callbacks or offer arbitrary evaluation/direct application APIs.

`session open` reserves an identity before starting its session-scoped worker.
The worker serializes input through a local socket and keeps the page and
recording alive between commands. Opening the same identity rejoins that
attempt; it never promises a replacement browser. Inspection distinguishes
recorded state from current process identity. An interrupted pre-worker launch
is retired only when its original launch custody is demonstrably stopped, not
by blindly relaunching or signaling a reused PID.

`observe` returns page/frame/document identity, element references, surface and
viewport geometry, screenshot, bounded visible text and events. References bind
the actual observed element. Canvas, SVG and WebGL can use screenshot-grounded
coordinates. Changed documents or stale views fail rather than retargeting a
similar control. A popup is an observed page, not an automatic capture switch.

`act` supplies real pointer, drag, wheel, keyboard, text, selection, dialog and
file input through one driver. Modifiers release on success, failure and
cancellation. Input listeners retain actual document-scoped events, including
the pointer-down/up prefix of navigation. A caller's action label or requested
movement is not proof that the subject changed.

Each action has a durable identity and exact payload hash before dispatch.
Repeated identity/payload returns the retained attempt; changed payload fails.
`not-dispatched`, `input-completed` and `outcome-uncertain` describe input, not
server success. `action resolve` records observed evidence separately without
replaying or rewriting dispatch history. Timeouts do not cancel effects.

Authentication handoff stops capture and disables observations before human
credentials. Resume invalidates old handles and leaves recording off; a fresh
observation precedes another take. Session close, idle shutdown and process
failure retain distinct outcomes. There is no permanent daemon.

## Capture, files and sealed sources

The ordinary page is captured at 1600×900 CSS/DPR 2 as a measured 3200×1800
source. Playwright's built-in low-cadence video is not the master. Qualified
browser/Playwright revisions and launch-custody patches are checked rather than
silently upgraded.

Capture retains original timing, pointer/input events and clock calibration.
Original probes disable FFmpeg timestamp fill-in; nonfinite/decreasing native
timestamps fail. White/black calibration transitions bracket the source clock;
acknowledgement time cannot replace observed transitions. Usable source ranges
exclude calibration. Recovery qualifies the same completed recording offline
after its original processes stop, preserving failed analysis and original
capture operations.

A mark locates a useful state. Optional framing binds a fresh observation's
element or screenshot rectangle to canonical source geometry without moving
the application. Input/view changes invalidate the observation. The target is
static framing, not tracking. A settled mark samples pixel stability; the author
still decides whether the state is a meaningful reading hold.

Downloads, including Blob exports, retain original bytes, names, media types
and hashes. Upload can select admitted local files or verified retained session
or sealed artifacts. Reimport uses the original file, not equivalent generated
content. Native filesystem picker APIs are unavailable; standard downloads and
input-backed choosers are supported.

Native print is a separate surface. Expected real print input binds exactly one
new preview in the same exclusive action/browser context; it does not claim a
browser-proved opener relationship. Observed completed generation/settings
identify the PDF retrieved into normal artifact custody. Saving, preview closure
and opening the retained PDF are separate actions. Product, preview and viewer
use separate calibrated takes; the edit cuts suspended source intervals rather
than pretending uninterrupted recording. See the [public print contract](docs/browser-authoring.md#follow-native-print-through-to-its-retained-pdf).

`capture seal` accepts stopped calibrated takes and deliberately selected
artifacts. The immutable source set keeps media hashes, geometry, usable ranges,
clocks, marks, input evidence and supporting records. Artifact roles distinguish
supporting `source` files from `deliverable` files. No artifact is required when
the product has no file payoff. The seal explicitly does not attest application
success. Native project formats remain readable; the adapter-era importer and
its execution contracts are not part of this product.

## Edit and audio

A film edit binds an exact source-set identity/digest, ordered pictures and
independently timed narration. Live pictures run at 1×; holds select an observed
settled interval. Cuts and continuous ranges preserve their stated meaning.
Targets use explicit source-pixel boxes or source-bound `markId` references.
Camera moves and timed outline/spotlight emphasis resolve offline; they do not
track a moving object or create an application selection. Caption geometry is
in output pixels, away from the declared subject.

Boundaries and narration starts use the 60 fps frame grid. Actual WAV duration
determines speech fit. Overlap and overrun fail instead of extending pictures,
freezing pending work or accelerating speech. Structural validation performs
no synthesis. Blocking objective errors remain distinct from nonblocking
editorial observations such as camera movement during input or a cross-cut
narration gap. Bounded context and preview ranges make those observations
actionable without treating activity as a measure of meaning or quality.

New narration uses canonical installed Voices and explicit immutable model,
voice-reference and language identities. Synthesis, alignment and independent
ASR have separate cache keys and receipts. The saved default narrator belongs
to the operator. New edits select English or Italian; historical missing
language retains English meaning without rewriting its bytes.

Explicit `--reuse-audio` verifies compatible retained text, voice/language,
WAV, alignment and their original provenance. A crop or caption change does
not require speech generation. Valid retained media must remain reusable when
the former Voices runtime is absent; new inference/analysis needs the current
applicable provision. A matching corrupted artifact fails rather than being
silently replaced. Downstream alignment/ASR failures preserve valid synthesis.
`audio attempt inspect/resolve` reconciles an exact incomplete attempt only
after process settlement and preserves diagnostics and valid products.

ASR compares recognized speech with canonical text without erasing lexical
differences. Divergences locate words to inspect; they do not rewrite captions
or trigger automatic resynthesis. Alignment estimates word timing. Neither
ASR nor alignment establishes pronunciation, naturalness or listening acceptance.

Preview renders an exact half-open excerpt on the absolute film clock with the
same renderer. A phrase already in progress remains audible; unknown duration
cannot justify omitting it. Camera, input and captions retain film positions.
Previews retain source gain; complete-film finishing owns loudness mastering.

## Rendering and delivery

Server-side Remotion is the only renderer. Exact-version/hash patches preserve
native launch custody and register complete frame-response bytes as a Blob,
with upstream abort/fetch/URL handling intact. This is not a zero-disk or
constant-memory claim. FFmpeg owns source staging, encoding, muxing and probes.

The renderer streams PNG frames through its native parallel encoder into a
near-lossless H.264 CRF 1, 10-bit 4:4:4 MOV master with 48 kHz PCM. It refuses
a fallback that spools every rendered PNG. VFR sources stage causal
sample-and-hold frames on the output grid; selected intervals are packed and
shared, while source mappings preserve their original clocks. Duplication in
a derivative never qualifies weak source cadence. Source seals remain unchanged.

Remotion 4.0.538 no longer makes prestitcher admission depend on memory. The
Walkthrough worker now samples Node 24's `process.availableMemory()` once before
native rendering, preserving the former strict estimate of 1000 bytes per pixel
plus a 2,000,000,000-byte reserve. Equality or an invalid sample refuses; other
cache/thread decisions retain Remotion's upstream sampler. The removed upstream
admission module is not patched or recreated. The actual inputs and decision
remain in the renderer log, and a streaming refusal survives secondary
browser-cleanup errors. Admission is not an OOM diagnosis or a peak-memory
guarantee.

The final film is 1920×1080/60 fps with at most 1.5× zoom. Full-frame footage,
the enhanced pointer, real click feedback and brief phrase captions share one
camera. Pointer, feedback and caption sizes stay constant through zoom. Captions
must fit without silent shrinking or omission; portable VTT remains complete.

Narrated finishing uses two-pass loudness normalization and measures final AAC:
−16 LUFS ±0.5 LU, true peak at most −1 dBTP. Silent films skip loudness
acceptance. Timing stays unchanged. Media-process supervision renews budgets
only on observed work advancement; unchanged chatter is not progress. Retained
phase snapshots and rendered-frame counts do not prove current process liveness
or bundle readiness. Timeouts/cancellation preserve process custody and diagnostics.

The local bundle contains MP4, poster, VTT, canonical text, edit, QA, provenance,
checksums, review page and selected original deliverables. Native controls,
seekable transcript and a copyable feedback position center the film. The fixed
local review script escapes content and uses no remote assets or telemetry.

## Storage and inspection

Successful composition verifies bundle, edit, sources and audio before removing
known regenerable staging, renderer bundle, master and decoded QA scratch.
`project compact` applies that same bounded operation to an exact older completed
or settled failed composition, or a failed non-current preview. Failed work needs
recorded failure and resolved
custody; sole encoded outputs and diagnostics remain. Compaction never retires
whole projects or superseded films. A storage failure does not change verified
film lifecycle.

One successful current preview replaces the prior unchanged owned preview only
after new output/provenance verify. Failed replacement keeps the old current
sample; foreign or modified material is preserved. There is no age-based sweep.
Failed-preview compaction shares the preview ownership lock, leaves active/current
metadata intact, and verifies the full edit and range against its measured
narration subset. Project inspection pages retained preview IDs; exact inspection
reports the original failure without claiming process liveness.
Independent file copies attempt native copy-on-write with byte-copy fallback,
not hardlinks or a measured physical-space guarantee.

Inspection distinguishes retained lifecycle, current byte availability,
integrity and observed process state. `awaiting-human-review` does not mean
acceptance. Automated checks reject bounded defects; full viewing, listening
and viewer comprehension remain separate [quality gates](QUALITY.md).
