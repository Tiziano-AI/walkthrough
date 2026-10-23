# Walkthrough

**Introduce a real web product through a film people can follow.**

Give your agent the product, audience and intent. It explores the application,
chooses the interactions that make it understandable, records real use and
delivers a narrated local film. Ask for a revision in ordinary language; the
agent can change pacing, framing, narration and captions from retained footage
without repeating application work.

> Make a walkthrough of this web product for a colleague who has never used it.
> Show what it enables and how its main capabilities connect. Use fictional
> content and keep the film local.

The product is the subject. A concrete task connects the journey; it does not
turn the walkthrough into a report about the example's outcome. A new product
changes the film project, not Walkthrough's software: no adapter, selector
package or site-specific program is required.

## What you install

Walkthrough has two cooperating parts:

- **The native plugin** gives Codex or Claude Code the authoring skill and its
  references. Its root contains no Node package or installation hook: installing
  the guidance does not acquire dependencies or start work.
- **The independent CLI** owns the browser, recordings, audio and local rendering.
  Film projects live outside both the installed release and the source checkout.

The initial platform is **macOS Apple Silicon**. You need Node 24.22.1 or later
on the 24 line with npm, FFmpeg/ffprobe, and a local [Voices](https://github.com/Tiziano-AI/voices)
installation with the three exact model revisions reported by `help audio` and
a saved narrator. The installer
explicitly acquires the exact npm dependencies and Playwright browser;
production performs no dependency or model downloads. The C toolchain is needed
to build a release, not to use one.

The renderer is Remotion. Its applicable license is an operator setup decision;
it is not supplied by installing Walkthrough. See [licenses](#licenses).

## Install the plugin

Add the `tiziano-ai` marketplace, then install Walkthrough through your host's
native plugin route. Use the CLI belonging to the host you actually use; a
desktop app's bundled runtime can differ from `codex` on your PATH.

**Codex**

```sh
codex plugin marketplace add Tiziano-AI/plugins
codex plugin add walkthrough@tiziano-ai
```

**Claude Code**

```sh
claude plugin marketplace add Tiziano-AI/plugins
claude plugin install walkthrough@tiziano-ai --scope user
```

Reload the host where supported, or start a fresh local session. Check that its
catalog contains one Walkthrough skill. Do not copy the skill into another
global skills directory: the plugin owns its discovery and version.

## Install the CLI and complete setup

Ask your agent to help with setup. It can inspect actual prerequisites and
prepare the configuration; you retain choices about your narrator, license
eligibility and any installation you have not authorized.

1. Download `walkthrough-0.4.1-darwin-arm64.tar.gz` and its SHA-256 file from
   [releases](https://github.com/Tiziano-AI/walkthrough/releases). Verify the
   checksum, then extract the archive.
2. Run the installer from that extracted release:

   ```sh
   node scripts/install-local.mjs install \
     --release /absolute/walkthrough-0.4.1-darwin-arm64 \
     --node /absolute/stable/path/to/node
   ```

   Installation explicitly fetches lockfile-pinned production dependencies with
   lifecycle scripts disabled, applies checked patches and acquires the selected
   Playwright browser into Walkthrough-owned storage. It verifies prerequisites
   and prepared bytes before activating the release. It does not install Voices
   models or modify other tools.
3. Ensure the installer's reported launcher directory is on your PATH, then read
   the installed identity and setup findings:

   ```sh
   walkthrough --version --json
   walkthrough setup inspect --json
   walkthrough help setup --json
   ```

4. Use `setup prepare` to create a candidate from the actual tools, installed
   Voices, selected narrator and your Remotion assertion. Review what it
   selects. `setup apply` rechecks the candidate and selects it; creating a
   candidate alone changes no active configuration. `setup inspect` and
   `doctor` then distinguish absent prerequisites, missing configuration and
   changed identities.

Select Node explicitly with `--node`; choose the invocation path maintained by
your tool installer, not a versioned directory it may remove during an update.
Walkthrough retains that selection and verifies the executable it reaches.
npm, FFmpeg and ffprobe can also be selected through installer flags; paths are
not tied to a particular package manager. Shipped help owns
the current configuration schema and command grammar. Setup does not acquire
models, silently accept a changed Voices runtime or invent a license assertion.
After replacing a prerequisite, inspect setup again. A changed executable hash
is a changed identity even when its reported version is unchanged; review a
fresh prepare/apply candidate rather than treating the previous selection as
verification of new bytes.

### Prepare local audio prerequisites

Read `walkthrough help audio --json`: `audioRequirements.models` supplies the
exact TTS, aligner and ASR repository revisions and their Hugging Face commands.
Run `voices --json doctor` against the Voices installation selected for setup;
its `model_cache` is the shared cache directory to substitute in those commands.
Voices has no `provision` or `download` command. If prerequisites are missing,
use the upstream [Hugging Face CLI](https://huggingface.co/docs/huggingface_hub/en/guides/cli)
with explicit acquisition authority:

```sh
hf download <repository> --revision <full-revision> --cache-dir "<model_cache>" --dry-run
hf download <repository> --revision <full-revision> --cache-dir "<model_cache>"
```

Use each exact repository/revision from help and acquire the whole snapshot,
without filenames, include/exclude filters or `--local-dir`. The first command
previews acquisition; it can contact the Hub and write cache metadata. The
second acquires missing bytes. Hugging Face owns both snapshot storage and the
[`trees/<revision>.json` resolver metadata](https://huggingface.co/docs/huggingface_hub/guides/manage-cache#trees)
required for offline resolution. Copied weights alone are insufficient; do not
fabricate the metadata or create a private Walkthrough model cache. After
acquisition, choose an existing saved Voices narrator and use setup
prepare/apply. Walkthrough's help, doctor and setup perform no model downloads.

## Make a film

Tell the agent the URL, intended audience and what they should understand.
Add any meaningful data/access limits or voice and language preferences.
The agent handles the technical brief, exploration, capture and edit. It should
not ask you to write selectors, narrate every control or prepare shot JSON.

The authoring cycle is:

**Explore → choose defining capabilities → record real use → connect gesture
and response → narrate observed behavior → compose → review.**

Walkthrough supplies a generic `observe → act → observe` browser. Element
references and screenshot-grounded coordinates support DOM, SVG and canvas
interaction. Click, drag, wheel, keys, text, upload and downloads retain actual
input and original file bytes. Authentication uses an off-camera handoff; no
credentials belong in action inputs or footage.

Recording and editing are separate. The project keeps stopped takes, source
clocks, marks, input events and selected artifacts in sealed source sets.
The edit chooses live ranges at **1×**, explicit settled reading holds, cuts,
camera moves, brief emphasis and independently placed speech. Pictures set the
film's length; narration does not add automatic padding or accelerate the app.

The operator's saved narrator is the default. New edits select English or
Italian explicitly. Speech, alignment and independent ASR retain separate
identities. ASR differences help locate words to check; agreement does not
establish natural or accurate speech.

See the [browser and film authoring guide](docs/browser-authoring.md) for input
shapes and exact coordinate systems. The installed `walkthrough help --json`
exposes the current operations and schemas without reading implementation code.

## Watch, revise and keep the result

The primary result is **`walkthrough.mp4`**, at 1920×1080/60 fps. A local review
page adds native playback, fullscreen, a seekable transcript, downloads and a
copyable feedback position. The bundle also contains portable VTT, canonical
text, poster, edit, checksums and any actual exported files selected for delivery.

Ask for a focused revision:

> Keep the opening wider. Let the explanation begin before the drag, and shorten
> the pause after the result. Don't reopen the application.

The author inspects retained sources, previews the connected passage and
recomposes offline. `--reuse-audio` verifies compatible retained speech rather
than synthesizing again for a crop or caption change. Matching, verifiable audio
keeps its original provenance even when its former Voices runtime is unavailable.
New speech or new analysis requires its applicable setup.

Technical checks can reject broken timestamps, unreadable layouts and audio
defects. Watch and listen to the complete film at normal speed, then check
whether someone unfamiliar with the product understands its purpose and main
interactions. A successful render, ASR agreement or `awaiting-human-review`
label does not establish that outcome.

## Recovery and storage

Every action is retained before dispatch. Reusing its identity retrieves that
attempt; it does not click again or promise server idempotency. After a lost
response, inspect the original action and reconcile its observed effect before
dependent work. Inspect and close the original session launch; inspect and
resolve an incomplete audio attempt through its retained identity. An error
identifies surviving state and the useful next operation;
clearing caches or starting a replacement session is not routine recovery.

Keep explicit `.walkthrough` projects outside the release. They contain the
sources and audio needed for revisions, not your authentication profile.
Successful composition removes its known regenerable render scratch after
verifying delivery. Preview replaces one successful current excerpt instead of
accumulating versions. `project compact` handles exact older or settled failed
compositions and failed non-current previews; `project inspect` lists their IDs.
It does not erase projects, useful sources or superseded films.
See [recovery guidance](skills/walkthrough/references/recovery.md).

## Update or remove

The same installer supplies `install`, read-only `check`, `recover` and
`uninstall`. It verifies owned outputs, preserves foreign changes and refuses
to switch a release beneath active or unresolved work. Interrupted activation
is recovered through its retained transaction, not a manual `current` symlink
edit. Projects, configuration, profiles, audio and shared prerequisites survive
uninstall.

Plugin updates and runtime updates are separate: inspect both the host's loaded
plugin version and `walkthrough --version --json`. The runtime installer creates
no competing standalone skill. Migrating a previous installation retires only
its receipt-owned skill links after native-host discovery is verified.

Disabling or removing the plugin withdraws guidance from that host. It does
not remove the independent CLI, stop its active session, delete projects or
revoke authentication. Use `session inspect` and `session close` for browser
custody before CLI removal; the installer refuses unresolved active work.

## Development

The repository root is the native plugin. Executable code, its package metadata
and build tooling live under `runtime/`; they are not plugin-startup dependencies.

```sh
cd runtime
npm ci --ignore-scripts
node scripts/provision-renderer.ts
node scripts/provision-session.mjs
npm run check
npm test
node scripts/package-release.mjs --out /absolute/new-release-output
```

Use qualified Node 24 and the Apple C toolchain for release builds. Packaging
copies a committed positive inventory of owned source, skill, documentation,
lockfile, patches and the compiled process reader. It does not bundle npm
dependencies or their native binaries. Installation acquires those explicitly.
Real browser, media and model qualification is separate from synthetic tests.

## Design and operating boundaries

- [Vision](VISION.md): creator, viewer and value.
- [Architecture](ARCHITECTURE.md): plugin, runtime, project and media ownership.
- [Quality](QUALITY.md): acceptance gates, tests and defect ownership.
- [Security](SECURITY.md): authority, review classes, network and retention.
- [Browser authoring](docs/browser-authoring.md): public operating contract.

Scope is web products, local processing and one Remotion renderer. There is no
native-desktop capture, GUI editor, permanent daemon, hosted TTS, music or
automatic publisher. Ordinary browser networking is not exact-host isolation.
Access to an application, agent review of its data and publication of a film
are separate permissions.

## Licenses

Walkthrough's original code, skill, documentation and artwork are [MIT](LICENSE).
[Third-party notices](THIRD_PARTY_NOTICES.md) separate dependency and model
terms; the MIT grant does not relicense them or your footage and voice assets.
The release archive distributes owned code, not modified Remotion copies or
Remotion's FFmpeg binaries. Explicit installation acquires dependencies upstream.

Read the [Remotion license FAQ](https://www.remotion.dev/docs/license/faq) for
renderer eligibility and [its FFmpeg notice](https://www.remotion.dev/docs/miscellaneous/ffmpeg-license)
for the separately licensed binaries. Voices and its models are separate
installations. No personal voice assets, models, credentials or operator license
assertion are included in this repository.
