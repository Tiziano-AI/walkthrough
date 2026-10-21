# Set up and resolve the installed authoring environment

Use the installed `walkthrough` executable, its `--version --json` result and
`help --json`. The version identifies what is actually running; help and its
input contracts describe that runtime's commands and inputs. Read the relevant command
help rather than an old checkout's implementation or a remembered invocation.
The installation and the film project are separate: use an explicit absolute
`--project` path so a working-directory change cannot select another film.

If `command -v walkthrough` finds nothing, follow the product's documented CLI
installation and the launcher's reported PATH location. The plugin supplies
this guidance; it does not hide an executable in its cache. Do not install a
similarly named registry package, invent a source path or create another copy
of the skill to make discovery pass. Follow the installer's read-only check or
recovery operation after an uncertain installation; do not overwrite foreign
or changed outputs.

`--version` and `help` are read-only discovery: they do not write operational
state or start the supervisor. Operational commands retain their identities and
apply the required macOS containment. `HOST_STATE_NOT_WRITABLE` identifies denied
state writes; `HOST_SANDBOX_UNAVAILABLE` identifies the operating system refusing
that containment. A state error names the selected directory. These are host
prerequisites, not a missing project mandate or corrupt film. Ask the host owner
for an authorized compatible execution context; do not disable containment or
redirect state to disposable storage to bypass it.

## Complete setup from actual installations

Use `setup inspect` to distinguish missing tools, missing selected configuration,
changed identities and an interrupted setup selection. Prepare against the
installed prerequisites, the operator's chosen provisioned narrator and their
explicit Remotion eligibility assertion. Read `help setup --json` for the input
schema, then use the exact prepare/apply contract:

```sh
walkthrough setup inspect --json
walkthrough help setup --json
walkthrough setup prepare --candidate /absolute/new-setup-candidate.json --input /absolute/setup-input.json --json
walkthrough setup apply --candidate /absolute/new-setup-candidate.json --sha256 <candidateSha256> --json
```

Preparation observes installed tool and Voices identities and creates an
unselected candidate. Review the returned selection and digest. Apply rechecks
the candidate, assets and previous selected records before choosing it. Rejoin
an interrupted apply with its original candidate and digest; do not prepare a
replacement over an unresolved transaction. Setup does not download models,
create voice assets, install shared tools or decide the operator's license
eligibility. Plugin installation alone does none of this setup.

Run `doctor` for the relevant local requirements. Keep its finding attached to
what it checked: ready local tools do not establish login, application behavior,
data access or film quality. Resolve missing dependencies through the documented
explicit setup owner. Production commands must not download replacements,
silently change pinned runtimes or turn a missing license assertion into a
fabricated one. A blocked prerequisite is repaired at its owner, not bypassed
with another recorder, renderer or speech service.

Use the installed Voices runtime and its reviewed provision. The operator's
saved narrator is the default; honor an explicit request for another
provisioned voice without an unnecessary audition. Set English or Italian
explicitly for new edits according to the requested narration, and keep that
language through speech, alignment, captions and independent transcription.
Historical edits without a language retain English behavior; their original
bytes do not need rewriting. An unavailable requested voice or language is a
concrete setup limit, not a reason to substitute silently.

New speech or analysis requires a reviewed current provision with its selected
voice references and exact synthesis, alignment and ASR models. Read
`audioRequirements` in `help audio --json` or `help setup --json` for the model
revisions and upstream Hugging Face acquisition commands. Use `model_cache`
from the selected Voices installation's `voices --json doctor` as the shared
cache; there is no Voices `provision` or `download` command. Missing assets need
explicit upstream acquisition before setup, not a synthesis call disguised as
a downloader. The HF snapshot resolver owns `trees/<revision>.json` metadata as
well as the weights; copied snapshots without it are incomplete prerequisites.
Never fabricate the metadata. An HF acquisition preview may contact the Hub and
write cache metadata; Walkthrough's help, doctor and setup do not download.
A changed Voices
identity requires explicit setup verification, not silent acceptance. Do not
copy a private model/runtime installation or alter shared caches to make one
film work.

For editorial revisions, `--reuse-audio` can verify and reuse compatible retained
WAV, alignment and any originally recorded ASR without any Voices installation or current audio
provision. New or changed phrases still require current setup; matching corrupt
audio fails rather than being replaced silently. Historical evidence keeps its
original identities. Read [recovery](recovery.md) for exact incomplete audio
attempts and offline reuse. Setup readiness does not establish natural or
accurate speech; listening remains a separate observation.

Capture and composition have different requirements. A narration provision
failure need not prevent authorized exploration or retained silent acquisition.
An inaccessible application need not prevent editing sealed sources. Use the
command's actual failure and recovery guidance to decide which independent work
can continue.

The generic browser lane supports real web use; it does not promise native-app
capture or access to every authentication method. If a required interaction is
unsupported, retain what is already useful and name that precise missing
capability. Do not fabricate a demonstration or make a product-specific script
the hidden prerequisite for using the skill.
