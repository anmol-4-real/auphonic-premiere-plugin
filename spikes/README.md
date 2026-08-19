# Spike tests — throwaway

These exist to answer two questions before any real plugin code gets written,
because both are marked **"Assumed"** (not verified) in section 10 of the PRD,
and both would force a redesign if they turn out false.

| Spike | Question | If it fails |
|---|---|---|
| A | Can the plugin reach auphonic.com from inside Premiere? | Whole transport architecture changes — likely needs a local helper process |
| B | Can Premiere export just one clip's audio range? | Export must switch to the temporary-subsequence approach for everything |

**Delete this entire `spikes/` folder once both pass.** Nothing here is meant to
survive into Phase 1 — it is deliberately rough, and its plugin id
(`com.hackerrank.auphonic-spike`) is separate from the real plugin's so a failed
experiment can't contaminate the real manifest.

## How to run

1. Open **Adobe UXP Developer Tools**
2. **Add Plugin** → select `spikes/spike-plugin/manifest.json`
3. Make sure Premiere Pro is running with a project + timeline open
4. Click **Load** on the row that appears
5. In Premiere: **Window → UXP Plugins → Auphonic Spike Tests**

## Pass criteria

**Spike A:** panel prints `HTTP 200` and your real credit balance in hours.
A 401/403 means the *key* is wrong but networking worked — that still passes the
architectural question, which is the point of the spike.

**Spike B:** click *Inspect Selection* first and note the "EXPECTED EXPORT
LENGTH". Then *Export Selected Clip*. The WAV that lands at the printed Output
path must be **that** length — not the length of the whole source recording it
was cut from.

## Known rough edges (deliberate, do not fix here)

- The WAV preset path is hardcoded to this Mac's Adobe Media Encoder 2026 bundle.
  Phase 1 must stop relying on an absolute bundle path — it breaks on Windows and
  on version upgrades. Bundling a copy of the `.epr` with the plugin is the likely fix.
- The API key is held in a plain in-memory field. Phase 1 uses UXP `secureStorage`.
- `workArea` is exposed as a dropdown purely so a failing export can be retried
  with a different value without a code change.
