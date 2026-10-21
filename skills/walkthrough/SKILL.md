---
name: walkthrough
description: "Web-product walkthrough videos from real browser use. Create a narrated local film from a product, audience and intent, or revise retained footage. Not written walkthroughs, invented UI demos, native-app recording or publication."
license: MIT
compatibility: "macOS Apple Silicon; separately installed Walkthrough CLI, Node 24, FFmpeg and local Voices. The plugin provides guidance; setup acquires browser and runtime dependencies explicitly."
---
# Walkthrough

Make a film that lets the intended viewer understand what the product is for,
how its main capabilities connect and what using it feels like. A concrete task
gives continuity; the product remains the subject. A recommendation about the
example is a different film unless the creator asked for it.

The creator supplies the product, audience and intent. You own exploration,
interaction selection, recording, narration, editing and local delivery. Infer
ordinary authoring choices from that brief; ask only for a missing decision
that belongs to the creator. Do not ask them for selectors, an action program,
assertions, narration timing or a timeline.

## Choose the first move

- **New film:** inspect the named product through the live browser before
  deciding the story. Keep its existing app, records, dataset and analyses;
  do not rebuild or refresh them merely to obtain a recording.
- **Revision:** inspect the project and retained sources, then edit and compose.
  A wording, pacing, voice, caption or framing change does not reopen the app.
- **Interrupted work:** inspect the exact session, action, take or composition
  and use [recovery](references/recovery.md). An uncertain effect is never a
  reason to start a replacement occurrence.

Resolve `walkthrough` with `command -v walkthrough`. Read `walkthrough --version --json` and
`walkthrough help --json`. Command help and its input contracts own the
installed grammar and locate the shipped JSON Schemas; use them instead of
reconstructing inputs from old runs or reading implementation code. `--input`,
`--brief` and `--edit` take JSON file paths; `--data` accepts inline JSON for
operations that offer `--input`. Pass an explicit absolute `--project` path for
operations on an existing project; create names its destination with `--path`.
Inspect an existing project before creating another. Retained sources support
revision without opening their former application.
Read [environment](references/environment.md) when the executable, setup or
local prerequisites are missing or disagree.

## Explore, then choose what to show

Use Walkthrough's generic **observe → act → observe** browser surface. Read the
fresh page and choose real input from what is visible. For a capability the
film relies on, compare the subject before and after: its position against a
stable landmark, the changed value or the relationship between linked views.
Open the returned images when that consequence is visual. The pointer's path,
the requested displacement and your action name describe the attempt, not the
subject's response. If the subject appears unchanged, that is the result to
investigate; expected behavior cannot explain away contradictory images.
This is how you learn and film a new product; do not write a per-product adapter,
scenario program, network classifier or API recipe.
Use [browser authoring](references/browser-authoring.md) for element
references, visual targets, sessions, capture and real files.

Find the audience's useful path through the product and the interaction that
makes its value apparent. Give that interaction meaningful use: a spatial
explorer may need rotation, selection and a return to the changed view so the
viewer can understand its relationships. One decorative drag before a report
does not introduce an interactive product. Another example earns its place by
revealing a different relationship, not just another result.

Choose the story from observed capabilities and responses. Explore before
writing final narration; retain a useful exploration take rather than repeating
its effects for tidier footage. A surprising result changes the explanation,
not the evidence. Follow an export into its actual file when that file is the
payoff. An interactive-only product needs no invented export or save step.

## Keep the work within the mandate

Translate the request into the project brief and its application, navigation,
effect, data, input-file, review and local-delivery scope. Do that authoring
yourself from established authority; a valid brief does not create permission.
Respect application-owner holds. Access, effects, agent inspection and
distribution are separate permissions.

Navigation origins narrow browser destinations, not the meaning of every API
request. The agent still judges each action's consequence. A preview can save;
a read can be requested with POST. Do not turn unfamiliar traffic into a
blanket grant or claim an exact-host network sandbox.

Keep authentication off camera using session handoff/resume. Never type
credentials into an action payload. Local storage does not authorize exposing
private DOM, screenshots, media or files to a hosted authoring agent. Inspect
only admitted evidence; if necessary evidence cannot be reviewed, state that
specific limit without uploading it or claiming comprehension.

## Record consequences, then compose

Run the installed doctor's relevant checks before recording or composing.
Capture real browser use through the same session, marking meaningful states
and recording visible responses. Mark the subject from a fresh observed control
or screenshot rectangle; the runtime keeps its framing geometry for offline
editing. A framing mark does not establish a settled reading state.
Give each dispatched action a stable identity;
inspect an uncertain outcome before any next consequential input. Input
completion is not proof that the application saved, sent or finished its work.

Stop and seal the useful takes and actual artifacts. Sealing retains evidence;
it does not certify application success. Compose from those sealed sources,
without browser access. Write short complete thoughts that explain what the
viewer can change, how the product responds and what that enables next. Keep
internal checks, provenance recitals and unsolicited disclaimers out of speech.
State a limitation once where it changes use or interpretation.

Build a connected passage from source moments, not a scene for every sentence:
**orientation → gesture → observed response → next capability**. Locate where
the viewer can recognize the subject, where the consequential gesture begins,
where its response becomes intelligible and what that response makes useful
next. Select those ranges before fitting speech. Changing a filter leads into
exploring the changed chart; four isolated control demonstrations do not make
that connection for the viewer.

Picture and narration have independent timelines. A reason can prepare the
gesture; its explanation can continue across a cut while the response appears.
After the recording shows connections following a moved object, begin that
thought before the gesture rather than waiting for speech to finish before
moving. Anticipation belongs to the edit, after observing the consequence.
Silence gives the viewer room to finish a visual task: following that movement,
recognizing its new relationship, reading or comparing. End it when that task
is complete.
An unchanged view can serve comparison; a moving pointer alone cannot give an
otherwise inert pause meaning. Shorten, cut or reposition speech when there is
nothing left to follow. Do not add motion merely to disguise the gap.

Keep live footage at 1× and speech natural. Pictures determine the film's
length; narration never stretches, freezes or pads them to fit. A reading hold
must select an observed settled state, never a spinner or pending response.
Move or shorten speech, or choose other useful retained footage when it does
not fit. There is no imposed film-duration budget.

Use the operator's saved default voice unless the creator requests another
provisioned voice; do not audition again without a reason. Set the film's language
explicitly. Reuse compatible retained audio for editorial revisions. ASR flags
possible word differences; it neither judges vocal quality nor replaces
listening, and a disagreement is not a reason for automatic regeneration.
Keep the app full-frame. Use short visible phrase captions of at most two lines,
placed for each shot away from its action and evidence, plus complete portable
VTT. Do not shrink the product into a permanent caption rail or add duplicate
player captions. Establish context before a detail move and settle the camera
for the action. A brief outline or spotlight can distinguish a consequential
response without discarding its context; it is editorial attention, not an app
selection or proof of success. Use observed framing targets, not a box that
pretends to track a moving object. Preserve real source cadence for 1080p60;
duplicated frames do not repair low-cadence motion. Read
[story and editing](references/story-editing.md) when constructing a connected
passage, directing speech and emphasis, or repairing flow; its worked example
connects source moments to an edit and contrasts the visible result.

## Finish where the viewer meets it

Validate the edit and preview the passage that can settle the current editorial
question before composing the whole film. For flow, include orientation,
gesture and response, not merely the prettiest frame.
Use measured speech gaps to revisit what the viewer has to follow between
thoughts; activity records locate moments but cannot judge their meaning.
A phrase may cross the preview's start; the runtime handles that clock. Reuse
existing audio rather than resynthesizing for a camera or emphasis change.
The successful preview replaces its predecessor, so iterate on one current
sample instead of collecting versions. Preview gain is not final mastering.

Compose and inspect the current bundle. Watch and listen at
delivery size where evidence classification and available tools permit. Judge
whether the viewer can follow the product, see the consequential interactions
and understand the retained result. Stills cannot establish pacing; decode and
alignment cannot establish spoken accuracy; green QA cannot establish human
acceptance.

Repair the stage that owns the defect: explanation, audio, edit, rendering or
capture. Do not reacquire application work for an editorial repair. Keep useful
sources and unresolved recovery material; use [recovery](references/recovery.md)
when effects or retained bytes are uncertain. Generate only the previews needed
to make the next editorial decision, not frame dumps of the whole film. Retire
your own disposable previews once that decision is settled; do not accumulate
contact sheets, decoded frames or duplicate masters as project deliverables.

Present the final MP4 directly so the creator can watch it without unpacking a
production folder. Keep the local review page, captions, canonical text and
actual exported files available in the project; surface them when useful for
feedback or the requested handoff. Successful composition removes regenerable
render scratch after verifying delivery; keep the sealed sources and edit for
revisions, not duplicate masters. Use `project compact` for an older completed
composition or a failed composition or preview you have inspected after settling its
command/session custody; it preserves inputs, audio, diagnostics and sole encoded
outputs. Handle this authoring housekeeping yourself through the public command,
never manual project-wide cleanup. Originals enable revision, not an obligation
to archive every test movie indefinitely. Do not recreate films the creator
retired. State any unobserved playback or listening separately from technical
completeness. Close sessions you no longer need;
hand back the exact identity and recovery route for any unfinished activity.
Local delivery grants no publication or sending of the bundle. Accept the next
ordinary-language revision against this retained work.
