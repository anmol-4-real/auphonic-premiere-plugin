# Awwphonic Changelog

Plain-language release notes, shipped alongside each new `.ccx` so editors know what changed. See [RELEASING.md](RELEASING.md) for how a release gets made.

## 1.1.0 -- 2026-09-13

Polish and a couple of real fixes, no new features.

- Buttons, checkboxes, and the color dropdown all render correctly now — a few of these looked broken (invisible checkmarks, buttons that stayed grey instead of turning green) in 1.0.0.
- A batch of clips processed together now shows as a single collapsible group ("Batch of 3 — Inserted") instead of listing every clip separately.
- Selecting a clip that's already been cleaned up once is now rejected right away with a clear message, instead of running all the way through and failing at the end.
- Fixed a bug where a processed clip could occasionally come back longer than the original clip and get placed at the wrong length — it's now trimmed to match before being placed.
- "Past Productions" is capped to the 15 most recent so the list doesn't grow without bound the longer you use the panel.
- "Change key" no longer stays stuck on screen after being clicked.

## 1.0.0 -- 2026-09-09

First release. Select one or more audio clips on your timeline, click a button, and Auphonic cleans them up automatically — the result lands back on your timeline, correctly placed, with the original audio disabled (never deleted).

- Connect once with your Auphonic API key.
- Choose a preset, an optional label color, and extra export formats (MP3/AAC).
- Process several clips at once, optionally consolidated into a single cheaper Auphonic production.
- Retry, cancel, or open any job's Auphonic production page directly from the panel.
- A "Past Productions" list keeps older jobs out of the way until you need them.
- "Report a Bug" at the bottom of the panel opens a pre-filled email if something goes wrong.
