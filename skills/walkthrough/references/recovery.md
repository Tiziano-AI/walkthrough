# Continue the right work

Start with the explicit project and its `project inspect` result. Match product,
inputs and retained result, not merely the newest identifier. Inspect the exact
session, action, take, source set, composition or preview involved. Recorded
lifecycle, process liveness, source integrity and current bundle availability are distinct
observations; a stale status is not permission to launch again.

## Reconcile input before deciding the next effect

Keep the original session and action identities. Use `action inspect` for the
original action ID and inspect the application's current admitted state. An
`input-completed` result means the browser input finished, not that its business
consequence succeeded. `outcome-uncertain` may mean the effect happened without
a recorded acknowledgement. Do not repeat it under a new action, session,
project or account.

Use `action resolve` only with evidence that settles the original action, using
its installed help for the resolution contract. Do not resolve to the desired
outcome merely to unlock the next command. A missing save response can sometimes
be settled by inspecting the existing saved object; pressing Save again is not
that inspection. If the outcome remains unknown, retain it, stop dependent
consequential work and state the missing observation. Continue independent
editorial work from already sealed sources when useful.

Use `session inspect` before resuming a session or assuming it stopped. A human
authentication handoff and an interrupted browser have different recovery
routes; use the session's actual state and `session resume` help. A new session
cannot establish what the former one did. Likewise, a failed stop does not mean
the recording ended. Reconcile the retained capture state through its public
operations rather than creating a replacement take to hide it.

If session opening was interrupted, inspect and close that original launch
attempt. Those operations can settle it when its worker and process group are
demonstrably stopped, including when launch ended before a worker identity was
recorded. They do not start a replacement browser. An unresolved identity is a
reason to preserve the attempt and follow its returned recovery, not to delete
its session directory.

If recording ended but calibration or finalization failed, close the original
session and use `capture recover --take <original-take-id>`. This qualifies the
retained recording offline, then permits the normal `capture seal` step. It
does not repeat stop or application input, and preserves the failed record.
Missing ending calibration cannot be manufactured. An older take without a
recorded capture window may expose only the measured event-and-mark interval;
inspect its returned `usableRange` rather than guessing additional lead or tail.

## Repair the layer that failed

| Defect | Nearest repair |
| --- | --- |
| Confusing or unsupported explanation | Revise canonical text from admitted evidence; recompose |
| Poor crop, cut, caption placement or reading space | Repair the edit against retained sources |
| Required gesture is missing or unreadable | Inspect source input and capture; obtain only the permitted missing view |
| Missing or wrong spoken words, pronunciation | Compare canonical text, the affected WAV and independent transcript; repair the actual divergence |
| Correct speech with wrong caption timing | Repair alignment or caption placement; preserve the speech |
| Mix or delivered loudness | Repair finishing against retained speech and recheck the final AAC |
| Encoding or delivery files | Use the installed finishing recovery if supported for that exact occurrence |
| Missing view of the same result | Authorized read-only navigation and an additional take, without repeating its effect |
| Missing or changed original bytes | Exact restoration, never invented evidence |
| Wrong application result | Preserve occurrence; repair product before authorized new effects |
| Changed dependency/runtime | Owned setup and requalification; no silent repinning |

A finished MP4 followed by a packaging failure is different from a render that
never completed. Inspect retained outputs before choosing recovery; do not
assume a command from an older runtime still exists. When installed help admits
finishing the exact retained encode, keep its edit unchanged and the failed
occurrence intact. When the edit changes, compose a new occurrence using the
same sealed sources. Preserve the evidence's original provenance: today's
observed hash cannot supply a missing historical producer identity.

For an audio failure, read `inspect --composition`'s `audioFailure` before
deciding what to repair. It identifies the phrase, failed operation, child
outcome and retained diagnostics when recorded. A failed alignment may still
have valid synthesized audio; a failed independent transcription may follow
both successful synthesis and alignment. Preserve each completed stage and the
failure diagnostics rather than deleting partial caches or repeating synthesis.
Rewording a phrase does not repair an aligner or recognizer runtime failure.

Use the exact attempt path returned by the failure:

```sh
walkthrough audio attempt inspect --attempt /absolute/attempt.json --json
walkthrough audio attempt resolve --attempt /absolute/attempt.json --resolution adopt --note "Describe the retained evidence." --json
```

Inspection does not load models or write a resolution. It reports the stage,
input/runtime identity, process settlement, valid products and next action.
Resolve first proves the original process group stopped. Adopt exact valid
products when available; `--resolution retry` permits only the incomplete stage
to run on the next normal composition. It does not run inference itself, erase
diagnostics or repeat valid upstream synthesis. Follow the returned operation
when settlement or product identity remains unresolved.

Alignment estimates where supplied words occur. Independent ASR recognizes
words from the sound and retains its lexical comparison with the canonical
phrase; neither establishes listening acceptance. Use a reported divergence to
locate the affected phrase, then compare its intended text, retained WAV and
recognized text. If the speech is correct and recognition is wrong, retain that
disagreement without changing the captions to the ASR transcript. If the speech
is wrong, repair the affected audio through its supported owner. A transcript
mismatch alone does not trigger automatic resynthesis, and a match does not
prove pronunciation, intelligibility or natural delivery.

For a new composition or preview, `--reuse-audio` names an exact composition in
the same project. It verifies compatible phrases individually, including their
text, voice, language, WAV, alignment and original ASR evidence when present. When all required
phrases match and verify, reuse is fully offline: neither current nor former
Voices, a current audio provision or a new ASR pass is required. A wording change
may require new speech for that phrase; a crop or caption-placement change need
not. The flag permits new or incompatible phrases to process through current
setup, but never silently replaces a matching corrupted artifact. Retained
speech, alignment and ASR keep their original identities; a runtime upgrade
does not relabel them.

A failed preview does not replace the previous successful current preview.
Use `inspect --preview <preview-id>` for the exact failed attempt and its
diagnostics; bare `inspect --preview` reports the current successful sample and
any retained active record, not necessarily the attempt that just failed.
Its status is retained evidence, not observed process liveness. A ready
preview's integrity check covers the MP4 hash, not all provenance or acceptance
of the complete film. Repair the excerpt offline from its sealed sources.

Preview keeps source gain and reports loudness as `not-evaluated-preview`;
the complete narrated composition owns loudness normalization and its final-AAC
gate. A quiet or very short excerpt is not a reason to lengthen the edit or
resynthesize speech merely to satisfy the full-film loudness gate.

A complete result with unreadable framing needs recomposition. An unrecorded
consequential action cannot be recovered by repeating it. Both may look like
“missing footage,” but their repairs differ.

Read-only missing views are new evidence, not replacements for old bytes. Do not
modify a source seal or create a new app occurrence as a substitute for missing
files. Exact restoration requires the original retained bytes.

Inspect affected downstream behavior after repair. Do not rerun application
work to prove an editorial change. Preserve useful sources and unresolved recovery
material; ignored files are not disposable, and projects/runs/caches are not
cleaned by age or glob. Successful compositions automatically remove their
regenerable render scratch after verifying the final bundle and sealed inputs.
Use `project compact --project PATH --composition ID --json` for an older
completed composition or a failed render after you have inspected its failure and
settled its command/session custody. For a failed preview, use the mutually
exclusive `--preview ID` target instead: find its ID with `project inspect`, then
read its error with `inspect --project PATH --preview ID`. The author owns this housekeeping, not the
creator.

A failed composition must have a recorded error. The command verifies its exact
edit, sealed sources and retained audio before removing only staging, renderer
bundle, `master.mov` and decoded samples. Its sole `render/walkthrough.mp4` and
`render/poster.png` remain, as do original recordings, edits, audio and diagnostic
records. An early preflight failure with no render scratch returns
`already-compact`; it needs no fabricated render receipts. Live or unresolved
command/session custody, changed required bytes and unexpected paths prevent
removal. Failed-preview compaction preserves the current sample, active/current
metadata and any copied `preview.mp4`; only its actually measured narration is
required. Completed delivery and matching duplicate hashes are still checked.
Failed cleanup is never automatic. A storage error does not invalidate an
otherwise complete film; inspect it separately rather than rendering again.

Compaction does not remove a whole project or superseded film. Original footage
and audio enable offline revisions; they do not require the creator to keep
every test movie indefinitely. Respect an explicit retirement decision and do
not restore or recreate that production for qualification records.

Successful preview replacement atomically selects the new excerpt and retires
only the previous successful preview's exact unchanged owned files. Modified
or foreign material is retained and reported; failed attempts keep their
diagnostics. Let that bounded public operation own replacement rather than
manually clearing the preview directory to recover a failed attempt.

Hand back the usable result or exact occurrence, unresolved condition and next
warranted action. Prepared commands are not executed effects; finished bundles
are not human acceptance. Preserve uncertainty without replay.
