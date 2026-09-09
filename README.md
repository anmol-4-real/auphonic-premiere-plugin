# Awwphonic

A Premiere Pro plugin that cleans up audio on your timeline automatically, using [Auphonic](https://auphonic.com).

*(The repo's own name/URL still says "auphonic-premiere-plugin" for historical reasons — the shipped plugin itself is branded "Awwphonic".)*

## What it is

- A panel that lives inside Adobe Premiere Pro (Window > Extensions > Awwphonic Audio Processor).
- Built for HackerRank's internal video team — Kan (Studio Production Manager) is the actual day-to-day user; Anmolpreet built it.
- Connects directly to your own Auphonic account with your own API key — nothing routes through any server we run.

## What it does

- Select one or more audio clips on your timeline (or a video clip — its linked audio is picked up automatically).
- Pick an Auphonic preset, an optional label color, and any extra export formats (MP3/AAC).
- See a real cost estimate *before* anything is sent — nothing spends Auphonic credits without an explicit confirm.
- Sends the audio to Auphonic for cleanup, then automatically:
  - places the cleaned result back on the timeline, correctly aligned underneath the original,
  - disables the original clip's audio (never deletes it),
  - keeps everything organized in an "Awwphonic Processed Audio" bin.
- Handles several clips in one go, optionally consolidated into a single cheaper Auphonic production instead of billing each clip separately.
- Lets you retry a failed clip, cancel one that hasn't started, or jump straight to its production page on auphonic.com.
- Keeps your current batch front and center ("Your Clips") and tucks older jobs into a "Past Productions" list out of the way.
- Has a one-click "Report a Bug" link if something goes wrong.

## How it was built

- A UXP plugin — Adobe's current extension framework for Premiere Pro, Photoshop, etc.
- No backend, no database of its own — it's just Premiere-side code talking directly to Auphonic's API and to Premiere's own project.
- Your Auphonic API key is stored locally and securely on your own machine (UXP's built-in secure storage), never shared anywhere else.
- Built in phases over several sessions with Claude: a working single-clip round trip first, then handles/collision-detection, then batching, then consolidating several clips into one cheaper production, and finally a full visual redesign for Kan's day-to-day use.
- Every real bug hit along the way was diagnosed with live evidence in actual Premiere sessions, not guessed at — see [HANDOFF.md](HANDOFF.md) for the full, detailed history if you're curious.

## Installing it

Short version: double-click the `.ccx` file in [Installers/](Installers/), click Install in the Creative Cloud dialog, restart Premiere. Full steps in [INSTALL.md](INSTALL.md).

## For whoever's maintaining this

- [HANDOFF.md](HANDOFF.md) — the full, detailed project history and current state. Read this first in any new session working on the plugin.
- [RELEASING.md](RELEASING.md) — how to package and ship a new `.ccx` to editors.
- [CHANGELOG.md](CHANGELOG.md) — plain-language release notes, one entry per version.
