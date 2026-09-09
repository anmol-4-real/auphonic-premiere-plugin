# Packaging & releasing Awwphonic

This project has no Node/npm and no `uxp` CLI on this machine (confirmed -- see HANDOFF.md's Environment section), so packaging happens through the **Adobe UXP Developer Tools (UDT)** app's own "Package" feature, not a script. That's also the standard, correct way to ship a private UXP plugin outside the Adobe Exchange marketplace: the output is a `.ccx` file that any editor with Creative Cloud Desktop installed can double-click to install -- no developer mode, no UDT, on their machine.

## One-time setup

1. Open **Adobe UXP Developer Tools**.
2. Find **Awwphonic Audio Processor** in its plugin list (already there from testing this project in developer mode).
3. Click the **...** menu next to it, then **Package**.
4. If prompted for a signing certificate, choose **Create a new self-signed certificate**, fill in a name/org/password, and save the resulting certificate file somewhere safe. **Reuse this same certificate for every future release** -- signing every version with the same certificate is what lets Creative Cloud Desktop recognize an update as coming from the same publisher and install over the old copy instead of erroring or duplicating it.
5. UDT produces a `.ccx` file. This is the installer you send editors -- see [INSTALL.md](INSTALL.md).

## Every future release

1. Bump `"version"` in [manifest.json](manifest.json) (e.g. `1.0.0` -> `1.1.0`) **and** the matching `PLUGIN_VERSION` constant near the top of [src/ui/panel.js](src/ui/panel.js) (used only to stamp the "Report a Bug" email -- the plugin doesn't read its own manifest at runtime, so these two have to be bumped together by hand). The plugin's `"id"` and the panel's entrypoint `"id"` must never change -- that's what keeps an editor's existing install, saved API key, and cache recognized as the same plugin across updates (see manifest.json's own comments and HANDOFF.md's Hard boundaries for why).
2. Add a new dated entry to [CHANGELOG.md](CHANGELOG.md) describing what changed, in plain language -- this is what you send editors alongside the new `.ccx`.
3. Repeat the **Package** step above in UDT, using the same certificate.
4. Send editors the new `.ccx` (email, Slack, shared drive, whatever's easiest). They install it exactly the same way as the first time -- see [INSTALL.md](INSTALL.md).

There's no separate auto-update channel for a privately-distributed `.ccx` (that only exists for plugins listed on the public Adobe Exchange marketplace, which requires an Adobe review process this project hasn't gone through). Re-sending a new `.ccx` for each release, which an editor installs the same one or two clicks as the first time, is the whole update mechanism.

## Windows

The plugin's own code is UXP-only (all paths and file access go through UXP's own cross-platform storage/fs API, confirmed by grep -- there are no hardcoded Mac paths or OS-specific branches anywhere in `src/`), so nothing in the code itself is expected to need changes for Windows.

**One real, previously-flagged risk still stands, though:** the bundled Adobe Media Encoder export preset, [`assets/presets/Waveform Audio 48kHz 16-bit.epr`](assets/presets/Waveform%20Audio%2048kHz%2016-bit.epr), was exported from this Mac's own AME install and has never been confirmed to load correctly in a Windows AME install (see HANDOFF.md's Environment section -- this has been an open item since Phase 1). Before shipping to any editor on Windows: test one full run on the Windows machine first. If the preset doesn't load there, the fix is exporting an equivalent `.epr` from a Windows AME install and bundling it -- not a code change, just a new asset file, plus a small platform check in `export.js` to pick the right one. Don't build that platform check speculatively before confirming live whether it's actually needed, matching this project's own established practice of verifying every Premiere/UXP-adjacent assumption live rather than guessing.
