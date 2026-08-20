# Auphonic Premiere Plugin — Handoff

Paste this entire document as your first message in a new session to continue this project. It contains everything learned from setup, verification, and the first live test pass, so a new session can pick up immediately without repeating any research.

## What this project is

Building a UXP plugin for Adobe Premiere Pro 2026 that lets an editor select one clip on the timeline, click a button, and have Auphonic (a cloud audio-cleanup service) clean its audio — with the cleaned result automatically placed on the track below, correctly aligned, and the original clip's audio disabled (never deleted). Full spec: `/Users/anmolpreet/Downloads/Auphonic_Premiere_Extension_PRD.md`. The project's product owner (Kan, Studio Production Manager) is **non-technical**; the person actually running these Claude Code sessions (Anmolpreet) is technical and is building this on Kan's behalf — see saved memory for that distinction, it doesn't need repeating in the panel's own code, only in how the panel's UI copy reads.

The full build plan (setup, spikes, and Phase 1 breakdown) was approved and lives at:
`/Users/anmolpreet/.claude/plans/users-anmolpreet-downloads-auphonic-pre-nested-mccarthy.md`

## Version control

The project is on GitHub, connected and pushed:
**https://github.com/anmol-4-real/auphonic-premiere-plugin** (private repo)

- `gh` (GitHub CLI) is installed at `~/.local/bin/gh` (not on PATH by default — run `export PATH="$HOME/.local/bin:$PATH"` first, or use the full path). Already authenticated as `anmol-4-real`; git uses `gh` as its credential helper, so `git push`/`git pull` work without further login.
- Local git identity for this repo only: name `Anmolpreet`, email `anmolpreet@hackerrank.com`.
- `.gitignore` excludes: `reference/` (Adobe's sample repo — re-clone with `git clone https://github.com/AdobeDocs/uxp-premiere-pro-samples.git reference/uxp-premiere-pro-samples` if needed again), `Test Exports/`, `.claude/`, `.DS_Store`.
- **User wants to be asked before every commit** — don't commit proactively, propose it and wait for a go-ahead each time (this was asked and answered explicitly; don't re-ask, just follow it).
- Commit history so far: (1) spike plugin + early handoff doc, (2) first full Phase 1 build (untested). A third commit covering the live-testing fixes below is pending as of this write-up — check `git log`/`git status` for the current real state rather than trusting this document's memory of it.

## Current status (2026-08-20): Phase 1 is complete and fully live-verified. Not yet committed/pushed as of this write-up.

Confirmed working via actual testing in Premiere, not just code review: connect with a real API key → credits and 11 real presets load → select a real audio clip → eligibility check passes → cost estimate with the 3-minute-minimum warning shown → Confirm & Process → export → Auphonic upload → processing → download → cleaned audio imported, correctly renamed, and placed on the timeline underneath the original → **original clip's audio disabled (not deleted, confirmed by direct visual check) → user confirmed the output audio quality is good.** A selected video clip is correctly rejected as ineligible instead of silently accepted (see bug #2 below). Every row of the Phase 1 checklist (below) is now checked off with real evidence, including `job.json`'s contents and all three cache-housekeeping buttons.

Three real, live-discovered-and-fixed bugs along the way — the pattern each time was: something in the PRD/sample-code-derived assumption didn't hold on this exact build, diagnosed with live evidence (console errors, a shape dump of the actual object), not guessed at twice:

1. **Local `require()` between our own files does not work in this UXP host.** A `<script src="src/main.js">`-loaded entry point has no tracked "home folder," so its relative `require()` calls resolve against the plugin root instead of its own folder (confirmed via the exact console error: `Module not found: "./ui/panel.js". Parent module folder was: "./"`). This silently broke the entire panel — no click handlers were ever attached. **Fixed**: every local file now wraps itself in an IIFE and publishes its API onto a shared `window.Auphonic.<name>` namespace instead of `module.exports`; `index.html` loads every file as its own `<script>` tag in dependency order (see the list there), ending with `main.js`. `require("premierepro")`/`require("uxp")` are untouched — those are host-injected and work fine in any script context.
2. **Media type (audio vs. video) cannot be determined by matching timeline position.** The original code walked tracks looking for a track item at the same start/end tick as the selection — but a video clip's linked audio sits at the *exact same* position by definition, so this always found the linked audio first and misreported a selected video clip as eligible audio. `ppro.AudioClipTrackItem.cast()`/`ppro.VideoClipTrackItem.cast()` (the obvious next guess, modeled on `ClipProjectItem.cast()`) were tried and confirmed live NOT to exist on this build. **Fixed** using real evidence from a live shape dump of the actual selected object: `ppro.AudioClipTrackItem`/`ppro.VideoClipTrackItem` **are** real classes on this build (just without `.cast()`), and `trackItem instanceof ppro.VideoClipTrackItem` correctly resolves (confirmed: `trackItem.constructor.name` read exactly `"VideoClipTrackItem"` for a selected video clip). `instanceof` is now the primary check, constructor-name string match is a fallback, and the old tick-position heuristic is a last-resort fallback only, clearly flagged if it's ever reached.
3. **`project.importFiles([path], true, undefined, false)` — the exact 4-arg call from Adobe's own sample — threw `Illegal Parameter type` on this build.** Same class of quirk as `encodeFile`'s arg-count mismatch found during the spike phase: this build's native binding likely doesn't accept an explicit `undefined`/`false` for the optional trailing args the way it accepts them being simply absent. **Fixed** by calling `project.importFiles([String(path)], true)` (2 args, path coerced to a plain string) — confirmed live to work (the file now imports and places correctly).

**Phase 1 checklist (build plan section 4) — all confirmed with real evidence:**

| # | Item | Status |
|---|---|---|
| 1 | Skeleton panel loads | ✅ Confirmed |
| 2 | API key + `secureStorage` + credit balance | ✅ Confirmed (persists across panel close/reopen) |
| 3 | Preset dropdown | ✅ Confirmed (11 real presets loaded) — not cross-checked name-for-name against auphonic.com's own list, low-risk |
| 4 | Clip selection + eligibility, named skip reasons | ✅ Confirmed for "video clip selected." Optional/not done: offline media, multicam, merged clip, proxy, multi-selection reject — same underlying mechanism, low priority, skip unless a real test clip is on hand |
| 5 | Cost estimate + explicit confirmation gate | ✅ Confirmed (3-minute-minimum warning shown, nothing uploaded before Confirm click) |
| 6 | Export via subsequence | ✅ Confirmed indirectly (correct-sized `input.wav` fed a successful upload) |
| 7 | Upload → process → download | ✅ Confirmed (real Auphonic production ran, user confirmed output audio quality) |
| 8 | Timeline placement + disable original | ✅ Confirmed directly: cleaned clip placed underneath, correctly renamed, original clip's audio disabled (not deleted) |
| 9 | Per-job JSON state file | ✅ Confirmed — `job.json` opened directly, contains clip name/preset/status as expected |
| 10 | Error handling + cache housekeeping buttons | ✅ Error handling well-proven (every real failure above surfaced a specific, named, non-destructive error). Cache buttons all confirmed: "Clean Failed Temp Files" and "Delete Completed Input Temp Files" both worked correctly (removed the right files, left `output.wav`/`job.json` alone). **"Reveal Cache Folder" does not actually open Finder** — `uxp.shell.openPath()` isn't a confirmed real API on this build (not demonstrated anywhere in Adobe's own sample repo either) and degrades gracefully to just printing the path, which is an accepted, working limitation, not a bug to chase further |

**Still fully deferred, by design, not oversight:** Windows testing (macOS-only so far), any Phase 2+ scope (handles, linked-audio, MP3/AAC, label colors, bins, collision prompts, batch queue).

## Confirmed, real API patterns (verified live on this exact machine — use these directly, don't re-derive)

**Module loading:**
- Local files use no bundler and no `require()` between each other. Every file in `src/` wraps its body in an IIFE and assigns its public API onto `window.Auphonic.<name>` (e.g. `window.Auphonic.selection`). `index.html` loads each file via its own `<script src="...">` tag, in dependency order, ending with `main.js`. `require("premierepro")`/`require("uxp")` remain the normal way to reach those two host modules from any file.

**Selection & media type:**
- `sequence.getSelection()` → `TrackItemSelection.getTrackItems()` → array of track items.
- `trackItem.getInPoint()`/`getOutPoint()` are relative to the *source media's own start* — never use for placement math. `trackItem.getStartTime()`/`getEndTime()` are timeline-space — use these for placement and Sequence In/Out.
- `TickTime.ticksNumber` (a number property) is the real way to read raw ticks off a TickTime — not `.ticks`.
- **Media type**: `trackItem instanceof ppro.VideoClipTrackItem` / `instanceof ppro.AudioClipTrackItem` correctly identifies which kind of track item is selected. `.cast()` does not exist on either of those classes on this build (unlike `ClipProjectItem.cast()`, which does exist and works). Do NOT infer media type from matching timeline position across tracks — a video clip's linked audio occupies the identical position by definition, and this reliably misclassifies it.
- Track index for a given track item is still derived by walking `sequence.getAudioTrack(i)`/`getVideoTrack(i)` and matching by exact tick position (no confirmed `getTrackIndex()` method) — this part of the old approach is fine and unchanged, only the media-type determination changed.

**Export (subsequence approach):**
- `EncoderManager.encodeFile()` takes exactly 5 args; trimmed export via `encodeFile`/`encodeProjectItem` with explicit in/out silently exports the whole file regardless. Working approach: narrow the sequence's own In/Out via `createSetInPointAction`/`createSetOutPointAction` (wrapped in `project.lockedAccess(() => project.executeTransaction(...))`), call `sequence.createSubsequence(true)`, then `EncoderManager.getManager().exportSequence(subsequence, ppro.Constants.ExportType.IMMEDIATELY, outputPath, presetPath)` to export the whole subsequence (which is, by construction, just the trim). Restore the original In/Out immediately after creating the subsequence. Delete the subsequence afterward and check the return value — a resolved promise doesn't guarantee real deletion.
- `ExportType.IMMEDIATELY` renders synchronously; the resolved boolean already means done. Don't wait for `EVENT_RENDER_COMPLETE` — it never fires for this path.
- `ppro.WorkAreaUtils` does not exist on this build at all. Sequence's own In/Out is the real mechanism.
- The WAV export preset is bundled with the plugin at `assets/presets/Waveform Audio 48kHz 16-bit.epr` (not referenced by an absolute AME install path). Read via `uxp.storage.localFileSystem.getPluginFolder()` — confirmed working live now (the export step succeeded end-to-end).

**Placement/insertion:**
- `project.importFiles(filePaths, suppressUI)` — **only 2 args**, confirmed live. Adobe's own sample's 4-arg form (`filePaths, true, undefined, false`) throws `Illegal Parameter type` on this build. Coerce the path to a plain string first (`String(path)`) too, as a second layer of defense.
- `ppro.SequenceEditor.getEditor(sequence)` → `createOverwriteItemAction(projectItem, tickTime, videoTrackIndex, audioTrackIndex)` / `createInsertProjectItemAction(projectItem, tickTime, videoTrackIndex, audioTrackIndex, limitedShift)` — both confirmed real. Insert-at-an-out-of-range index auto-creates a track; this is the only confirmed track-creation mechanism (no such confirmation exists for overwrite at an out-of-range index), so the plugin uses insert (with `limitedShift: true`) only when no track exists below the original, and overwrite otherwise.
- `trackItem.createSetDisabledAction(true)` and `projectItem.createSetNameAction(newName)` are the real methods (confirmed in the spike phase).

**secureStorage & local files:**
- `uxp.storage.secureStorage.setItem/getItem/removeItem` all confirmed working, all async. `TextDecoder` does not exist in this host — decode the `Uint8Array` manually (see `lib/secureStorage.js`'s `decodeUtf8`).
- Always pass `{ format: uxp.storage.formats.binary }` explicitly for audio file reads/writes, or it corrupts binary data.
- Build every path via a real Folder/File entry's own `.nativePath` (e.g. `folder.createFile(name, {overwrite: true})`), never by string-concatenating paths.

**Auphonic API (all confirmed live end-to-end, including the real Phase 1 pipeline now, not just the spike):**
1. `POST /api/productions.json` with `{preset, metadata: {title}, output_basename, output_files: [{format: "wav"}]}` → `data.uuid`. `output_files` must be explicit or you get an MP3 back.
2. Upload: `POST /api/production/{uuid}/upload.json`, manual multipart body (FormData+Blob does not work reliably in this UXP host — confirmed twice now, spike and Phase 1).
3. `POST /api/production/{uuid}/start.json`, then poll `GET .../status.json` (`status: 3` = done, `2` = error) with backoff.
4. `GET /api/production/{uuid}.json` → `output_files[].download_url`, downloaded via `responseType: "arraybuffer"` with `?bearer_token=` appended.
- Auth header: `Authorization: bearer {api_key}` (lowercase `bearer`).

## Decisions already locked in (do not re-litigate)

- Clip pattern unknown → follow the PRD's default phase order, do not front-load Phase 4 batch consolidation.
- Effects mode (Phase 5) is **not needed** — audio is always cleaned from raw source. Dropped entirely.
- WAV is the default and only Phase 1 output format.
- Windows testing is planned but deferred until macOS Phase 1 is fully closed out.
- No `command` entrypoint in the manifest — only the panel, so the cost-estimate confirmation gate always has a place to show itself.
- A selected video clip is rejected outright (named reason) rather than attempting linked-audio resolution — that's Phase 2 scope.
- No collision detection on the destination track — Phase 1 explicitly excludes it; overwrite will silently replace whatever's there on an existing track below.
- Bin creation and label colors are skipped entirely (Phase 3 scope).
- Multi-selection is rejected with a message rather than silently processing only the first item.

## Immediate next steps

Phase 1 itself is done — all spot-checks above are complete. What's left is purely process:

1. Commit covering all the live-testing fixes (module loading, media-type detection, `importFiles` args) — propose it, ask first, per the commit-cadence preference above. If this document's "Version control" section still says this commit is pending, check `git log`/`git status` for the real current state rather than trusting this note.
2. Ask before pushing to GitHub (pushing is a separate, also-confirm-first action).
3. After that: Windows verification (PRD's cross-platform requirement, still not started) or starting Phase 2 (handles, linked-audio, collision prompts) — user's call on order. Neither has been discussed/decided yet.

## How to work with this user

Verify every Premiere/UXP API claim live before building UI around it — this project has now hit this lesson repeatedly (encodeFile's arg count, WorkAreaUtils missing, `require()` module resolution, `AudioClipTrackItem.cast()` missing, `importFiles`'s real arg count) and every single time, live evidence settled it in one pass while guessing would have taken several. When something fails, add a diagnostic that proves the *cause* (a console log, a live shape dump of the real object) rather than guessing at a fix a second time. The user has been extremely patient through a long debugging process and explicitly asked for thoroughness over speed — keep that standard. Remember to ask before every commit (see Version control above), and treat `git push` as a separate action that also needs a go-ahead.
