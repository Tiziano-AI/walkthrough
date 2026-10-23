# Third-party software

Walkthrough's original code, authoring skill and original artwork are MIT
licensed. That license does not relicense its prerequisites, the websites
recorded, voices, models or other third-party material.

The bootstrap release includes Walkthrough's own source, lockfile, patch
instructions and compiled process reader. It does **not** include npm package
bytes, a browser, FFmpeg, Voices, voice references or model weights. Explicit
installation acquires the locked production npm dependencies and the selected
Playwright browser from their upstream distributors. No such acquisition runs
during film production.

## Renderer

Walkthrough uses Remotion **4.0.538**. Remotion is source-available under its
[own license](https://github.com/remotion-dev/remotion/blob/v4.0.538/LICENSE.md),
not MIT. Operators must establish their applicable eligibility or license;
Walkthrough does not grant or transfer it. See the
[Remotion license FAQ](https://www.remotion.dev/docs/license/faq).

The locally acquired Remotion compositor includes its own FFmpeg/ffprobe and
libraries. Remotion documents these under **GPLv2 or later**, with source and
build information linked from its
[FFmpeg distribution notice](https://www.remotion.dev/docs/miscellaneous/ffmpeg-license).
These are acquired upstream at explicit installation, not redistributed in
Walkthrough's bootstrap archive. Walkthrough's separately selected external
FFmpeg remains subject to the license and configuration of that installation;
see [FFmpeg legal information](https://www.ffmpeg.org/legal.html).

Walkthrough applies narrowly scoped, hash-checked patches to acquired
Playwright/Remotion JavaScript for process custody and frame transport. Patch
instructions are Walkthrough source; the resulting dependencies retain their
upstream licenses. Unknown package bytes are rejected, not patched by guesswork.

## Other runtime dependencies

The exact dependency graph, upstream package URLs and integrity hashes are in
`runtime/package-lock.json` in the repository (`package-lock.json` in the CLI
archive). Acquired packages retain their own license files, including
those of transitive and native optional dependencies. Principal dependencies:

| Component | Version | Upstream license |
| --- | --- | --- |
| Playwright and Playwright Core | 1.64.1 | Apache-2.0 |
| React and React DOM | 19.3.1 | MIT |
| mime-types | 3.0.2 | MIT |
| Remotion, bundler and renderer | 4.0.538 | Remotion license |

The browser downloaded by Playwright has its own notices and third-party
licenses. Node.js, external FFmpeg and Voices are separately installed
prerequisites, not bundled under Walkthrough's license. Voices models and
operator-selected voices keep their own terms; no personal voice asset is
included in this release.

## Film content

The MIT license covers Walkthrough, not automatic rights to record, review or
publish another product, source document, account or voice. The film project's
mandate records the creator's allowed use and destination. Installing or
disabling the plugin does not publish films or delete their retained sources.
