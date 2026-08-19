# Auphonic Premiere Plugin — Handoff for Phase 1 Build

Paste this entire document as your first message in a new session to continue this project. It contains everything learned from setup and verification so the new session can start writing the real plugin immediately, without repeating any research.

## What this project is

Building a UXP plugin for Adobe Premiere Pro 2026 that lets an editor select one clip on the timeline, click a button, and have Auphonic (a cloud audio-cleanup service) clean its audio — with the cleaned result automatically placed on the track below, correctly aligned, and the original clip's audio disabled (never deleted). Full spec: `/Users/anmolpreet/Downloads/Auphonic_Premiere_Extension_PRD.md`. The user (Kan, Studio Production Manager) is **non-technical** — explain things in plain language, avoid jargon, and don't assume familiarity with programming concepts.

The full build plan (setup, spikes, and Phase 1 breakdown) was approved and lives at:
`/Users/anmolpreet/.claude/plans/users-anmolpreet-downloads-auphonic-pre-nested-mccarthy.md`

## Version control

The project is on GitHub, connected and pushed:
**https://github.com/anmol-4-real/auphonic-premiere-plugin** (private repo)

- `gh` (GitHub CLI) is installed at `~/.local/bin/gh` (not on PATH by default — run `export PATH="$HOME/.local/bin:$PATH"` first, or use the full path). Already authenticated as `anmol-4-real` via browser login; git is configured to use `gh` as its credential helper (`gh auth setup-git`), so `git push`/`git pull` work without any further login.
- Local git identity for this repo only (not global): name `Anmolpreet`, email `anmolpreet@hackerrank.com` — change with `git config user.name`/`user.email` if a different display name is wanted.
- `.gitignore` excludes: `reference/` (Adobe's sample repo — re-clone with `git clone https://github.com/AdobeDocs/uxp-premiere-pro-samples.git reference/uxp-premiere-pro-samples` if needed again), `Test Exports/` (generated test audio, not source), `.claude/` (local tool config), `.DS_Store`.
- One commit so far: the spike plugin + this handoff doc. **Commit the real Phase 1 plugin as it's built** — don't let it pile up uncommitted; the user has not been asked whether they want commits automatic or per-milestone, so ask before the first Phase 1 commit whether they want to be prompted each time or have commits made proactively as features land.

## Current status (2026-08-19): Phase 1 code is fully written. Not yet live-tested in Premiere.

Every file listed in the plan's section 2 folder structure now exists at the project root: `manifest.json`, `package.json`, `jsconfig.json`, `index.html`, and `src/{main.js, ui/{panel.js, styles.css}, core/{selection,export,auphonicClient,insertion,costEstimate,cache,jobModel,errors}.js, lib/{secureStorage,paths}.js}`. All files pass a JavaScript syntax check (via `osascript -l JavaScript`, since Node isn't installed) but **none of it has been loaded into Premiere/UDT yet** — that's the next session's first job. See "How to load and test Phase 1" below.

**Deliberate scope decisions made while writing this code** (not re-litigate, but worth knowing):
- No `command` entrypoint in the manifest — only the panel. A command entrypoint invoked from Window > UXP Plugins would have no natural place to show the cost estimate and get explicit confirmation before spending credits, which is a hard PRD requirement. Can be added later if wanted.
- A selected **video clip is rejected outright** ("Video clips are not supported yet -- select the audio item directly") rather than attempting linked-audio resolution — that resolution is explicitly Phase 2 scope per the PRD.
- **No collision detection** on the destination track — Phase 1 explicitly excludes it per the plan; `createOverwriteItemAction`/insert will just place the clip, silently replacing whatever's there on an existing track below.
- Bin creation and label colors are skipped entirely (Phase 3 scope).
- Multi-selection is rejected with a message rather than silently processing only the first item.

**New facts learned while writing this code (not covered by the spike, so not yet live-confirmed):**
- **`TickTime.ticksNumber` (a number), not `.ticks`, is the real property** for reading raw tick values off a TickTime object — confirmed by reading Adobe's own sample (`sequence.ts` lines ~392-395, the handles-calculation code), not by live testing. Used in `selection.js` and `panel.js` for the job record's `timelineStartTicks`/`timelineEndTicks` fields.
- **Media type (audio vs. video) and a track item's real track index are derived the same way Spike C already proved works**: walking `sequence.getAudioTrack(i)`/`getVideoTrack(i)` and matching the selected item by exact start/end tick position — not via a `trackItem.getTrackIndex()` method, which the PRD asserts exists but which the spike phase never actually exercised. This conveniently solves both the media-type question and the track-index question with one already-proven mechanism.
- **Placement track-auto-creation logic (`insertion.js`) branches on which action to use**: `createInsertProjectItemAction` (with `limitedShift: true`) when no track exists below the original (this is the ONLY action confirmed live to auto-create a track — see Spike C), vs. `createOverwriteItemAction` when a track already exists below (per the PRD's explicit preference, to avoid rippling). On a brand-new empty track these two have identical effect anyway, since there's nothing to shift.
- **The WAV export preset is now bundled with the plugin** at `assets/presets/Waveform Audio 48kHz 16-bit.epr` (copied from this Mac's AME 2026 install) instead of referenced by the spike's hardcoded absolute AME path — this was an explicit known rough edge called out in `spikes/README.md`. `export.js` reads it via `uxp.storage.localFileSystem.getPluginFolder()`, **which has not been exercised live anywhere in this project** — worth watching closely on the first real export test. Windows will need its own bundled `.epr` at some point (still deferred, see below).
- Several PRD-asserted `ClipProjectItem` eligibility checks (`isMulticam`, `isMergedClip`, `isProxy`) are called defensively (feature-detected, never assumed) in `selection.js` — if a method doesn't exist on this build, it's recorded in a `diagnostics` array logged to the console (not silently treated as pass or fail). Check the UDT console during eligibility testing to see what actually ran.
- `uxp.shell.openPath()` (for the "Reveal Cache Folder" button) and `Folder.getEntries()`/`Folder.getEntry()` (for cache housekeeping) are standard, well-documented, non-Premiere-specific UXP storage APIs, not exercised live in this project yet either — lower risk than the Premiere-specific items above, but still unverified.

## How to load and test Phase 1

1. Open **Adobe UXP Developer Tools** → **Add Plugin** → select `/Users/anmolpreet/Documents/Awwphonic/manifest.json`. This is a different plugin id (`com.hackerrank.auphonic-premiere`) from the spike (`com.hackerrank.auphonic-spike`), so both can be loaded side by side without conflict.
2. Click **Load** (or **Load & Watch** for auto-reload while iterating). In Premiere: **Window → UXP Plugins → Auphonic Audio Processor**.
3. Walk through the build plan's section 4 checklist in order (skeleton panel → API key/credits → preset dropdown → clip selection/validation → cost estimate → export → upload/process/download → timeline placement → job record file → error handling/cache buttons). Each has its own visual check already described there.
4. Watch the UDT console/debugger throughout, not just the panel — several of the "new facts" above will only reveal themselves there (diagnostics array contents, any thrown errors from unverified APIs like `getPluginFolder()`).

## Previous status (superseded above, kept for the spike-phase record): all verification is done.

Every required spike from the plan has passed, with live evidence (not guesses):

| Spike | Verified | Result |
|---|---|---|
| A | UXP can reach Auphonic (no CORS issue) | PASSED — real credit balance (21h) returned |
| B | Export just one clip's trimmed audio range, not the whole source file | PASSED — via a temporary subsequence, not `encodeFile`/`encodeProjectItem` directly |
| C | Disable a clip's audio without touching video; create a new track when none exists below | PASSED — both work, tested safely inside a disposable copy |
| D | `secureStorage` round-trips a value correctly | PASSED (after fixing a missing `TextDecoder`) |
| E | Full real Auphonic round trip: create production → upload → start → poll → download | PASSED — real file uploaded, processed, and downloaded successfully |

All of this was built and tested in a throwaway plugin at:
`/Users/anmolpreet/Documents/Awwphonic/spikes/spike-plugin/` (`manifest.json`, `index.html`, `main.js`)

This plugin is registered in Adobe UXP Developer Tools under the name **"Auphonic Spike Tests"**. It is safe to keep around as a live reference (it still works), or delete once Phase 1 supersedes it — user's call, don't delete without asking.

**Environment:** macOS, Premiere Pro 2026 (26.3.0), Adobe UXP Developer Tools installed, Node.js NOT installed (confirmed not needed — no build step, no npm runtime deps; UXP injects `require("premierepro")`/`require("uxp")` directly). User also has a Windows machine for later cross-platform testing (not yet done — flag as a pending follow-up when Phase 1 nears completion on macOS, per the PRD's cross-platform requirement).

Adobe's official sample repo (`AdobeDocs/uxp-premiere-pro-samples`) was cloned and used heavily to find real, working API patterns instead of guessing. It's been copied into this project for persistence at:
`/Users/anmolpreet/Documents/Awwphonic/reference/uxp-premiere-pro-samples/`
The most useful files inside it: `sample-panels/premiere-api/src/sequence.ts`, `sequenceEditor.ts`, `encoderManager.ts`, `import.ts`, `projectPanel.ts`, `workAreaUtils.ts`, and `index.ts` (shows how each function is actually called).

## Confirmed, real API patterns (verified live on this exact machine — use these directly, don't re-derive)

**Selection & export (the hard-won part):**
- `sequence.getSelection()` → `TrackItemSelection.getTrackItems()` → array of track items.
- `trackItem.getInPoint()`/`getOutPoint()` are relative to the *source media's own start*, not absolute — do NOT use these for placement math.
- `trackItem.getStartTime()`/`getEndTime()` are **timeline-space** positions — use these for placement and for Sequence In/Out.
- **`EncoderManager.encodeFile()` takes exactly 5 args**: `(mediaPath, outputPath, presetPath, inTickTime, outTickTime)`. Adobe's own developer.adobe.com docs list 3 more trailing params (`workArea`, `removeUponCompletion`, `startQueueImmediately`) that do NOT exist on this build and silently break the trim if passed — always verify against real sample code over docs.
- **Trimmed export does not work via `encodeFile`/`encodeProjectItem` with explicit in/out or workArea args** — they silently ignore the requested range and export the whole file, matching a real, Adobe-acknowledged bug class (Media Encoder/exportSequence defaulting to Work Area or full range regardless of explicit args). **The working approach**: narrow `sequence`'s own In/Out (`sequence.createSetInPointAction(tick)` / `createSetOutPointAction(tick)`, wrapped in `project.lockedAccess(() => project.executeTransaction((compoundAction) => {...}, "description"))`), call `sequence.createSubsequence(true)` to get a new Sequence scoped to exactly that range, then `EncoderManager.getManager().exportSequence(subsequence, ppro.Constants.ExportType.IMMEDIATELY, outputPath, presetPath)` to export the ENTIRE subsequence (which, by construction, is just the trim). Restore the original Sequence In/Out immediately after creating the subsequence (it's independent from then on). Delete the subsequence afterward with `project.deleteSequence(subsequence)` — check its return value, don't assume success. Also call `project.setActiveSequence(sequence)` before deleting, since creating a subsequence makes it the active tab and deleting the active tab can misbehave.
- **`ExportType.IMMEDIATELY` renders synchronously** — the resolved boolean from `exportSequence()` already means done; do not wait for `EVENT_RENDER_COMPLETE` (it never fires for this path — confirmed by writing files that were provably correct-duration despite my code "timing out" waiting for that event). `EncoderManager.launchEncoder()`/`startBatchEncode()` are irrelevant here (they open AME's queue, which is unused by IMMEDIATELY-mode exports — confirmed: AME opened with an empty queue).
- **`Sequence.getInPoint()`/`getOutPoint()` are a distinct thing from "Work Area"** — `ppro.WorkAreaUtils` (documented in Adobe's sample, used in `workAreaUtils.ts`) **does not exist on this Premiere build at all** (confirmed via live `Object.keys()` dump). Sequence's own In/Out, set via the actions above, is what actually works and is what "Create Subsequence" keys off.

**Placement/insertion:**
- `project.importFiles(filePaths: string[], suppressUI: boolean, projectBin: Bin|undefined, importAsNumberedStills: boolean)` — confirmed real, paths must be native OS paths.
- `ppro.SequenceEditor.getEditor(sequence)` → `sequenceEditor.createOverwriteItemAction(projectItem, tickTime, videoTrackIndex, audioTrackIndex)` and `createInsertProjectItemAction(projectItem, tickTime, videoTrackIndex, audioTrackIndex, limitedShift)` — both confirmed real, both take a `ProjectItem` + `TickTime` + numeric track indices (not Track/TrackItem objects), wrapped in the same `lockedAccess`/`executeTransaction` pattern.
- **Track auto-creation confirmed working**: calling `createInsertProjectItemAction` with a track index equal to the current track count (i.e., one beyond the last valid index) auto-creates a new track. Verified live: audio track count went 4→5 after inserting at index 4. No separate "addTrack" method exists anywhere — this is the only mechanism.
- **`trackItem.createSetDisabledAction(true)` confirmed working** (wrapped in the same transaction pattern), and `trackItem.isDisabled()` confirmed as the readback getter. Adobe's own sample never demonstrates this at all — it was a complete unknown before live testing.
- `projectItem.createSetNameAction(newName)` is the real rename method (not `setName()`/`createRenameAction()`), same transaction pattern.

**secureStorage & local files:**
- `uxp.storage.secureStorage.setItem(key, value)` / `.getItem(key)` (resolves `Uint8Array`) / `.removeItem(key)` — all confirmed working, all async.
- **`TextDecoder` does not exist in this UXP host** (confirmed live — genuine environment gap). Decode the `Uint8Array` from `secureStorage.getItem` manually; a working manual UTF-8 decoder is already written in the spike's `main.js` (`decodeUtf8` function) — reuse it as-is.
- Reading a local file's binary bytes: `file.read({ format: uxp.storage.formats.binary })` → `ArrayBuffer`. Omitting the `format` option defaults to UTF-8 text and **corrupts binary data** — always pass it explicitly for audio files.
- Writing a file: `folder.createFile(name, {overwrite: true})` → `file.write(data, {format: uxp.storage.formats.binary})` for binary; `getDataFolder()` gives the plugin's own sandboxed folder with no picker needed. Getting a `Folder` reference for an arbitrary **external** path (like a user-visible Documents subfolder) requires an interactive `getFolder()` picker — there is no confirmed silent "path string → Folder" constructor.

**Auphonic API (all confirmed live end-to-end):**
1. `POST /api/productions.json` with `{preset: <uuid or slug>, metadata: {title}}` → response `data.uuid`. **Not tested yet: explicit `output_files` field** — the test run didn't specify it and got back an MP3 (the preset's own default), not WAV. **Phase 1 must explicitly pass `output_files: [{format: "wav"}]`** to get the lossless output the PRD requires.
2. Upload: `POST /api/production/{uuid}/upload.json`, field name `input_file`, **must be multipart/form-data**.
   - **`FormData` + `Blob` does NOT work reliably in this UXP host** — confirmed live: uploads consistently failed with Auphonic's "File type is not supported" error regardless of filename, even though the file's bytes were independently verified intact (RIFF/WAVE header check passed). This matches a known, version-gated UXP limitation.
   - **Working fix: build the multipart body by hand.** A tested, byte-verified implementation (`buildMultipartBody`, `encodeAsciiBytes`, `concatBytes`) already exists in the spike's `main.js` — reuse it directly. Set `Content-Type: multipart/form-data; boundary=...` manually (never auto-added for a manual body) and send the resulting `ArrayBuffer` via `xhr.send()`.
3. `POST /api/production/{uuid}/start.json` — starts processing.
4. `GET /api/production/{uuid}/status.json` — poll. `status: 3` = done, `status: 2` = error (check `error_message`). Other values are in-progress phases.
5. `GET /api/production/{uuid}.json` → `data.output_files[]`, each with a `download_url`.
6. Download: plain GET on `download_url` with `?bearer_token={api_key}` appended. **Must use `responseType: "arraybuffer"` and read `xhr.response`**, not `xhr.responseText` — the latter corrupts binary downloads the same way an unflagged local file read does. Confirmed working end-to-end.
- Auth header for all authenticated calls: `Authorization: bearer {api_key}` (lowercase `bearer`).
- A real, working preset identifier used in testing: `auphonic_studiovoice` — note Auphonic's built-in presets can be slug-like strings, not always canonical UUID format; don't validate the format strictly.

## Decisions already locked in (do not re-litigate)

- Clip pattern unknown → follow the PRD's default phase order, do not front-load Phase 4 batch consolidation.
- Effects mode (Phase 5) is **not needed** — audio is always cleaned from raw source. Drop it entirely.
- WAV is the default and only Phase 1 output format (per PRD) — remember to pass `output_files` explicitly (see above).
- Windows testing is planned but deferred until macOS Phase 1 is solid.

## What Phase 1 actually needs (from the plan file, section 4)

Build the **real plugin** (not more spikes) at the project root `/Users/anmolpreet/Documents/Awwphonic/` — `manifest.json`, `index.html`, `src/main.js` etc., per the folder structure in the plan file's section 2. In order:
1. Skeleton panel (loads, shows placeholder)
2. API key entry + `secureStorage` persistence + live credit balance display
3. Preset dropdown (fetch via `/api/presets.json?minimal_data=1&preset_type=all_presets`, store by UUID/slug not name)
4. Clip selection + eligibility validation with named skip reasons (multicam, offline, proxy, etc. — `ClipProjectItem` exposes these checks per PRD 9.1)
5. Cost estimate (`billable = max(duration, 3min)`) shown before anything uploads, requiring explicit user confirmation
6. Export via the proven subsequence approach above
7. Auphonic upload → start → poll → download, using the confirmed API shapes and manual multipart body above
8. Timeline placement: import → rename → target `originalTrackIndex + 1` (auto-creates via the confirmed insert-beyond-count trick) → place via `createOverwriteItemAction` → disable original audio only, **after** placement succeeds (never before)
9. Per-job JSON state file for diagnosis (PRD 9.3 shape — include the unused-in-Phase-1 `productionId`/`consolidationOffsetMs`/`consolidationDurationMs` fields from day one, per PRD section 5's explicit warning)
10. Basic error handling using PRD 9.10's named categories + cache folder housekeeping buttons

Read the plan file in full before starting — it has the complete Phase 1 checklist, default settings (PRD section 12), and what's explicitly out of scope for Phase 1 (handles, multi-clip queue, linked video-audio, MP3/AAC, label colors, bins, collision handling).

## How to work with this user

Non-technical — explain plain-language consequences of technical choices, not the mechanics. Verify every Premiere/UXP API claim live before building UI around it (this session learned that hard, repeated lesson multiple times — docs and even Adobe's own sample repo can be wrong or incomplete; only live-tested evidence counts). When something fails, add a diagnostic that proves the *cause*, not just another guess at a fix. The user has been extremely patient through a long debugging process and explicitly asked for thoroughness over speed — keep that standard.
