# Auphonic Premiere Plugin — Handoff for Phase 2

Paste this entire document as your first message in a new session to continue this project. It contains everything learned across setup, the spike phase, and the full Phase 1 build (including three real bugs found and fixed via live testing), so a new session can start Phase 2 immediately without repeating any research.

## What this project is

Building a UXP plugin for Adobe Premiere Pro 2026 that lets an editor select one clip on the timeline, click a button, and have Auphonic (a cloud audio-cleanup service) clean its audio — with the cleaned result automatically placed on the track below, correctly aligned, and the original clip's audio disabled (never deleted). Full spec: `/Users/anmolpreet/Downloads/Auphonic_Premiere_Extension_PRD.md`.

The project's product owner (Kan, Studio Production Manager) is **non-technical**; the person actually running these Claude Code sessions (Anmolpreet) is technical and is building this on Kan's behalf. This distinction matters: talk to the chat operator (Anmolpreet) at a normal technical level, but everything the *plugin itself* surfaces — panel copy, button labels, error messages — must stay plain-language, since Kan is who actually uses the finished tool.

The original build plan (setup, spikes, and the Phase 1 breakdown — Phase 2 is not covered by it) was approved and lives at:
`/Users/anmolpreet/.claude/plans/users-anmolpreet-downloads-auphonic-pre-nested-mccarthy.md`

**No detailed, approved plan exists yet for Phase 2** — unlike Phase 1, which had a full step-by-step plan written and approved before any code was touched. The PRD only describes Phase 2's scope at a high level (see "Phase 2 scope" below, which collects every relevant PRD detail so a new session doesn't have to re-read the whole PRD). Consider drafting and getting a short Phase 2 plan approved first, the same way Phase 1 was handled, rather than jumping straight to code — this matches how the project has worked so far and the user has explicitly valued that thoroughness.

## Environment

- macOS. Premiere Pro 2026 (26.3.0), developer mode enabled. Adobe UXP Developer Tools installed.
- **Node.js is NOT installed, and confirmed not needed.** No build step, no bundler, no npm runtime deps. `package.json`/`jsconfig.json` exist only so editor autocomplete works if Node/`@adobe/premierepro` types are ever added later.
- All plugin JS files are loaded as plain `<script>` tags (see "Module loading" under Confirmed API patterns) — there is nothing to compile.
- User also has a **Windows machine**, not yet used for any testing. The PRD requires both platforms; Windows verification has been deferred throughout and is still fully untouched. Known Windows-specific risk already flagged: the bundled WAV export preset (`assets/presets/Waveform Audio 48kHz 16-bit.epr`) was copied from this Mac's Adobe Media Encoder install and has not been confirmed to work on Windows — Windows will likely need its own preset file exported from a Windows AME install.
- No syntax-checking tool exists for UXP JS beyond a manual trick used throughout this project: `osascript -l JavaScript <checker script>` (JavaScriptCore via macOS's built-in JXA), since there's no Node here. Useful for catching typos before ever loading a change into Premiere.

## Version control

The project is on GitHub, connected and pushed, currently fully up to date (nothing uncommitted as of this write-up — verify with `git status` before trusting that):
**https://github.com/anmol-4-real/auphonic-premiere-plugin** (private repo)

- `gh` (GitHub CLI) is installed at `~/.local/bin/gh` (not on PATH by default — run `export PATH="$HOME/.local/bin:$PATH"` first, or use the full path). Already authenticated as `anmol-4-real`; git uses `gh` as its credential helper, so `git push`/`git pull` work without further login.
- Local git identity for this repo only: name `Anmolpreet`, email `anmolpreet@hackerrank.com`.
- `.gitignore` excludes: `reference/` (Adobe's sample repo — re-clone with `git clone https://github.com/AdobeDocs/uxp-premiere-pro-samples.git reference/uxp-premiere-pro-samples` if needed again), `Test Exports/`, `.claude/`, `.DS_Store`.
- **User wants to be asked before every commit, and separately before every push** — don't do either proactively. This has been asked and answered explicitly; don't re-ask the general preference, just follow it (asking about each *specific* commit/push is still expected — the preference is about cadence, not a one-time blanket approval).
- Commit history: (1) spike plugin + earliest handoff doc, (2) first full Phase 1 build (written but not yet live-tested at that point), (3) all fixes found during live testing (module loading, media-type detection, `importFiles` args) — this is the current `main` HEAD, and it's the one that reflects a fully working, live-verified Phase 1.

## Project history

### 1. Setup (done)

Creative Cloud desktop app, Adobe UXP Developer Tools, and Premiere Pro developer mode were all confirmed installed/enabled before any code was written. Auphonic API key obtained by the user directly (never shared in chat, stored only via UXP `secureStorage` inside the plugin).

### 2. Spike phase (done) — de-risking before real code

A throwaway plugin at `/Users/anmolpreet/Documents/Awwphonic/spikes/spike-plugin/` (own manifest, id `com.hackerrank.auphonic-spike`, registered in UDT as **"Auphonic Spike Tests"**) tested every risky assumption before Phase 1 was written. All passed, with live evidence:

| Spike | Verified | Result |
|---|---|---|
| A | UXP can reach Auphonic (no CORS issue) | PASSED — real credit balance returned |
| B | Export just one clip's trimmed audio range, not the whole source file | PASSED — via a temporary subsequence, not `encodeFile`/`encodeProjectItem` directly |
| C | Disable a clip's audio without touching video; create a new track when none exists below | PASSED — both work, tested safely inside a disposable copy |
| D | `secureStorage` round-trips a value correctly | PASSED (after fixing a missing `TextDecoder`) |
| E | Full real Auphonic round trip: create production → upload → start → poll → download | PASSED — real file uploaded, processed, and downloaded successfully |

The spike plugin still exists and still works — kept as a live reference, not deleted (ask the user before deleting it; last known preference was to keep it around). Adobe's official sample repo (`AdobeDocs/uxp-premiere-pro-samples`) was cloned into `/Users/anmolpreet/Documents/Awwphonic/reference/uxp-premiere-pro-samples/` for persistent reference — most useful files: `sample-panels/premiere-api/src/sequence.ts` (also has an `addHandlesToTrackItem` function directly relevant to Phase 2's handles feature), `sequenceEditor.ts`, `encoderManager.ts`, `import.ts`, `projectPanel.ts`, `workAreaUtils.ts`, `index.ts` (shows how each function is actually called).

### 3. Phase 1 build (done, fully live-verified)

Built at the project root: `manifest.json`, `package.json`, `jsconfig.json`, `index.html`, `assets/presets/Waveform Audio 48kHz 16-bit.epr` (bundled WAV export preset), and `src/{main.js, ui/{panel.js, styles.css}, core/{selection,export,auphonicClient,insertion,costEstimate,cache,jobModel,errors}.js, lib/{secureStorage,paths}.js}`.

**Confirmed working end to end, in real Premiere, on a real clip**: connect with a real API key → credits and 11 real presets load and persist across panel reopen → select a real audio clip → eligibility check passes → cost estimate shown (3-minute-minimum warning included) → explicit Confirm & Process click required before anything uploads → export → Auphonic upload → processing → download → cleaned audio imported, correctly renamed to `OriginalClipName_Auphonic_PresetName.wav`, and placed on the timeline underneath the original → original clip's audio disabled (confirmed by direct visual check — not deleted) → user confirmed the output audio quality is good. A selected video clip is correctly rejected as ineligible rather than silently accepted.

**Full Phase 1 checklist status (all confirmed with real evidence, not just code review):**

| # | Item | Status |
|---|---|---|
| 1 | Skeleton panel loads | ✅ Confirmed |
| 2 | API key + `secureStorage` + credit balance | ✅ Confirmed (persists across panel close/reopen) |
| 3 | Preset dropdown | ✅ Confirmed (11 real presets loaded) — not cross-checked name-for-name against auphonic.com's own list, low-risk |
| 4 | Clip selection + eligibility, named skip reasons | ✅ Confirmed for "video clip selected." Not individually tested (same mechanism, low priority): offline media, multicam, merged clip, proxy, multi-selection reject |
| 5 | Cost estimate + explicit confirmation gate | ✅ Confirmed |
| 6 | Export via subsequence | ✅ Confirmed indirectly (correct-sized `input.wav` fed a successful upload) |
| 7 | Upload → process → download | ✅ Confirmed (real Auphonic production ran, output audio quality confirmed good by the user) |
| 8 | Timeline placement + disable original | ✅ Confirmed directly on the real timeline |
| 9 | Per-job JSON state file | ✅ Confirmed — `job.json` opened directly, contains clip name/preset/status as expected |
| 10 | Error handling + cache housekeeping buttons | ✅ Error handling well-proven (every failure below surfaced a specific, named, non-destructive error). "Clean Failed Temp Files" and "Delete Completed Input Temp Files" both confirmed working correctly. "Reveal Cache Folder" does **not** open Finder — degrades gracefully to printing the path instead, an accepted limitation (see below), not a bug |

**Three real bugs found and fixed during live testing** (the pattern every time: a PRD/sample-derived assumption didn't hold on this exact build, diagnosed with live evidence — a console error, a shape dump of the real object — not guessed at twice):

1. **Local `require()` between our own files does not work in this UXP host.** A `<script src="src/main.js">`-loaded entry point has no tracked "home folder," so its relative `require()` calls resolve against the plugin root instead of its own folder (confirmed via the exact console error: `Uncaught Error: Module not found: "./ui/panel.js". Parent module folder was: "./"`). This silently broke the entire panel on first load — no click handlers were ever attached, which is why "Save Key & Connect" appeared to do nothing at all. **Fixed**: every local file now wraps itself in an IIFE and publishes its API onto a shared `window.Auphonic.<name>` namespace instead of using `module.exports`; `index.html` loads every file as its own `<script>` tag, in dependency order, ending with `main.js`. `require("premierepro")`/`require("uxp")` remain untouched — those two host modules work fine from any script context, confirmed since the spike phase.
2. **Media type (audio vs. video) cannot be determined by matching timeline position.** The first fix attempt walked tracks looking for a track item at the same start/end tick as the selection — but a video clip's linked audio sits at the *exact same* timeline position by definition, so this always found the linked audio first and misreported a selected **video** clip as eligible **audio**. The obvious next guess, `ppro.AudioClipTrackItem.cast()`/`ppro.VideoClipTrackItem.cast()` (modeled on the working `ClipProjectItem.cast()`), was tried and confirmed live NOT to exist on this build. **Fixed** using real evidence from a live shape dump of the actual selected trackItem object (dumping `constructor.name`, own/prototype property names, and matching `ppro` keys — the same technique that resolved the encodeFile-arity and WorkAreaUtils mysteries during the spike phase): `ppro.AudioClipTrackItem`/`ppro.VideoClipTrackItem` **are** real classes on this build (just without a `.cast()` static method), and `trackItem instanceof ppro.VideoClipTrackItem` correctly resolves (confirmed live: `trackItem.constructor.name` read exactly `"VideoClipTrackItem"` for a selected video clip). `instanceof` is the primary check now, constructor-name string match is a fallback, and the old tick-position heuristic is a last-resort fallback only, clearly flagged in a `diagnostics` array if it's ever reached.
3. **`project.importFiles([path], true, undefined, false)` — the exact 4-arg call from Adobe's own sample — threw `Illegal Parameter type` on this build.** Same class of quirk as `encodeFile`'s arg-count mismatch found during the spike phase: this build's native binding likely doesn't accept an explicit `undefined`/`false` for the optional trailing args the same way it accepts them being simply absent. **Fixed** by calling `project.importFiles([String(path)], true)` (2 args, path coerced to a plain string) — confirmed live to work.

**Deliberate scope decisions made while building Phase 1** (see "Decisions already locked in" below for the full list) — most relevant to know before starting Phase 2: video clips are currently rejected outright with a named reason rather than attempting any linked-audio resolution (that's exactly what Phase 2 needs to add), and there is no collision detection at all yet on the destination track (also exactly what Phase 2 needs to add).

## Confirmed, real API patterns (verified live on this exact machine — use these directly, don't re-derive)

**Module loading:**
- No bundler, no build step. Every file in `src/` wraps its body in an IIFE and assigns its public API onto `window.Auphonic.<name>` (e.g. `window.Auphonic.selection`, `window.Auphonic.insertion`). `index.html` loads each file via its own `<script src="...">` tag, in dependency order (leaves first: `lib/secureStorage.js`, `lib/paths.js`, `core/errors.js`; then everything that depends on those; `ui/panel.js` second-to-last; `main.js` last). Cross-file dependencies read from the shared namespace instead of `require()`-ing each other. `require("premierepro")`/`require("uxp")` remain the normal way to reach those two host-injected modules from any file — this part was never broken.

**Selection & media type:**
- `sequence.getSelection()` → `TrackItemSelection.getTrackItems()` → array of track items.
- `trackItem.getInPoint()`/`getOutPoint()` are relative to the *source media's own start* — never use for placement math. `trackItem.getStartTime()`/`getEndTime()` are timeline-space — use these for placement and Sequence In/Out.
- `TickTime.ticksNumber` (a plain number property) is the real way to read raw ticks off a TickTime object — not `.ticks`. Confirmed by reading Adobe's own sample (`sequence.ts`'s handles-calculation code, ~line 392), not by live testing directly, but consistent with everything else observed.
- **Media type**: `trackItem instanceof ppro.VideoClipTrackItem` / `instanceof ppro.AudioClipTrackItem` correctly identifies which kind of track item is selected (confirmed live). `.cast()` does **not** exist on either of those classes on this build (unlike `ClipProjectItem.cast()`, which does exist and works — confirmed live in the spike phase). Do NOT infer media type by matching timeline position across tracks — a video clip's linked audio occupies the identical position by definition, and this reliably misclassifies it (see bug #2 above). **Directly relevant to Phase 2's linked-audio resolution**: the PRD (9.1) says to locate a video clip's linked audio by "matching the same project item plus an overlapping timeline range" — `getProjectItem()` on both the video and its linked audio trackItem should return the same underlying media reference, so that plus an overlapping-range check (not an exact-match check, which is what caused bug #2) is the right combination once you already know, via `instanceof`, that you're specifically looking for the *other* type of trackItem.
- Track index for a given track item is derived by walking `sequence.getAudioTrack(i)`/`getVideoTrack(i)` (matching an item's own list) and matching by exact tick position (no confirmed `getTrackIndex()` method exists, despite the PRD asserting one) — this part is fine and unchanged, only the media-*type* determination changed in the bug-2 fix.

**Export (subsequence approach):**
- `EncoderManager.encodeFile()` takes exactly 5 args; trimmed export via `encodeFile`/`encodeProjectItem` with explicit in/out silently exports the whole file regardless, matching a real Adobe-acknowledged bug class. Working approach: narrow the sequence's own In/Out via `sequence.createSetInPointAction(tick)`/`createSetOutPointAction(tick)` (wrapped in `project.lockedAccess(() => project.executeTransaction((compoundAction) => {...}, "description"))`), call `sequence.createSubsequence(true)` to get a new Sequence scoped to exactly that range, then `EncoderManager.getManager().exportSequence(subsequence, ppro.Constants.ExportType.IMMEDIATELY, outputPath, presetPath)` to export the whole subsequence (which, by construction, is just the trim). Restore the original sequence In/Out immediately after creating the subsequence — it's independent from then on. Delete the subsequence afterward with `project.deleteSequence(subsequence)` and check its return value — a resolved promise doesn't guarantee real deletion. Call `project.setActiveSequence(sequence)` before deleting, since creating a subsequence makes it the active tab.
- `ExportType.IMMEDIATELY` renders synchronously — the resolved boolean already means done. Do not wait for `EVENT_RENDER_COMPLETE`; it never fires for this path.
- `ppro.WorkAreaUtils` does not exist on this Premiere build at all (confirmed via a live `Object.keys()` dump). Sequence's own In/Out (via the actions above) is the real mechanism, and is what "Create Subsequence" keys off.
- The WAV export preset is bundled with the plugin at `assets/presets/Waveform Audio 48kHz 16-bit.epr` (copied from this Mac's AME 2026 install) rather than referenced by an absolute AME install path. Read via `uxp.storage.localFileSystem.getPluginFolder()` — confirmed working live now that the full export step has succeeded end-to-end.

**Placement/insertion:**
- `project.importFiles(filePaths, suppressUI)` — **only 2 args work on this build.** Adobe's own sample's 4-arg form (`filePaths, true, undefined, false`) throws `Illegal Parameter type`. Also coerce the path to a plain string (`String(path)`) as a second layer of defense against the same error.
- `ppro.SequenceEditor.getEditor(sequence)` → `createOverwriteItemAction(projectItem, tickTime, videoTrackIndex, audioTrackIndex)` / `createInsertProjectItemAction(projectItem, tickTime, videoTrackIndex, audioTrackIndex, limitedShift)` — both confirmed real, both take a `ProjectItem` + `TickTime` + numeric track indices (not Track/TrackItem objects), wrapped in the same `lockedAccess`/`executeTransaction` pattern.
- **Track auto-creation is confirmed working only for `createInsertProjectItemAction`** (inserting at a track index equal to the current track count auto-creates a new track — verified live in the spike phase, audio track count went 4→5). No such confirmation exists for `createOverwriteItemAction` at an out-of-range index, and no separate "addTrack" method exists anywhere. Phase 1's placement logic therefore branches: use insert (with `limitedShift: true`, to avoid rippling) only when no track exists below the original; use overwrite (per the PRD's explicit preference, to avoid rippling) when a track already exists below. On a brand-new empty track these two have identical effect anyway, since there's nothing to shift.
- `trackItem.createSetDisabledAction(true)` confirmed working (Adobe's own sample never demonstrates this at all — it was a complete unknown before live testing in the spike phase), and `trackItem.isDisabled()` confirmed as the readback getter.
- `projectItem.createSetNameAction(newName)` is the real rename method (not `setName()`/`createRenameAction()`).
- **Collision detection (needed for Phase 2) has no confirmed API at all yet** — nothing in this project has ever checked whether a destination track already has content at a given time range. This will need its own research/spike-style verification before Phase 2 builds on it; don't assume a method exists without checking the reference sample and/or testing live first.

**secureStorage & local files:**
- `uxp.storage.secureStorage.setItem(key, value)` / `.getItem(key)` (resolves `Uint8Array`) / `.removeItem(key)` — all confirmed working, all async.
- `TextDecoder` does not exist in this UXP host (confirmed live — a genuine environment gap). Decode the `Uint8Array` from `secureStorage.getItem` manually — a working manual UTF-8 decoder exists in `src/lib/secureStorage.js`'s `decodeUtf8` function, reuse it as-is.
- Reading a local file's binary bytes: `file.read({ format: uxp.storage.formats.binary })` → `ArrayBuffer`. Omitting the `format` option defaults to UTF-8 text and **corrupts binary data** — always pass it explicitly for audio files. `{ format: uxp.storage.formats.utf8 }` is the confirmed-working counterpart for text (job JSON files).
- Build every path via a real Folder/File entry's own `.nativePath` (e.g. `folder.createFile(name, {overwrite: true})`), never by string-concatenating paths — this is how `src/lib/paths.js` is structured throughout.
- `uxp.shell.openPath()` (used for the "Reveal Cache Folder" button) is **not a confirmed real API on this build** — it doesn't throw, but it also doesn't actually open Finder; the button degrades gracefully to just printing the path instead, which is accepted as-is, not chased further. Nothing in Adobe's own sample repo demonstrates this API either. **Relevant to Phase 2's "open production in browser" feature**: the confirmed-real pattern for opening something externally is `require("uxp").shell.openExternal(url)` (found in the reference repo's `oauth-workflow-sample/index.js`, used to open a login URL) — this is a *different* function than `openPath` and has real precedent, so it's the one to try first for opening an Auphonic production page, not `openPath`. The exact URL format for an Auphonic production's own web page has not been researched/confirmed anywhere in this project yet.

**Auphonic API (all confirmed live end-to-end, including the real Phase 1 pipeline, not just the spike):**
1. `POST /api/productions.json` with `{preset: <uuid or slug>, metadata: {title}, output_basename: <safe_name>, output_files: [{format: "wav"}]}` → response `data.uuid`. `output_files` must be passed explicitly — omitting it silently returns the preset's own default output (an MP3 in testing), not the WAV Phase 1 requires.
2. Upload: `POST /api/production/{uuid}/upload.json`, field name `input_file`, **must be multipart/form-data, built by hand.** `FormData` + `Blob` does NOT work reliably in this UXP host — confirmed live twice now (spike phase and again structurally in Phase 1): uploads consistently fail with Auphonic's "File type is not supported" error regardless of filename, even with independently-verified-intact file bytes. The working fix (`buildMultipartBody`/`encodeAsciiBytes`/`concatBytes` in `src/core/auphonicClient.js`) builds the exact multipart bytes by hand and sets `Content-Type: multipart/form-data; boundary=...` manually.
3. `POST /api/production/{uuid}/start.json` — starts processing.
4. `GET /api/production/{uuid}/status.json` — poll with backoff (~10s initially, then 20-30s). `status: 3` = done, `status: 2` = error (check `error_message`).
5. `GET /api/production/{uuid}.json` → `data.output_files[]`, each with a `download_url`.
6. Download: plain GET on `download_url` with `?bearer_token={api_key}` appended, `responseType: "arraybuffer"`, read `xhr.response` (never `xhr.responseText`, which corrupts binary the same way an unflagged local file read does).
- Auth header for all authenticated calls: `Authorization: bearer {api_key}` (lowercase `bearer`).
- A real, working preset identifier used throughout testing: `auphonic_studiovoice` (also tested live: "Studio Voice (Beta)", one of 11 real presets on the account). Auphonic's built-in presets can be slug-like strings, not always canonical UUID format — don't validate the format strictly.
- **Retry rule (PRD 9.4, relevant to Phase 2/4 error recovery, not yet implemented anywhere):** reuse the existing production UUID on retry — creating a new production with new input is billed again. Nothing in the current code implements retry at all yet (Phase 1 has no retry button).

## Decisions already locked in (do not re-litigate)

- Clip pattern unknown → follow the PRD's default phase order, do not front-load Phase 4 batch consolidation.
- Effects mode (Phase 5) is **not needed** — audio is always cleaned from raw source. Dropped entirely from the plan.
- WAV is the default and only output format so far (Phase 1's only option; MP3/AAC are explicitly Phase 3 scope).
- Windows testing is planned but has been deferred through all of Phase 1; still fully untouched.
- No `command` entrypoint in the manifest — only the panel, so the cost-estimate confirmation gate always has a place to show itself before any credits are spent. Revisit if Phase 2 or later wants a faster path in, but keep the confirmation gate wherever that path leads.
- A selected video clip is currently rejected outright (named reason) rather than attempting linked-audio resolution — **this is exactly Phase 2's job to change.**
- No collision detection on the destination track exists yet — **this is exactly Phase 2's job to add.**
- Bin creation and label colors are skipped entirely (Phase 3 scope).
- Multi-selection is rejected with a message rather than silently processing only the first item (unchanged for Phase 2 — batch/multi-select is Phase 4 scope).

## Phase 2 scope (not yet started — no plan file exists yet, only this PRD-derived summary)

Per PRD section 11's phase list, Phase 2 ("Editing ergonomics") covers four things. "Reveal cache" was pulled forward into Phase 1 already (its housekeeping buttons exist and are confirmed working, minus the Finder-opening part — see above), so it's not listed again below.

**1. Handles, with clamping and warnings (PRD 9.6, defaults in PRD 12):**
- Handles default to **off**; when enabled, default is **2.0 seconds**.
- **Handles off** (current Phase 1 behavior): export the exact selected timeline duration, insert at the exact same start and duration underneath.
- **Handles on**: export the selected duration *plus* handle seconds before and after; insert starting handle-seconds *before* the original start. Worked example from the PRD:
  ```
  Original clip:      00:10:00:00 to 00:10:12:00
  Handles:            2 sec
  Exported range:     00:09:58:00 to 00:10:14:00
  Inserted clip:      starts at 00:09:58:00, underneath the original
  Original disabled:  still spans 00:10:00:00 to 00:10:12:00
  ```
- **Clamping**: when a handle would exceed the available source media, or would place the clip before the sequence start, clamp it and warn — e.g. "Left handle reduced from 2.0s to 0.6s because source media starts there."
- Handles are not meaningful for whole-clip Project-panel jobs (Phase 6 scope) — ignore them there, with a UI note, when that phase eventually exists.
- Adobe's sample repo has a directly relevant worked function: `addHandlesToTrackItem` in `reference/uxp-premiere-pro-samples/sample-panels/premiere-api/src/sequence.ts` (~line 318) — it deals with the same source/sequence-timebase-ratio math this feature will need. Worth reading before implementing, though (per this project's whole hard-won lesson) it still needs to be verified live on this exact build, not trusted blindly.

**2. Video clip selection with linked-audio resolution (PRD 9.1, 9.5):**
- Currently a selected video clip is rejected outright. Phase 2 needs to instead: locate the associated audio item by matching the same project item plus an *overlapping* timeline range (not an exact match — exact-match-by-position is precisely the bug that had to be fixed in Phase 1's own media-type detection, see bug #2 above, so don't reuse that logic here without adjusting it).
- Process and disable only the audio item. **Never touch the video item** — disabling video would hide the picture.
- For grouped selections and video clips with linked audio generally: disable only the original audio item(s), never video.

**3. Insertion collision detection and prompt (PRD 9.5):**
- Currently: none at all. `createOverwriteItemAction`/insert will silently place the clip, replacing whatever's already there on an existing destination track.
- Needed: detect whether the destination track already has media at the target time range, and if so, prompt rather than assume — PRD's suggested wording: "Destination track already has media at this time. Create a new track underneath and insert there?"
- No API for checking track content at a given range has been researched or tested anywhere in this project yet — this needs its own verification pass (read the reference sample for a `getTrackItems`-based overlap check, or something similar; test live before building UI on top of it, per this project's standing rule).

**4. Open production in browser (PRD, implied by Phase 2's "editing ergonomics" framing, not spelled out in exhaustive detail elsewhere):**
- Confirmed-real building block: `require("uxp").shell.openExternal(url)` (see "Confirmed API patterns" above) — a *different*, better-precedented function than the `openPath` that didn't pan out for the cache-folder button.
- The actual URL format for an Auphonic production's own web page has not been researched or confirmed. Look this up on Auphonic's own site/docs (or infer it from the production data already being fetched) before building the button — don't guess the URL pattern.

**Also worth deciding early in the Phase 2 session, not carried over from any prior decision:** whether to draft and get a short Phase 2 plan approved first (mirroring how Phase 1 was handled) before writing any code, given no such plan exists yet.

## How to work with this user

Verify every Premiere/UXP API claim live before building UI around it — this project has hit this lesson repeatedly (encodeFile's arg count, `WorkAreaUtils` missing, `require()` module resolution, `AudioClipTrackItem.cast()` missing, `importFiles`'s real arg count) and every single time, live evidence settled it in one pass while guessing would have taken several rounds. When something fails, add a diagnostic that proves the *cause* — a console log, a live shape dump of the real object (`constructor.name`, `Object.getOwnPropertyNames`, relevant `ppro` keys) — rather than guessing at a fix a second time. This exact technique (a live shape dump) is what resolved the media-type bug during Phase 1's own testing, and is very likely to be needed again for Phase 2's collision-detection research.

The user has been extremely patient through a long debugging process and has explicitly asked for thoroughness over speed — keep that standard. Ask before every commit and, separately, before every push (see Version control above) — this has been asked and answered once; don't re-ask the general preference, just follow it for each specific action. Talk to the chat operator (Anmolpreet, technical) normally; keep the plugin's own UI copy (button labels, error/status messages) plain-language, since Kan (the non-technical product owner) is the one who actually uses the finished panel.
