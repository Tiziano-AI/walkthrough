# Author through the real browser

The browser surface is the product-independent tool for exploration and
recording. The agent supplies judgment; the runtime supplies observed targets,
real input, action custody, retained files and capture. Do not replace that
relationship with a generated site script, adapter or direct application API.

## Establish the project and session

Use installed command help for the project brief schema and the relevant
operation. Resolve the actual application URL, permitted navigation origins,
existing data, allowed effects, input roots and evidence-review class from the
creator's request and application owner. State a material assumption once;
ask about a missing consequential choice instead of asking the creator to
author technical fields. A descriptive effect limit is the agent's mandate,
not a runtime proof that every possible click is harmless.

Use `project inspect` for existing work and `project create` for a new film.
Retained source sets allow revision without reopening their application.
Creation names the destination with `--path`; operations on an
existing project carry its explicit absolute `--project` path. Use `session open`
to begin permitted browser work, and retain its
returned session identity. Inspect before reopening an interrupted session.

Read `help session` for profile reuse. `session open` returns the original
resolved absolute `result.profileDirectory`; `session inspect` returns
`result.session.profileDirectory`, including after closure. New launches retain
the path before starting the browser. For older sessions, inspection uses
retained configuration and the original socket location, never today's state
root, without reading profile contents or rewriting historical records to add
the field. `null` means the retained evidence cannot establish the path: restore
the exact original records rather than guessing.

To reuse that browser storage, close the original session and call `session open`
with a **new** `--id` and `--profile <returned-profileDirectory>`. Profiles remain
outside the project and retain the existing privacy checks. The same session ID
only inspects/rejoins its original launch/configuration; it never starts a
replacement browser. Reusing storage does not establish valid login or authorize
signing in.

Authentication belongs in `session handoff` / `session resume`, outside capture
and agent-readable input. Each operation takes its own stable `--id`; retain
that ID to reconcile a lost response rather than dispatching a replacement.
Let the user complete their own credentials or security confirmation. After
`session resume`, observe the application afresh before recording another take.
Do not copy a personal browser profile or bypass an access hold because a film
needs a logged-in view.

## Observe before choosing input

An observation supplies the page identity, readable state, element references,
visual surface identity, screenshots when requested and browser events. Use
the current observation, not remembered selectors or coordinates from another
viewport. Read only evidence whose review class admits this authoring agent.

If the reference list is paged, read the same snapshot with
`observe --observation OBSERVATIONID --offset NEXTOFFSET` plus project/session.
Do not combine it with `--page`. `refsTotal` counts retained references;
`nextOffset` continues those references, while `refsTruncated` identifies the
2000-reference collection cap. `truncated` may mean either condition. Paging
does not capture a new screenshot or refresh the application state, and cannot
recover references omitted by the cap. After input or page change, obtain a
fresh observation instead of treating another retained page as new evidence.

- Use an observed element reference for named controls, text fields, menus and
  accessible objects. Do not invent a reference from its visible label.
- Use the observation's `surfaceId` and CSS coordinates for canvas, WebGL and
  other meaningful visual targets that lack element references. Inspect the
  image first. `coordinateSpace:"css"` and `width`/`height` describe the
  1600×900 input viewport; `screenshotPixels` describes the native 3200×1800
  image. Convert image X by `width / screenshotPixels.width` and Y by the
  corresponding height ratio, accounting for any viewer resizing first. Do
  not send native image pixels as CSS input. A bounding rectangle alone does
  not identify the desired point in a chart.
- Choose real click, drag, wheel, keyboard, text, selection or file input from
  command help. For a spatial view, move enough to expose a relationship and
  inspect the resulting geometry. Do not substitute changing an internal camera
  variable for showing how the product responds to a user.

Submit one chosen input with
`act --session ID --id ACTIONID --input /absolute/path/action.json`,
together with `--project`. `--data` accepts the inline JSON alternative; never
supply both. The payload is the action itself, not an action-ID wrapper.
Read `help act` for the input shape and shipped schema. Generate the
action identity before dispatch and retain it. The identity refers to that
exact action and payload; it is not a label to recycle for a different gesture.

Observe after input, including changes caused by navigation, layout, focus,
dialogs and popups. Use newly returned references and page identities. If a
target is stale or blocked, observe and choose the right visible input; do not
force the old click or inject application state. Dismiss a dialog only after
reading what accepting or dismissing it does. A popup is another observed page,
not automatically an error or permission to broaden navigation scope.

Build the next action from the response. Selecting an item may update several
linked views; compare the actual highlighted items before moving on. On a
canvas, compare the same object's position or shape against unchanged neighbors,
not the moving pointer. If a drag leaves the object unchanged, inspect selection,
mode and target before choosing another permitted interaction. Record what the
original attempt did; a completed input or an author-written mark cannot settle
that question. For an uncertain save or other consequential effect, use recovery
rather than another attempt. A success toast
establishes what the UI reports. When the film depends on persistent saving or
a usable export, inspect the retained result needed to support that claim.

## Native print and the actual PDF

Read the installed version and `help act` before choosing native print; this
contract requires version 0.3.4 or later. Record the source page, native preview
and retained-file viewer as separate surfaces and cut between them. Each take
needs its own source-clock qualification. Show the retained document's useful
contents, rather than ending on the print control or a file-save receipt.

Use the product's actual print control or keyboard input with
`expectPrintPreview:true` on `click` or `keys`. The runtime excludes existing
targets and binds exactly one newly observed native preview in the same browser
context. This binds the exclusive expected action and context, not a
browser-proved opener relationship; no concurrent manual browser input is
permitted. Keep the original action ID even if print suspends its source page.
Never print again to recover a lost response or a missing or ambiguous preview.
After missing/ambiguous discovery, inspect the original action and close the
session: other input stays blocked. A JavaScript confirmation keeps the original
discovery attempt; answering after discovery expires does not start another one.

The preview appears as a `native-print` page in pages/events with its source
action/page. Select it explicitly, observe its screenshot, geometry and completed
generation, then capture it with ordinary start/mark/stop. Settings are visible
in the screenshot; the structured generation includes their ticket hash. Native
preview is read-only through typed input: do not automate settings, native Save
or an OS chooser. The suspended product take stays parked; the preview gets a
separate calibrated take. Cut between these takes and omit the suspended source
interval rather than portray uninterrupted recording.

Once the latest observed generation is complete, use `save-print-preview` with
its `pageId`, `observationId` and a safe `.pdf` basename in `filename`; `help act`
gives filename constraints. This retains the full PDF for those observed
settings, rechecking its generation before and after retrieval. Keep the returned
`artifactId`. A stale or incomplete observation cannot authorize another
generation: observe the preview again. Saving neither closes the preview nor
opens a viewer.

Use `close-print-preview` with its `pageId` to stop the preview take, close the
preview, let the original input settle and close its parked product take. The
source page is selected with capture off. Inspect the original print action;
reuse that ID to rejoin rather than replay it. Then `open-artifact` with the
saved `artifactId` verifies the same-session PDF's exact bytes/hash and opens
Chrome's PDF viewer, returning `pageId`/`artifactId` and selecting it with capture
off. Observe before recording that viewer. Viewer failure leaves the retained
PDF intact: inspect and seal those bytes instead of generating a replacement.

## Capture useful behavior

Exploration and filming use the same inputs. You may record exploration when
it can supply useful footage; recording does not widen its effects. Do not
repeat a save, send or inference merely because its first presentation was
untidy. Read-only navigation back to an existing result may supply another view
when that access is permitted.

Use `capture start` on the chosen session, `capture mark` for an important state,
and `capture stop` to end the take. Give each operation a stable ID before its
dispatch and retain it; recover a lost acknowledgement with that same ID.
Marks help locate a capability, response or
readable state; they are not a prewritten scenario. To retain framing, give
`capture mark` a control reference from the fresh observation, or a rectangle
in that observation's screenshot pixels. The runtime preserves the canonical
box: do not perform the CSS conversion used for coordinate **input** above.
Read the installed mark contract for the two accepted target forms.
Marking frames the observed state without scrolling or moving the app. After
an action, page change or stale-observation rejection, observe again rather
than reusing the old target. In the edit, `picture.target` or
`cameraMove.target` can name that sealed `markId` on the same source. It is a
fixed observed framing, not a tracker that follows the object after it moves.

Mark a state settled only
after its relevant response has finished and the evidence is readable. Pending
work remains live. Follow the returned capture status before starting another
take or closing its session.

Record the relationship the viewer needs: enough context to recognize the
control, the deliberate gesture and the visible consequence. Let the response
become intelligible before leaving it. Avoid rapid input followed by a long
unchanged screen: that loses the interesting relationship and retains only
waiting. A defining interaction deserves connected use across the film,
including how its behavior changes after another capability is used.

The runtime owns source geometry and capture cadence. Keep the capture surface
qualified; do not substitute a screenshot slideshow, low-cadence recorder,
interpolated motion or post-hoc frame duplication. Inspect source-motion defects
before spending on finishing. Good editing can omit a redundant defective
gesture, but cannot make a required unreadable interaction legible.

## Retain actual files and seal the sources

Use `artifact list` to find actual downloads and retained files. Use
`artifact inspect --session ID --id ARTIFACTID` with the project to check an
actual session download before sealing. Inspect the
reported filename, media type and retained-byte identity rather
than assuming a click produced a usable artifact. Use the recorded file for an
authorized reimport; do not recreate equivalent JSON or a replacement PDF and
call it the application's export. Upload selects exactly one form: `paths`
under admitted input roots, `artifactIds` from the current session, or
`sourceArtifacts:[{sourceSetId,artifactId}]` from a sealed source set in this
project. The last form also permits exact-byte reimport from an earlier session.
Retained artifacts are hash-verified before upload; preserve
their identities rather than copying around custody checks. An internal
observation is not an application-exported artifact.

For upload, target the observed file input or the visible control that opens
its input-backed chooser. Supply the files in that same `upload` action; do not
click the control first. The runtime checks the bytes before using a timed
pointer click and selecting the files, including when the application creates
its input only after the click. Native filesystem picker APIs remain unavailable.
If no chooser arrives or selection fails, inspect the original action and
observe the application before deciding what follows; a fresh ID is not a retry.

Use `capture seal` once the required takes have stopped and their state and
relevant action outcomes are understood. Keep the returned source-set identity
and digest for the edit. Select which real artifacts belong in the delivery;
zero is valid when the product journey has no file payoff. A seal selection
names each download's session ID, artifact ID, author-chosen title and role.
Choose `deliverable` for files included in local delivery or `source` for
supporting material. Use `artifact inspect --source-set ID --id ARTIFACTID` to
verify the sealed artifact before delivery.

New captures preserve the returned mark ID through stop and seal. Pair it with
its take ID as the picture's `sourceId`, for both framing and
`settledObservationId`. Marks on different sources may share a name. For
retained historical sources, use their inspected mark IDs unchanged.

Public lists are bounded: project/artifact lists accept `--limit` up to 100 and
`--offset`; source-set inspection accepts limits up to 1000. Follow the returned
`nextOffset` for the needed collection. Use source inspection's
`--section sources|marks|artifacts|records` to narrow evidence. Source summaries
report `pointerSamples`; inspect the retained trajectory with
`--section pointer --source SOURCEID`, paging it rather than assuming a summary
contains every sample. These views do not shorten the evidence on disk.

Close an unneeded session through `session close`; inspect an uncertain close
instead of assuming the browser and recorder stopped. Composition needs only
sealed sources, not the application, its profile or a live session. Preserve
the project so ordinary-language revisions can start from these sources.
