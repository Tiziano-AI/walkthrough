# Browser and film authoring

Use one generic browser session to explore and record a real web product, then
compose a film from sealed local sources. The author chooses the journey and
actual browser input. A new product needs no adapter, executable scenario,
request classifier, selector package or application API script.

Check `walkthrough --version --json` and `walkthrough help --json` against the
runtime actually installed. Both are read-only discovery: they write no
operational state and do not start the supervisor. Installation and prerequisites
are in [README](../README.md); film standards are in [QUALITY](../QUALITY.md).

## Select the authoring setup

The plugin provides authoring guidance; the independently installed CLI owns
browser and media work. Use `setup inspect` before first production or after a
prerequisite changes. It distinguishes absent prerequisites, unselected
configuration, drift and an interrupted setup transaction.

```sh
walkthrough setup inspect --json
walkthrough help setup --json
walkthrough setup prepare --candidate /absolute/new-setup-candidate.json --input /absolute/setup-input.json --json
walkthrough setup apply --candidate /absolute/new-setup-candidate.json --sha256 <candidateSha256> --json
```

Read the installed help for the setup input schema. Supply installed tool and
Voices paths, a provisioned narrator and the operator's explicit Remotion
eligibility assertion. Preparation verifies actual identities and writes an
unselected candidate, not an active configuration. Review it and use its returned
digest with apply. Apply verifies tools, assets and previous selected records
again before selection. Rejoin an interrupted selection with the same candidate
and digest. Neither setup operation installs models, creates voices or changes
shared tools; the operator's license assertion cannot be inferred from someone
else's setup. Explicit CLI installation, not production, acquires pinned npm
dependencies and the browser.

## Create an independent project

Keep a `.walkthrough` directory outside the checkout and installed release. It
retains the brief, sessions, takes, source sets, edits, compositions and previews.
Use absolute paths in calls. The creator supplies the intent and authority; the
author turns those into a project brief, not a technical questionnaire.

```json
{
  "title": "Introduce a web product",
  "brief": "Show how its main capabilities fit together.",
  "audience": "New users",
  "mandate": {
    "applicationUrl": "https://example.com/",
    "navigationOrigins": ["https://example.com"],
    "network": "web",
    "allowedEffects": "Create fictional local content; no publication or sharing.",
    "dataDescription": "Fictional content only.",
    "inputRoots": [],
    "mediaReview": "agent-reviewable-synthetic",
    "delivery": "local"
  }
}
```

Replace the example URL and scope with the authorized product. Origins are exact
HTTP(S) origins, including the application URL's origin. They constrain document
navigation, not ordinary API or subresource traffic. `web` is ordinary browser
HTTP(S) networking, including nonstandard ports, not exact-host isolation; use
`loopback-only` for strictly local
targets. `allowedEffects` records the creator's mandate for the author, not a
machine-certified semantic filter. The runtime cannot tell whether every click
is a save, message or purchase.

Choose `agent-reviewable-synthetic` only for admitted synthetic evidence and
`agent-reviewable` for admitted real evidence. `private-local` material cannot
be exposed to a hosted author through observations, actions or media inspection.
Review permission and publication authority are independent. Authentication
profiles and credentials never belong in the project or brief.

```sh
walkthrough project create --path /absolute/product-film.walkthrough --brief /absolute/brief.json --json
walkthrough project inspect --project /absolute/product-film.walkthrough --json
walkthrough doctor --phase capture --json
walkthrough session open --project /absolute/product-film.walkthrough --id exploration --headed --json
```

Session opening defaults to headless; `--headed` exposes the browser for a human
handoff or supervised use. An optional `--profile /absolute/private-profile`
must stay outside the project. The session worker keeps browser and recording
alive between commands. It is bounded to this session, not a permanent service.
Reusing an opening ID checks that same launch/configuration; it does not promise
to restart a dead browser.

If opening is interrupted, inspect and close the original session ID. These
operations can settle the same launch when process evidence proves it stopped,
including an interruption before worker registration. They never restart a
browser to conceal the failed launch. Preserve unresolved custody and follow the
returned recovery rather than removing session records manually.

`session open` returns the original resolved absolute `result.profileDirectory`;
`session inspect` exposes it as `result.session.profileDirectory`, including
after closure. New sessions retain this identity before launching the browser.
For older sessions, inspection uses retained configuration and the original
socket location, never today's state root. If that evidence cannot establish
the profile, the field is `null`: restore the exact original records rather
than guessing. This lookup does not read profile contents or rewrite historical
records to add the field.

To reuse browser storage, first close the original session, then open a **new
session ID** with the returned profile path:

```sh
walkthrough session inspect --project /absolute/product-film.walkthrough --session exploration --json
walkthrough session close --project /absolute/product-film.walkthrough --session exploration --json
walkthrough session open --project /absolute/product-film.walkthrough --id recording --profile /absolute/path-returned-by-inspect --headed --json
```

Profile reuse does not establish that login is still valid or authorize signing
in. Use the off-camera authentication handoff when authorized. See
`walkthrough help session --json` for this lifecycle.

## Observe, choose input, observe the response

```sh
walkthrough observe --project /absolute/product-film.walkthrough --session exploration --json
walkthrough act --project /absolute/product-film.walkthrough --session exploration --id open-workspace --input /absolute/action.json --json
```

An observation returns page/frame/document identities, element `refs`, a
`surfaceId`, CSS viewport dimensions, a native-pixel screenshot, visible text and
browser events. `--page` chooses the page for a fresh observation. Use the latest
actual evidence, not a guessed selector. Reobserve after a page or document
changes; a stale reference is not retargeted to a replacement element.

`--limit` accepts 1–1000 references per response. To read more of the **same
retained snapshot**, pass its `observationId` as `--observation` and its
`nextOffset` as `--offset`; do not combine this with `--page`. This returns the
same observation and screenshot, not a new view of the current application.
`refsTotal` counts retained references; `refsTruncated` means collection hit its
2000-reference cap. `nextOffset` identifies another available page. The broader
`truncated` flag may mean either paging or the collection cap: exhausting pages
cannot recover references omitted by that cap. Reobserve for current state,
including after acting; paging never refreshes evidence.

Select controls expose `multiple` and the first 20 `options`, each with its
exact `value`, display `label`, `index`, `disabled` and `selected` state. Use
the value for `act select`; labels need not equal values. For remaining options:

```sh
walkthrough observe --project /absolute/product-film.walkthrough --session exploration --observation <observation-id> --ref <select-ref> --offset <optionsNextOffset> --limit 100 --json
```

This pages the selected control in the same snapshot. `optionsTotal` is the
DOM count; `optionsRetainedTotal` is the count retained for this control;
`optionsTruncated` means the snapshot's shared collection limit was reached
(2,000 options or 250,000 value/label characters). Values and labels remain
whole. `optionsNextOffset` exists only for retained options still to read.
The broader observation `truncated` flag includes option paging and collection
limits. Reobserve rather than infer current selection from an old snapshot.

Each `act` input is one action object. These examples show the supported kinds:

| Action | JSON input |
| --- | --- |
| Navigate | `{"kind":"navigate","url":"https://example.com/"}` |
| Select a popup/page | `{"kind":"select-page","pageId":"<observed-page>"}` |
| Click | `{"kind":"click","target":{"ref":"<observed-ref>"}}` |
| Shift-click | `{"kind":"click","target":{"ref":"<observed-ref>"},"modifiers":["Shift"]}` |
| Hover | `{"kind":"hover","target":{"ref":"<observed-ref>"}}` |
| Text | `{"kind":"text","target":{"ref":"<observed-ref>"},"text":"Example","mode":"type"}` |
| Select an option | `{"kind":"select","target":{"ref":"<observed-ref>"},"values":["<option-value>"]}` |
| Keyboard | `{"kind":"keys","keys":"ControlOrMeta+Z"}` |
| Wheel | `{"kind":"wheel","target":{"surfaceId":"<observed-surface>","x":800,"y":450},"deltaX":0,"deltaY":400}` |
| Drag | `{"kind":"drag","from":{"surfaceId":"<observed-surface>","x":400,"y":300},"to":{"surfaceId":"<observed-surface>","x":700,"y":500}}` |
| Upload | `{"kind":"upload","target":{"ref":"<observed-ref>"},"paths":["/absolute/admitted-input.json"]}` |
| Dialog | `{"kind":"dialog","dialogId":"<observed-dialog>","response":"accept"}` |

Click and drag accept `modifiers` from `Alt`, `Control`, `Meta`, and `Shift`,
without duplicates. Keys are held for that action and released on completion,
failure or cancellation. A separate `keys` action does not leave a modifier
held for a later click.

Use `surfaceId` plus **CSS viewport pixels** for canvas/WebGL or visual targets.
The observation declares `coordinateSpace:"css"`; its `width`/`height` describe
the 1600×900 CSS viewport. `screenshotPixels:{width,height}` describes the native
3200×1800 image. Convert an image point with
`xCSS = xImage * width / screenshotPixels.width` and the corresponding height
ratio for Y; do not send bitmap coordinates as CSS input. If your viewer resized
the image, account for that displayed size first. Element references and surface targets
are alternatives for click, hover, text, wheel, drag and targeted keys. Keyboard
input without a target uses current focus. Text modes are `type`, `insert` and
`replace`; these are not credential-entry methods. Click supports `button` and
`clickCount`; drag supports `button`, `modifiers` and `durationMs`. Dialogs accept
or dismiss; a prompt may include `promptText`.

Uploads select exactly one source form: `paths` under the mandate's admitted
`inputRoots`; `artifactIds` for downloads retained in the current session; or
`sourceArtifacts:[{"sourceSetId":"<sealed-id>","artifactId":"<artifact-id>"}]`
for artifacts sealed in this project, including earlier-session
exports. The runtime verifies retained artifact bytes and hashes before upload.
Keep both source-set and artifact identities for a sealed export; do not
manufacture equivalent content or copy it into an input root to bypass custody.

The upload target is an observed file input (including a hidden input), or a
visible control that opens a standard input-backed file chooser. Supply the
files with that control in one `upload` action, rather than clicking it first.
The runtime verifies the bytes, arms the chooser, then uses its normal timed
pointer click and selects the files. This also supports inputs that the
application creates only after the click. A missing chooser or failed selection
after the click leaves the original attempt uncertain: inspect it and observe
the application, without replaying under a new action ID.

Native filesystem picker APIs (`showOpenFilePicker`, `showSaveFilePicker` and
`showDirectoryPicker`) are unavailable in the session browser. Products
can use their standard download and input-backed chooser fallbacks; origin-private storage
(OPFS) remains available. A product requiring native pickers without a fallback
cannot complete that flow here. A completed click alone is not an exported file.

Ordinary popups are listed and never silently replace the recorded page. Select
one explicitly; selecting another ordinary page ends the preceding take. Native
print uses the separate lifecycle below because print can suspend the product
page. Start a new take when the intended page is ready. There is no arbitrary
`evaluate`, caller script or direct application-API escape hatch.

Every command emits one JSON record. Success reports scope identities, its
result and a next step; failures carry an error code, owner and recovery.
Structured operation inputs may use `--data '<JSON>'` instead of `--input`;
do not supply both. Project briefs use `--brief`, edits use `--edit`.

## Follow native print through to its retained PDF

Native print requires version 0.3.4 or later. Check the installed runtime's
`--version --json` and `help act` before use. The source page, native preview and
retained-file viewer are separate captured surfaces; use cuts between them.
Every take still needs its own source-clock qualification, and retaining a PDF
does not establish that the film shows its contents clearly.

1. Observe the product's print control and dispatch its genuine input with
   `expectPrintPreview:true` on `click` or `keys`. The runtime records the
   existing targets first and requires exactly one newly observed Chrome native
   preview in the same browser context. Binding is
   `exclusive-action-and-browser-context`: it associates this expected action
   with the new preview, not a browser-proved opener relationship. Do not use
   concurrent manual browser input during this operation. A missing or ambiguous
   preview leaves the source blocked: inspect the original action and close the
   session without printing again. Input completion remains tracked even after
   discovery fails. The action's `result.print` retains independent `input` and
   `discovery` states and errors, including when both fail. An intervening
   JavaScript dialog retains the same discovery
   attempt; if that bounded discovery expires before the answer, the session
   likewise requires close rather than another input.
2. Find the `native-print` page in returned pages/events with its source action
   and page identities. Use `select-page` explicitly, then `observe` that preview
   to read its geometry, completed-generation evidence and settings visible in
   the screenshot. The structured generation includes the settings-ticket hash,
   not a separate list of settings. The preview is read-only through typed input:
   native settings automation, clicking
   native Save and OS chooser control are unavailable. `capture start`, `mark`
   and `stop` can record this surface. Use observed geometry rather than assume
   the ordinary page's viewport.
3. When a fresh observation shows the latest generation is complete, call
   `save-print-preview` with its `pageId`, `observationId` and a PDF `filename`.
   The filename is a basename of at most 180 characters, ends in `.pdf`
   (case-insensitive), and contains no leading dot, slash, backslash or control
   characters. Ordinary spaces and Unicode are permitted. The runtime retrieves
   the full `/-1/` PDF from the observed related untrusted preview child, using
   that generation and those settings, and rechecks the generation before and
   after retrieval. It retains the exact bytes through ordinary download
   artifact custody and returns `artifactId`. It does not synthesize a second
   PDF, click Save, close the preview or open a viewer. If the generation or
   settings changed, observe again; an earlier observation cannot approve the
   changed output.
4. Call `close-print-preview` for that `pageId`. This deliberately stops any
   preview take and closes the preview, lets the suspended original input
   settle, and closes the parked product take. The source product page becomes
   selected with capture off. Inspect the original print action to establish its
   outcome; closing does not save a PDF.
5. Call `open-artifact` with the retained `artifactId` to show the saved PDF.
   This accepts only an existing PDF from the same session, verifies its exact
   bytes and hash, and opens Chrome's PDF viewer. The result returns `pageId`
   and `artifactId` and selects the viewer with capture off. Observe it before
   starting another take. Saving and opening are separate operations: viewer
   failure leaves the retained PDF available to inspect, seal and deliver.

These are action payloads for `act`, each with its own stable `--id`:

| Action | JSON input |
| --- | --- |
| Product print control | `{"kind":"click","target":{"ref":"<observed-print-control>"},"expectPrintPreview":true}` |
| Print keyboard shortcut | `{"kind":"keys","keys":"ControlOrMeta+P","expectPrintPreview":true}` |
| Select native preview | `{"kind":"select-page","pageId":"<observed-native-print-page>"}` |
| Retain observed PDF | `{"kind":"save-print-preview","pageId":"<observed-native-print-page>","observationId":"<latest-completed-print-observation>","filename":"Report.pdf"}` |
| Close native preview | `{"kind":"close-print-preview","pageId":"<observed-native-print-page>"}` |
| Open retained PDF | `{"kind":"open-artifact","artifactId":"<same-session-retained-pdf>"}` |

The click and keyboard examples are alternatives, not two print attempts. Reuse
the original action ID to inspect or rejoin any lost response; recovery never
replays print. While print suspends the source page, its take stays parked. The
product and native preview retain distinct calibrated takes: edit an explicit
cut between them and omit the suspended source interval. A reopened PDF viewer
is another observed surface and another take, not a continuation of the source
page's clock. Seal the actual PDF artifact alongside the selected stopped takes.

## Preserve original attempts

Choose an action ID before dispatch. The runtime retains its exact payload and
dispatch state; repeating that ID with the same payload retrieves the original
attempt, while a changed payload conflicts. This suppresses duplicate input
attempts, not application/server retries or effects.

| Recorded state | Meaning |
| --- | --- |
| `not-dispatched` | The runtime did not enter input dispatch |
| `input-completed` | Browser input finished; application success is not established |
| `outcome-uncertain` | Input may have happened and its response/custody failed |

After a lost response, inspect the original ID. Observe the permitted application
state or consult its owner before dependent work. A timeout is not cancellation,
and a new action ID is not a recovery method for an uncertain effect.

```sh
walkthrough action inspect --project /absolute/product-film.walkthrough --session exploration --id open-workspace --json
walkthrough action resolve --project /absolute/product-film.walkthrough --session exploration --id open-workspace --input /absolute/resolution.json --json
```

```json
{"outcome":"effect-observed","note":"Describe the actual observed state supporting this judgment."}
```

Resolution also accepts `no-effect-observed` and `uncertain`. It adds the
author's evidence separately from dispatch history; it neither sends input nor
certifies server reconciliation. Retain failures and original operation IDs.

## Authentication off camera

```sh
walkthrough session handoff --project /absolute/product-film.walkthrough --session exploration --id authentication-handoff --json
walkthrough session resume --project /absolute/product-film.walkthrough --session exploration --id authentication-resume --json
```

Confirm the handoff's outcome before the human enters credentials. It stops
capture and invalidates input/observation handles. Observations and ordinary
actions are unavailable while authentication is handed off. Resume returns
off camera with old handles cleared; observe the allowed public application
afresh before starting another take. This does not lift an application owner's
hold or authorize additional effects/origins.

## Record useful takes and seal their sources

```sh
walkthrough capture start --project /absolute/product-film.walkthrough --session exploration --id start-main-take --data '{"title":"Explore the main workspace"}' --json
walkthrough capture mark --project /absolute/product-film.walkthrough --session exploration --id mark-visible-result --data '{"title":"Visible result","settled":true}' --json
walkthrough capture stop --project /absolute/product-film.walkthrough --session exploration --id stop-main-take --json
walkthrough artifact list --project /absolute/product-film.walkthrough --session exploration --json
```

Recording continues between calls: perform real actions and observe their
responses, marking useful states. Each start, mark and stop has its stable
operation ID; a lost response rejoins that ID instead of creating a replacement.
A mark requires a readable title and can name an `id` and a `target`
for later framing. Obtain a fresh observation of the recorded page immediately
before marking; the two supported target forms are:

```json
{"title":"Result panel","target":{"observationId":"<current-observation-id>","ref":"<observed-ref>"}}
```

```json
{"title":"Canvas selection","target":{"observationId":"<current-observation-id>","box":{"x":400,"y":300,"width":600,"height":400},"coordinateSpace":"screenshot"}}
```

The rectangle uses that observation's **native screenshot pixels**, not CSS
input coordinates or a resized viewer image. Raw CSS target boxes are not
accepted. The runtime verifies the same page, frame, document, viewport and
scroll state, then retains the rectangle in master-source pixels with its
observation provenance. Input or a changed view makes the framing observation
stale: observe again rather than reuse the old geometry. This is a static
framing subject, not an input handle or a target tracker. Keep the returned
mark ID and take ID for the edit: new captures preserve the mark ID through
stop and seal, and the take ID is the picture's `sourceId`. Marks are unique
within their source; the same name on another source is a different mark.
For existing sealed material, use the IDs returned by source inspection
unchanged. `settled:true` can accompany either form or a targetless
mark; it samples actual pixel stability but does not attest application success
or make a spinner an appropriate reading hold.

Stop retains calibrated footage, the usable interval excluding calibration,
pointer/input evidence and marks. Inspect the returned stopped take before
selecting it. In-flight bytes may be unavailable after process loss; do not
promote an unfinished recording into a completed source.

If recorder start fails, the original session becomes `interrupted`: a rejected
start does not establish that recording stopped. Rejoin the same capture
operation ID to read its retained error, then close that original session before
any further observation, input or capture. Do not remove a guessed slate, retry
start under a new ID or treat the failure as proof that no recorder started.
Pre-dispatch refusals, such as an already active take, do not interrupt an
otherwise usable session.

If stop failed after the recorder finished, close that original session, then
run `capture recover --project <path> --take <failed-take-id> --json`. Recovery
qualifies the same media and calibration offline and enables ordinary sealing;
it opens no browser and does not retry the stop operation. The failed take
record, prior diagnostics and original capture operations remain retained. Each
recovery analysis has its own file, including a failed analysis; successful
recovery identifies the exact analysis that sealing retains. Missing or ambiguous
calibration fails precisely rather than producing replacement footage. Older
takes without a retained capture window expose a conservative interval from
their measured input/marks, excluding slate frames; inspect `usableRange`.

A seal selection names stopped takes and any useful retained session downloads:

```json
{
  "takeIds": ["<stopped-take-id>"],
  "artifacts": [
    {
      "sessionId": "exploration",
      "artifactId": "<retained-download-id>",
      "title": "Saved scenario",
      "role": "deliverable"
    }
  ]
}
```

`artifacts` may be empty. `source` retains an artifact without delivering it;
`deliverable` includes it in the bundle. The CLI obtains actual paths and hashes
from retained download records, not caller-supplied replacements.

```sh
walkthrough capture seal --project /absolute/product-film.walkthrough --input /absolute/selection.json --json
walkthrough inspect --project /absolute/product-film.walkthrough --source-set <source-set-id> --json
walkthrough session close --project /absolute/product-film.walkthrough --session exploration --json
```

The seal verifies original bytes and supporting records and explicitly records
`applicationSuccess:"not-attested"`. Close releases session custody; inspect
the original session if closure is uncertain. Do not delete activity records to
bypass an unfinished worker or unblock an installation.

Use `artifact list` across a project, session or source set; `artifact inspect`
requires one `--session` or `--source-set` and an `--id`. `inspect --take` reads
the retained take summary; `session inspect` distinguishes recorded state from
current worker liveness. Project/artifact lists support `--limit` from 1 to 100
and `--offset <nextOffset>`; follow each returned list's total and continuation
rather than treating its first page as complete.

Source-set inspection is paged too, with `--limit` from 1 to 1000 and `--offset`.
Select `--section sources|marks|artifacts|records` for one retained collection.
Source summaries report `pointerSamples`, not the whole trajectory; read actual
samples with `--section pointer --source <source-id>` and follow `nextOffset`.
This bounds output without removing retained evidence:

```sh
walkthrough inspect --project /absolute/product-film.walkthrough --source-set <source-set-id> --section marks --limit 100 --json
walkthrough inspect --project /absolute/product-film.walkthrough --source-set <source-set-id> --section pointer --source <source-id> --limit 100 --json
```

## Compose independent picture and narration tracks

Use source identities, usable ranges, settled marks and SHA-256 from inspection.
The following is an **illustrative construction**, not recorded occurrence
evidence or a valid edit for an arbitrary acquisition. Installed `help edit`
returns this same example and its source-moment explanation. Suppose inspection
locates an overview at source 2, a drag at 5, its readable response at 9 and the
same object's next capability at 12. The resulting picture track lasts 16
seconds. Replace every identity, time and target with the inspected material;
measure the speech rather than assuming these placements fit.

```json
{
  "schemaVersion": 1,
  "sourceSetId": "<sealed-id>",
  "sourceSetSha256": "<sealed-sha256>",
  "title": "Arrange and inspect the workspace",
  "brief": "Introduce connected capabilities through the same object",
  "voiceId": "narrator",
  "language": "English",
  "pictures": [
    {
      "id": "orientation",
      "sourceId": "source-direction",
      "kind": "live",
      "transition": "cut",
      "startSeconds": 2,
      "endSeconds": 5,
      "zoom": 1,
      "target": null,
      "cameraMove": {
        "startSeconds": 0.2,
        "durationSeconds": 1.2,
        "zoom": 1.3,
        "target": {
          "markId": "subject-before"
        }
      },
      "captionPlacement": {
        "x": 360,
        "y": 948,
        "width": 1200
      }
    },
    {
      "id": "gesture",
      "sourceId": "source-direction",
      "kind": "live",
      "transition": "continuous",
      "startSeconds": 5,
      "endSeconds": 9,
      "zoom": 1.3,
      "target": {
        "markId": "subject-before"
      },
      "captionPlacement": {
        "x": 360,
        "y": 948,
        "width": 1200
      }
    },
    {
      "id": "response",
      "sourceId": "source-direction",
      "kind": "live",
      "transition": "continuous",
      "startSeconds": 9,
      "endSeconds": 12,
      "zoom": 1.3,
      "target": {
        "markId": "subject-before"
      },
      "emphasis": [
        {
          "id": "preserved-connection",
          "kind": "outline",
          "target": {
            "markId": "connection-response"
          },
          "startSeconds": 0.4,
          "endSeconds": 1.6
        }
      ],
      "captionPlacement": {
        "x": 360,
        "y": 948,
        "width": 1200
      }
    },
    {
      "id": "next",
      "sourceId": "source-direction",
      "kind": "live",
      "transition": "continuous",
      "startSeconds": 12,
      "endSeconds": 18,
      "zoom": 1.3,
      "target": {
        "markId": "subject-before"
      },
      "cameraMove": {
        "startSeconds": 0,
        "durationSeconds": 1.2,
        "zoom": 1,
        "target": null
      },
      "captionPlacement": {
        "x": 360,
        "y": 948,
        "width": 1200
      }
    }
  ],
  "narration": [
    {
      "id": "arrange",
      "text": "Arrange the workspace without losing the connections.",
      "outputStartSeconds": 0
    },
    {
      "id": "inspect",
      "text": "Open the same object to work on its contents.",
      "outputStartSeconds": 8.6
    }
  ]
}
```

The camera approaches the connected objects before the drag and stays settled
for gesture and response. The outline briefly identifies the preserved
connection; it does not pretend the application selected it. The second thought
starts during the response and crosses the next picture boundary. Widening
reveals context before the new contents need attention. `next-capability` is an
illustrative source anchor, not a mandatory framing target. The caption strip is
only an example: choose its position against the real subject.

Pictures play in array order and determine film length. Each live picture uses
source start/end at 1×. A hold uses `kind:"hold"`, `startSeconds`,
`durationSeconds` and `settledObservationId` instead of `endSeconds`; its frame
must lie within that named mark's settled interval. Use `transition:"continuous"`
only where the actual adjacent source selection preserves continuity.

Picture boundaries, hold lengths, camera timing and narration starts lie on
the 60 fps grid (`frame / 60`). `target` accepts `null`, a rectangle
`{x,y,width,height}` in **3200×1800 master pixels**, or
`{"markId":"<sealed-mark-id>"}`. A mark reference must resolve to exactly one
targeted mark on the picture's exact source; missing, ambiguous or wrong-source
marks fail. Resolution is offline and leaves original source/edit bytes
unchanged. `captionPlacement` uses **1920×1080 output pixels**. Zoom is 1–1.5.
An optional `cameraMove` contains `startSeconds`, `durationSeconds`, `zoom` and
`target`, using the same target forms and timing relative to that picture.
Choose a readable subject and settle framing for the action. Place short
captions away from the explained controls
and evidence, not in a permanent rail.

Optional `picture.emphasis` contains `{id,kind,target,startSeconds,endSeconds}`.
`kind` is `outline` or `spotlight`; `target` is a non-null source box or sealed
mark. Its interval is local to the picture, frame-aligned, inclusive at the
start and exclusive at the end. Several outlines can compare subjects, but
spotlights cannot overlap. The restrained outline and mild surrounding dimming
fade briefly with fixed output-pixel stroke size through camera movement.
Targets are static observed geometry, not object tracking. The layers sit above
footage and below actual pointer feedback and captions. Use emphasis to locate
an important response, not as decoration or substitute for readable footage.

Structurally impossible caption placements fail validation before synthesis.
After audio measurement, a cue that does not fit returns
`FILM_CAPTION_DOES_NOT_FIT` with its picture, phrase and placement in
`error.caption`. Captions intersecting an explicitly declared subject return
`FILM_CAPTION_SUBJECT_OVERLAP`, including the output frame and projected boxes.
The check uses the actual caption boxes while each cue is visible, including
camera movement and active emphasis; a null target does not infer a subject
from the image. Emphasis failures identify `emphasisId` alongside the picture
and affected frame.
Revise placement, text or framing and reuse the sealed sources and unchanged
speech. These checks cannot decide which other product content the viewer needs
to see: inspect the finished picture too.

Narration is chronological and independently placed on the output timeline.
Speech may cross cuts. Actual audio cannot overlap another phrase or exceed
the picture track. Revise text, placement, pictures or an explicit settled hold;
the engine will not pad pictures or accelerate speech. Unchanged compatible
narration is reused when framing/captions change. No voice audition is needed.

Set `language` explicitly to `English` or `Italian` in new edits; omitted
historical language means English without rewriting the retained edit. Set
`voiceId` to a voice included in the reviewed audio provision. Use the operator's
saved narrator by default; selecting another provisioned voice does not install
or modify its shared reference assets. The illustrative `narrator` ID above must
be replaced with that selected voice's actual ID. Language follows
the text through synthesis, alignment, captions and independent ASR, and is
part of each corresponding cache identity.

```sh
walkthrough validate --project /absolute/product-film.walkthrough --edit /absolute/edit.json --json
walkthrough doctor --phase compose --json
walkthrough compose --project /absolute/product-film.walkthrough --edit /absolute/edit.json --json
walkthrough inspect --project /absolute/product-film.walkthrough --composition <composition-id> --json
```

Validation checks exact source/edit structure without opening an app or
synthesizing audio. Blocking `objectiveErrors` are separate from nonblocking
`editorialObservations`. The latter flag a camera move during a retained gesture
or a whole-film `NARRATION_GAP`, including intervals crossing cuts. Complete
resolved word timings expose gaps within the WAV; missing timings conservatively
cover its measured duration, and unmeasured speech leaves silence unresolved.
The report names this timing basis: alignment-derived gaps are not measured
acoustic silence or proof of a perceptual defect. Pointer/mark activity supplies
context and never suppresses a gap. Neighboring words, picture/source ranges,
camera, emphasis, gestures and a frame-aligned preview range make the interval
directly inspectable. Bounded collections disclose their totals and truncation.
These observations do not infer visual purpose or award a quality score. A
`requires-audio` speech-timing result is not a speech-fit pass. Composition
verifies sealed bytes, creates a new retained occurrence and uses only the local
media runtime. It does not open a profile, application or
adapter. Preserve failed compositions and repair their owning inputs.

While the original compose command runs, `inspect --composition` returns
`renderProgress`: its render-local phase, `recordedAt` and, during rendering,
actual `rendered` and `total` frame counts. `rendering-and-encoding`, `encoding`
and `muxing` describe native phases; Remotion's weighted encoding aggregate is
not reported as a count. A reread does not refresh
the timestamp or establish liveness. Progress becomes historical when the
composition leaves rendering; complete frame counts do not mean the bundle is
ready. Missing progress is valid for older compositions. Follow the original
command rather than starting another composition because an observation is old.
During `staging-sources`, `record.source` gives `index`, `total`, `stagedFrames`
and `selectedFrames`. These count the packed selected intervals, not omitted
footage or completed film frames. The runtime renews media-process budgets only
on observed work advancement; unchanged reports never keep a process alive.

When a render subprocess fails, the composition or preview's `error` retains
`causeCode`, `diagnosticPath`, and the observed `child.exitCode`/`child.signal`
when available. Read that exact local log before another offline attempt.
Launch failure has no invented child outcome; timeout remains a failure even
if the child subsequently exits cleanly. No command arguments or log contents
are copied into the public result. These diagnostics require neither new
application input nor regeneration of unchanged speech.

`inspect --composition` also returns `audioFailure`: the recorded phrase and
operation, child exit outcome, bounded provider error and local diagnostic
paths when available. An alignment failure can follow successful synthesis;
independent transcription can fail after both. Each stage has its own cache
and retained identity, so a downstream failure does not invalidate a sealed
WAV or require resynthesis. Inspect that distinction before changing text or
attempting recovery. Older occurrences may have no structured audio failure
record. Inspection does not
rerun audio or reconcile a partial segment.

An incomplete audio attempt has a separate public recovery path. Use the
`attempt.json` path retained with its failure:

```sh
walkthrough audio attempt inspect --attempt /absolute/attempt.json --json
walkthrough audio attempt resolve --attempt /absolute/attempt.json --resolution adopt --note "Describe the retained evidence." --json
```

Inspect is read-only and reports stage, stable attempt identity, input/runtime
identity, process settlement, product validity and the next useful operation.
Resolve first proves the original worker and process group stopped. It adopts
valid exact products without inference, or `--resolution retry` makes only the
incomplete stage eligible for the next normal compose. Complete valid products
must be adopted rather than regenerated. Diagnostics and partial records stay;
valid upstream synthesis is not repeated for an aligner or ASR failure.

Every newly processed phrase retains an independent transcript and lexical
comparison alongside its canonical text and alignment. ASR normalizes display
punctuation, case and spacing for comparison while keeping accents, contractions,
numbers, order and lexical differences. A mismatch remains an observation; it
does not replace captions, rewrite speech or trigger a new synthesis. A match
still leaves `spokenContentVerified:false`: listen to the result.

Once speech has been measured, `narrationFit` reports whether its placements
fit the picture track. A rejected `compose` returns the first 20 conflicting
phrases in `narrationFitDiagnostics`; the full measurements remain in
`narration-fit.json`. Default inspection of a failed composition shows conflicts.
Read all measurements, including phrases that fit, with:

```sh
walkthrough inspect --project /absolute/product-film.walkthrough --composition <composition-id> --section narration-fit --limit 20 --offset 0 --json
```

Each measure names the phrase, placed start, natural audio duration/end,
frame-rounded occupied duration/end, next phrase and picture end.
`requiredClearanceSeconds` is the local overlap or overrun at that boundary,
not a cumulative retiming prescription. Choose whether to move, shorten or
cut; the runtime does not add padding. Follow `record.phrases.nextOffset`
for the next page. Older occurrences report `not-recorded`. This inspection
does not open the app, load source media or synthesize speech.

Read measured editorial observations separately:

```sh
walkthrough inspect --project /absolute/product-film.walkthrough --composition <composition-id> --section editorial --limit 20 --offset 0 --json
```

`editorialObservations.items` is a bounded page of retained viewing prompts.
Follow `editorialObservations.nextOffset` until it is null; `total` and
`truncated` describe the retained collection. Inspection does not rewrite the
diagnostic. Open each reported preview range and judge the visual task rather
than treating an observation as a defect score.

### Reuse retained speech and preview an excerpt

For an offline revision, name the exact earlier composition in the same project:

```sh
walkthrough preview --project /absolute/product-film.walkthrough --edit /absolute/revised-edit.json --from 3 --to 8 --reuse-audio <composition-id> --json
walkthrough inspect --project /absolute/product-film.walkthrough --preview --json
walkthrough compose --project /absolute/product-film.walkthrough --edit /absolute/revised-edit.json --reuse-audio <composition-id> --json
```

`--reuse-audio` verifies canonical text, language, voice identity, actual WAV,
alignment and any retained ASR evidence before reusing compatible speech. Phrase IDs
may change; speech identity determines compatibility. When all required phrases
match and verify, revision is fully offline: no installed current or historical
Voices runtime, current audio provision or new ASR is required. New or
incompatible phrases may process through current setup, so this flag is not a
universal no-synthesis mode. A matching but corrupted retained artifact fails
rather than silently producing a replacement. Retained audio and analysis keep
their original generation, alignment and ASR identities across runtime changes.

`--from` and `--to` must be ordered, on the 60 fps frame grid and within the
picture track. The range is exactly half-open: `--from 3 --to 8` renders
`[3,8)`, excluding the frame at 8. The renderer keeps the original composition
clock for pictures, camera moves, narration and captions. Speech that starts
before 3 and is still audible belongs in the excerpt; potentially overlapping
speech is measured, never omitted using a guessed duration. Preview does not
open the application or create a full-film delivery bundle.

An excerpt retains source gain without its own loudness normalization.
`audioLoudness.status:"not-evaluated-preview"` means loudness was not evaluated
for that excerpt, not that it passed a delivery gate. This permits short or
silent ranges and avoids changing gain whenever the chosen range changes.
Assess the complete film's mastered level separately.

Previews live separately under `previews/preview-<uuid>`. Before a successful
excerpt becomes current, its MP4 is copied and hashed, its manifest/provenance
are completed, and known regenerable render assets, bundle, master and duplicate
output/poster are removed. `previews/current.json` then atomically selects it;
the excerpt, edit, narration, provenance and diagnostics remain. The previous
successful preview's exact digest-checked owned-file inventory is then deleted, **not moved to the
Trash**. Changed or foreign previous material is preserved, and `publication`
reports its retirement as `retained`. A failed replacement leaves the previous
successful preview current and retains the failed attempt's scratch and
diagnostics. No source set or composition is retired by this operation.

The preview command returns its exact ID. To inspect a retained failed attempt
or other retained preview rather than the current one:

```sh
walkthrough inspect --project /absolute/product-film.walkthrough --preview <preview-id> --json
```

Inspection reports retained lifecycle, with `processLiveness:"not-observed"`.
For a ready preview, `integrityScope:"preview-video-sha256"` verifies only the
MP4 hash, not every provenance file. A preview is a sample to watch and listen
to; it does not establish full-film acceptance.

### Review and retain the finished film

The bundle provides MP4, poster, complete VTT, canonical text, edit, QA,
provenance, checksums and selected original deliverables. Its local review page
centers native playback, seekable transcript and feedback position, with no
remote feedback submission or duplicate caption layer. Inspect current bundle
integrity, then watch and listen at normal speed. `awaiting-human-review` is not
human acceptance, and source tests cannot qualify the film's flow.

For a complete narrated film, finishing measures the mix, applies two-pass
normalization and measures the final encoded AAC. Delivery must reach −16 LUFS
integrated loudness within ±0.5 LU, with true peak at most −1 dBTP. The retained
media metrics report measurements and acceptance; an unmeasurable or
nonconforming result fails with diagnostics. Neither this gate nor a matching
independent transcript establishes intelligibility or listening acceptance.

The transcript retains millisecond cue labels and seeks to those same media
times. Copy timestamp preserves the media clock and reports the nearest 60 fps
**output edit boundary**, with exact numeric seconds usable for narration
placement. Source cut coordinates still require mapping through the edit;
a rounded VTT timestamp is not necessarily on the frame grid.

Present `walkthrough.mp4` directly to the creator. The review and companion
files remain in the project for feedback or a fuller requested handoff.
Successful composition removes known regenerable scratch only after verifying
delivery and sealed inputs. Use the same command for an older completed
composition or, after inspecting a failed render and settling its command/session
custody, its exact failed composition or failed non-current preview:

```sh
walkthrough project compact --project /absolute/product-film.walkthrough --composition <composition-id> --json
walkthrough project compact --project /absolute/product-film.walkthrough --preview <failed-preview-id> --json
```

Choose exactly one target flag. `project inspect` pages retained preview IDs;
`inspect --project PATH --preview ID` reads that attempt's error and diagnostics.
The command opens no app and performs no synthesis or rendering. Failed admission
requires `status:failed` and a recorded error. Before removing staging, renderer
bundle, `master.mov` or decoded samples, it verifies the exact edit, sealed
sources and retained audio. Original sources, edits, audio, diagnostics and any
sole `render/walkthrough.mp4` or `render/poster.png` stay. An early failure with
no render scratch returns `already-compact`; it needs no invented render receipts.
Live or unresolved command/session custody, changed required bytes and unexpected
scratch layouts are refused. Completed compositions still require verified final
delivery and matching duplicate hashes. Failed cleanup is never automatic.
Preview admission also verifies its exact range and measured narration selection;
later phrases outside that selection need no fabricated audio. It shares the
preview ownership lock, preserves active/current metadata and refuses the current
sample. A copied `preview.mp4` and sole failed renderer outputs remain.

Retained media copies attempt native copy-on-write and fall back to independent
byte copies where unsupported; files remain separately mutable with unchanged
layouts and hashes. Neither this optimization nor `removedLogicalBytes` measures
physical APFS savings: that field counts removed file lengths. A separate storage
failure does not invalidate a completed film. Compaction does not delete whole
projects or superseded films. Originals enable revisions; they do not require
keeping every test movie indefinitely or recreating a creator-retired film.

An editorial defect is repaired from these retained sources. Only a genuinely
missing view may justify new authorized observation of the same result, never
an automatic repeat of its creation. See `walkthrough help recovery --json`
for original-action resolution and [SECURITY](../SECURITY.md) for authority,
network and retention boundaries.
