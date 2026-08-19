/*
 * Auphonic spike tests -- THROWAWAY.
 *
 * Exists only to answer the two questions PRD section 10 marks "Assumed":
 *   A. Can UXP reach auphonic.com without a CORS failure?
 *   B. Can AME render a single clip's source in/out range (not the whole file)?
 *
 * Delete this folder once both pass. No code here is meant to survive into Phase 1.
 */

const ppro = require("premierepro");
const uxp = require("uxp");

const AUPHONIC = "https://auphonic.com";

// Audio-only WAV preset shipped inside Adobe Media Encoder. Located on this machine
// by searching the AME bundle; folder 3F3F3F3F_57415645 is hex ASCII for "WAVE",
// and the preset's own XML carries <DoVideo>false</DoVideo><DoAudio>true</DoAudio>.
// Phase 1 should stop depending on an absolute bundle path -- see notes at bottom.
const DEFAULT_WAV_PRESET =
  "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app" +
  "/Contents/MediaIO/systempresets/3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr";

// Premiere's tick resolution. Matches the constant Adobe's own sample uses.
const TICKS_PER_SECOND = 254016000000;

// Intrinsic project-column ids holding where this clip's media begins/ends inside
// its source file. Only used for diagnostic display in inspectSelection() now --
// the working export path (exportViaSubsequence) uses timeline-space
// startTime/endTime instead, which needs no media-start offset at all.
const MEDIA_START_COLUMN_ID = "Column.Intrinsic.MediaStart";
const MEDIA_END_COLUMN_ID = "Column.Intrinsic.MediaEnd";

// Where exported test files land -- plain, visible, easy to find in Finder,
// instead of the hidden PluginData cache folder used by the earlier attempts.
const EXPORTS_FOLDER = "/Users/anmolpreet/Documents/Awwphonic/Test Exports";

// Counts up each time an export is attempted this panel session, so repeated
// test runs get "clip - attempt 1.wav", "clip - attempt 2.wav", etc. instead
// of an opaque timestamp -- easy to say out loud, easy to tell apart.
let exportAttemptCounter = 0;

function sanitizeFilename(name) {
  const cleaned = String(name || "clip").replace(/[\/:*?"<>|]/g, "_").trim();
  return cleaned || "clip";
}

/* ------------------------------------------------------------------ logging */

function writeLog(targetId, message, cls) {
  const el = document.getElementById(targetId);
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = message;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function clearLog(targetId) {
  document.getElementById(targetId).textContent = "";
}

function formatSeconds(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return "unknown";
  const whole = Math.floor(sec);
  const ms = Math.round((sec - whole) * 1000);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}m ${s}s ${ms}ms  (${sec.toFixed(3)}s)`;
}

/* ================================================================== SPIKE A */

/*
 * Auphonic accepts the API key as "Authorization: bearer <key>" (lowercase
 * "bearer" is what their auth docs show). XHR is used rather than fetch because
 * PRD section 9.2 needs upload progress events later; keeping the same transport
 * here means the spike proves the transport we actually intend to ship.
 */
function auphonicGet(path, apiKey) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", AUPHONIC + path, true);
    xhr.setRequestHeader("Authorization", "bearer " + apiKey);
    xhr.onload = () =>
      resolve({ status: xhr.status, body: xhr.responseText });
    // A CORS rejection surfaces here as a bare onerror with no status, which is
    // exactly the failure mode PRD section 10 warns about -- so report it as such.
    xhr.onerror = () =>
      reject(new Error("Network/CORS failure -- no HTTP status returned at all"));
    xhr.ontimeout = () => reject(new Error("Request timed out"));
    xhr.timeout = 20000;
    xhr.send();
  });
}

async function testConnection() {
  clearLog("logA");
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) {
    writeLog("logA", "No API key entered.", "bad");
    return;
  }

  writeLog("logA", "GET /api/user.json ...", "dim");
  try {
    const res = await auphonicGet("/api/user.json", apiKey);
    writeLog("logA", `HTTP ${res.status}`, res.status === 200 ? "ok" : "bad");

    if (res.status === 401 || res.status === 403) {
      writeLog("logA", "Auth rejected -- key is wrong or lacks API access.", "bad");
      writeLog("logA", "Networking itself WORKED though: a real HTTP status came back.", "warn");
      return;
    }
    if (res.status !== 200) {
      writeLog("logA", res.body.slice(0, 400), "dim");
      return;
    }

    const parsed = JSON.parse(res.body);
    const data = parsed.data || {};
    writeLog("logA", `Username: ${data.username}`);
    writeLog("logA", `Credits:  ${data.credits} h`, "ok");
    writeLog("logA", `  one-time:  ${data.onetime_credits} h`, "dim");
    writeLog("logA", `  recurring: ${data.recurring_credits} h`, "dim");
    writeLog("logA", "SPIKE A PASSED -- UXP can reach Auphonic.", "ok");
  } catch (err) {
    writeLog("logA", String(err.message || err), "bad");
    writeLog("logA", "SPIKE A FAILED -- stop here, architecture needs rethinking.", "bad");
  }
}

async function listPresets() {
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) {
    writeLog("logA", "No API key entered.", "bad");
    return;
  }
  writeLog("logA", "GET /api/presets.json ...", "dim");
  try {
    const res = await auphonicGet(
      "/api/presets.json?minimal_data=1&preset_type=all_presets",
      apiKey
    );
    writeLog("logA", `HTTP ${res.status}`, res.status === 200 ? "ok" : "bad");
    if (res.status !== 200) {
      writeLog("logA", res.body.slice(0, 400), "dim");
      return;
    }
    const presets = JSON.parse(res.body).data || [];
    writeLog("logA", `${presets.length} preset(s):`, "ok");
    presets.forEach((p) => writeLog("logA", `  ${p.preset_name}  [${p.uuid}]`, "dim"));
  } catch (err) {
    writeLog("logA", String(err.message || err), "bad");
  }
}

/* ================================================================== SPIKE B */

/*
 * Where a clip's media starts/ends inside its source file. Premiere exposes this
 * through project-column metadata rather than a direct getter, so it has to be
 * parsed out by column id. Same approach Adobe's sample uses.
 */
async function getMediaStartEnd(projectItem) {
  const raw = await ppro.Metadata.getProjectColumnsMetadata(projectItem);
  const columns = JSON.parse(raw);
  let startTime = null;
  let endTime = null;
  for (const col of columns) {
    if (col.ColumnID === MEDIA_START_COLUMN_ID) {
      startTime = ppro.TickTime.createWithTicks(col.ColumnValue);
    } else if (col.ColumnID === MEDIA_END_COLUMN_ID) {
      endTime = ppro.TickTime.createWithTicks(col.ColumnValue);
    }
    if (startTime && endTime) break;
  }
  return [startTime, endTime];
}

// Shared by both Spike B buttons so "Inspect" reports on exactly what "Export"
// would act on -- otherwise the two could silently disagree.
async function resolveSelectedClip() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No project open.");

  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence -- open a timeline first.");

  const selection = await sequence.getSelection();
  const trackItems = selection ? await selection.getTrackItems() : [];
  if (!trackItems || trackItems.length === 0) {
    throw new Error("Nothing selected on the timeline.");
  }
  if (trackItems.length > 1) {
    writeLog(
      "logB",
      `${trackItems.length} items selected -- this spike only uses the first.`,
      "warn"
    );
  }

  const trackItem = trackItems[0];
  const projectItem = await trackItem.getProjectItem();
  if (!projectItem) throw new Error("Selected item has no project item.");

  const clipProjectItem = await ppro.ClipProjectItem.cast(projectItem);
  if (!clipProjectItem) {
    throw new Error("Selected item is not a clip (merged/multicam/nested?).");
  }

  const mediaPath = await clipProjectItem.getMediaFilePath();
  if (!mediaPath) throw new Error("Could not resolve source media path (offline?).");

  const inPoint = await trackItem.getInPoint();
  const outPoint = await trackItem.getOutPoint();
  const startTime = await trackItem.getStartTime();
  const endTime = await trackItem.getEndTime();
  const [mediaStart] = await getMediaStartEnd(projectItem);

  return {
    project, sequence, trackItem, projectItem, clipProjectItem,
    mediaPath, inPoint, outPoint, startTime, endTime, mediaStart,
  };
}

async function inspectSelection() {
  clearLog("logB");
  try {
    const c = await resolveSelectedClip();
    writeLog("logB", `Project:   ${c.project.name}`, "dim");
    writeLog("logB", `Sequence:  ${c.sequence.name}`, "dim");
    writeLog("logB", `Media:     ${c.mediaPath}`);
    writeLog("logB", "");
    writeLog("logB", "Timeline position:");
    writeLog("logB", `  start ${formatSeconds(c.startTime.seconds)}`, "dim");
    writeLog("logB", `  end   ${formatSeconds(c.endTime.seconds)}`, "dim");
    writeLog("logB", "Source in/out (relative to media start):");
    writeLog("logB", `  in    ${formatSeconds(c.inPoint.seconds)}`, "dim");
    writeLog("logB", `  out   ${formatSeconds(c.outPoint.seconds)}`, "dim");
    writeLog(
      "logB",
      `Media start offset: ${c.mediaStart ? formatSeconds(c.mediaStart.seconds) : "none"}`,
      "dim"
    );
    writeLog("logB", "");
    const expected = c.outPoint.seconds - c.inPoint.seconds;
    writeLog("logB", `EXPECTED EXPORT LENGTH: ${formatSeconds(expected)}`, "warn");
    writeLog("logB", "Remember this number -- the exported WAV must match it.", "warn");
  } catch (err) {
    writeLog("logB", String(err.message || err), "bad");
  }
}

/*
 * The first export attempt used inPoint/outPoint + mediaStart offset (the "absolute,
 * reel-timecode-aligned" coordinate frame Adobe's addHandlesToTrackItem sample uses
 * for a bounds check) and got the WHOLE file back, not the trim. The likely reason:
 * encodeFile() addresses a raw FILE PATH directly, which probably expects "zero =
 * first byte of this file" addressing, not reel-timecode addressing -- and the media
 * start offset on this clip is ~20.6 hours, so the offset version asked AME to encode
 * a range far outside the file's real length, and it silently fell back to the whole
 * file instead of erroring.
 *
 * Rather than guess again one attempt at a time, this runs three genuinely different
 * approaches back to back, to distinct output files, so one round of testing settles
 * which (if any) actually honors the trim.
 */
async function debugApiSurface() {
  clearLog("logB");
  try {
    writeLog("logB", "Top-level ppro keys:", "warn");
    const keys = Object.keys(ppro).sort();
    writeLog("logB", keys.join(", "), "dim");
    writeLog("logB", "");

    const candidates = [
      "WorkAreaUtils", "EncoderManager", "Sequence", "Project", "Constants",
      "TickTime", "Metadata", "ClipProjectItem", "ProjectItem", "TrackItemSelection",
      "ExportType",
    ];
    writeLog("logB", "Specific lookups:", "warn");
    for (const name of candidates) {
      const val = ppro[name];
      const kind = val === undefined ? "MISSING" : typeof val;
      writeLog("logB", `  ppro.${name}: ${kind}`, val === undefined ? "bad" : "ok");
    }

    // If Constants exists, dig one level deeper -- ExportType might live there
    // rather than at the top level (the sample's import path for it was never
    // actually confirmed, per the earlier research).
    if (ppro.Constants) {
      writeLog("logB", "");
      writeLog("logB", "ppro.Constants keys:", "warn");
      writeLog("logB", Object.keys(ppro.Constants).sort().join(", "), "dim");
    }

    // Also check the sequence/encoderManager instances themselves, in case
    // WorkAreaUtils-equivalent functionality hangs off the instance rather
    // than a static top-level namespace on this version.
    const project = await ppro.Project.getActiveProject();
    if (project) {
      const sequence = await project.getActiveSequence();
      if (sequence) {
        writeLog("logB", "");
        writeLog("logB", "Active sequence's own keys (methods/properties):", "warn");
        const seqKeys = [];
        for (const k in sequence) seqKeys.push(k);
        writeLog("logB", seqKeys.sort().join(", ") || "(nothing enumerable -- likely a native proxy; try prototype instead)", "dim");
        const proto = Object.getPrototypeOf(sequence);
        if (proto) {
          writeLog("logB", "Sequence prototype methods:", "warn");
          writeLog("logB", Object.getOwnPropertyNames(proto).sort().join(", "), "dim");
        }

        // Sequence.getInPoint/getOutPoint exist here even though WorkAreaUtils
        // doesn't -- these are the separate "Sequence In/Out" markers some
        // Adobe bug reports distinguish from Work Area. Print current values.
        try {
          const seqIn = await sequence.getInPoint();
          const seqOut = await sequence.getOutPoint();
          writeLog("logB", "");
          writeLog("logB", `Sequence In/Out: ${formatSeconds(seqIn.seconds)} -> ${formatSeconds(seqOut.seconds)}`, "warn");
        } catch (e) {
          writeLog("logB", `Sequence getInPoint/getOutPoint threw: ${e.message || e}`, "bad");
        }

        // TrackItemSelection's own prototype -- need this to know how to scope
        // a selection to exactly one trackItem before createSubsequence().
        try {
          const selection = await sequence.getSelection();
          writeLog("logB", "");
          writeLog("logB", "TrackItemSelection prototype methods:", "warn");
          const selProto = Object.getPrototypeOf(selection);
          writeLog("logB", Object.getOwnPropertyNames(selProto).sort().join(", "), "dim");
        } catch (e) {
          writeLog("logB", `getSelection() threw: ${e.message || e}`, "bad");
        }

        // createSubsequence's real declared arity -- native functions often
        // don't expose a useful .length, but worth checking cheaply.
        writeLog("logB", "");
        writeLog("logB", `sequence.createSubsequence.length: ${sequence.createSubsequence.length}`, "dim");
      }
    }

    // Project prototype -- looking for how to remove/delete a temporary
    // sequence once we're done with it (no such method confirmed anywhere
    // in prior research).
    if (project) {
      writeLog("logB", "");
      writeLog("logB", "Project prototype methods:", "warn");
      const projProto = Object.getPrototypeOf(project);
      writeLog("logB", Object.getOwnPropertyNames(projProto).sort().join(", "), "dim");
    }

    // Real declared arity of the three encode/export functions -- settles the
    // encodeFile 5-vs-8-parameter question and exportSequence's exportFull
    // question definitively, if the native binding reports .length honestly.
    const encoder = ppro.EncoderManager.getManager();
    writeLog("logB", "");
    writeLog("logB", "Encoder function arities (declared parameter count):", "warn");
    writeLog("logB", `  encodeFile.length: ${encoder.encodeFile.length}`, "dim");
    writeLog("logB", `  encodeProjectItem.length: ${encoder.encodeProjectItem.length}`, "dim");
    writeLog("logB", `  exportSequence.length: ${encoder.exportSequence.length}`, "dim");
  } catch (err) {
    writeLog("logB", String(err.message || err), "bad");
  }
}

/*
 * ppro.WorkAreaUtils is confirmed MISSING on this Premiere build (verified via
 * direct introspection -- the sample repo's TS types don't match this host's
 * real API surface). But Sequence itself has real, confirmed getInPoint()/
 * getOutPoint()/createSetInPointAction()/createSetOutPointAction() -- a
 * distinct "Sequence In/Out" concept, separate from Work Area, and this is
 * what Premiere's own "Create Subsequence" feature is understood to key off.
 * Confirming evidence: this sequence's current getOutPoint() already reads
 * exactly 8.120s -- matching the selected clip's timeline end -- because this
 * test sequence has only that one clip, so "end of sequence content" and
 * "end of this clip" coincide here.
 *
 * Plan: narrow the SEQUENCE's own in/out to the selected clip's timeline
 * start/end, create a subsequence (whose duration then IS the trim), export
 * that subsequence whole, delete the temporary subsequence, and restore the
 * sequence's original in/out. Every method used below was confirmed present
 * on this exact host via the debug probe above -- project.executeTransaction,
 * project.lockedAccess, project.deleteSequence, sequence.createSetInPointAction,
 * sequence.createSetOutPointAction, sequence.createSubsequence.
 */
/*
 * Confirmed by direct evidence, not guesswork: reading the actual WAV file
 * headers of every prior test run (via Python's wave module, outside this
 * plugin) showed every single one -- including ones that this code reported
 * as "timed out" -- was already exactly 8.120s, matching the selected clip.
 * The export was correct and complete by the time exportSequence() resolved.
 *
 * What was actually wrong: this function used to wait up to 90s for an
 * EVENT_RENDER_COMPLETE event, and separately called encoder.launchEncoder()/
 * startBatchEncode(). Neither applies here. Adobe Media Encoder opening with
 * an empty queue (observed directly) confirms ExportType.IMMEDIATELY renders
 * synchronously within Premiere itself -- it never goes through AME's job
 * queue or its event system at all, so no such event was ever going to fire,
 * and launching AME did nothing useful. Fixed: treat exportSequence()'s
 * resolved boolean as final, and clean up immediately.
 */
async function exportViaSubsequence() {
  clearLog("logB");
  let project = null;
  let sequence = null;
  let originalSeqIn = null;
  let originalSeqOut = null;
  let subsequence = null;

  try {
    const c = await resolveSelectedClip();
    project = c.project;
    sequence = c.sequence;

    const encoder = ppro.EncoderManager.getManager();
    if (!encoder.isAMEInstalled) {
      writeLog("logB", "Adobe Media Encoder not installed / incompatible.", "bad");
      return;
    }

    originalSeqIn = await sequence.getInPoint();
    originalSeqOut = await sequence.getOutPoint();
    writeLog("logB", `Saved original Sequence In/Out: ${formatSeconds(originalSeqIn.seconds)} -> ${formatSeconds(originalSeqOut.seconds)}`, "dim");

    // Sequence In/Out reads in the same timeline coordinate space as a
    // trackItem's getStartTime()/getEndTime() (confirmed: this sequence's
    // out-point matched the clip's timeline end exactly) -- NOT the
    // source-relative getInPoint()/getOutPoint() that the earlier, unsuccessful
    // attempts were built around.
    const startTime = c.startTime;
    const endTime = c.endTime;
    const expectedSeconds = endTime.seconds - startTime.seconds;

    let setOk = false;
    project.lockedAccess(() => {
      setOk = project.executeTransaction((compoundAction) => {
        compoundAction.addAction(sequence.createSetInPointAction(startTime));
        compoundAction.addAction(sequence.createSetOutPointAction(endTime));
      }, "Narrow sequence in/out to selected clip (spike test)");
    });

    if (!setOk) {
      writeLog("logB", "Failed to narrow sequence in/out -- stopping before touching AME.", "bad");
      return;
    }
    writeLog("logB", `Sequence In/Out narrowed to: ${formatSeconds(startTime.seconds)} -> ${formatSeconds(endTime.seconds)}`, "ok");
    writeLog("logB", `EXPECTED LENGTH: ${formatSeconds(expectedSeconds)}`, "warn");
    writeLog("logB", "");

    subsequence = await sequence.createSubsequence(true);
    if (!subsequence) {
      throw new Error("createSubsequence returned nothing.");
    }
    writeLog("logB", `Created temporary subsequence: ${subsequence.name}`, "ok");

    // The subsequence is independent from here on, so restore the real
    // sequence's in/out right away rather than leaving it narrowed.
    let restoredEarly = false;
    project.lockedAccess(() => {
      restoredEarly = project.executeTransaction((compoundAction) => {
        compoundAction.addAction(sequence.createSetInPointAction(originalSeqIn));
        compoundAction.addAction(sequence.createSetOutPointAction(originalSeqOut));
      }, "Restore original sequence in/out (spike test, early restore)");
    });
    writeLog("logB", restoredEarly ? "Original sequence in/out restored (subsequence is independent from here)." : "Could NOT restore sequence in/out early -- will retry at the end.", restoredEarly ? "dim" : "bad");
    if (restoredEarly) {
      originalSeqIn = null; // already restored -- skip the redundant attempt in finally
      originalSeqOut = null;
    }

    // Creating a subsequence typically opens/activates it as a new tab in
    // Premiere's UI. Switch focus back to the original sequence before we
    // later try to delete the subsequence -- deleting the currently active
    // sequence is the kind of thing that can fail or leave a confusing UI
    // state, and this is a one-line, confirmed-real call to avoid it.
    if (typeof project.setActiveSequence === "function") {
      try {
        await project.setActiveSequence(sequence);
        writeLog("logB", "Switched active sequence back to the original.", "dim");
      } catch (e) {
        writeLog("logB", `setActiveSequence back to original threw: ${e.message || e}`, "warn");
      }
    }

    const exportTypeEnum = ppro.Constants && ppro.Constants.ExportType;
    const exportType = exportTypeEnum ? exportTypeEnum.IMMEDIATELY : undefined;
    if (exportType === undefined) {
      writeLog("logB", "ppro.Constants.ExportType.IMMEDIATELY not found. Actual enum:", "bad");
      writeLog("logB", JSON.stringify(exportTypeEnum), "dim");
      return;
    }

    exportAttemptCounter += 1;
    const clipName = sanitizeFilename(c.projectItem.name);
    const outputPath = `${EXPORTS_FOLDER}/${clipName} - attempt ${exportAttemptCounter}.wav`;
    const presetPath = document.getElementById("presetPath").value.trim();

    writeLog("logB", `Output: ${outputPath}`, "dim");
    writeLog("logB", "Exporting (ExportType.IMMEDIATELY -- renders synchronously, confirmed by direct file inspection) ...", "dim");

    const done = await encoder.exportSequence(subsequence, exportType, outputPath, presetPath);
    writeLog("logB", `Export finished: ${done}`, done ? "ok" : "bad");
    if (done) {
      writeLog("logB", "");
      writeLog("logB", `File is at: ${outputPath}`, "ok");
      writeLog("logB", "CHECK its actual length against the EXPECTED LENGTH above.", "warn");
    }
  } catch (err) {
    writeLog("logB", String(err.message || err), "bad");
  } finally {
    if (project && subsequence) {
      if (typeof project.closeSequence === "function") {
        try {
          const closed = await project.closeSequence(subsequence);
          writeLog("logB", `closeSequence (pre-delete) returned: ${closed}`, "dim");
        } catch (e) {
          // Non-fatal -- it may not have an open tab/editor to close at all.
          writeLog("logB", `closeSequence (pre-delete) threw: ${e.message || e}`, "dim");
        }
      }
      try {
        // Don't just trust "didn't throw" -- exportSequence's boolean already
        // taught us a call can resolve without error yet not actually do what
        // it claims. Check the real return value here too.
        const deleted = await project.deleteSequence(subsequence);
        if (deleted === false) {
          writeLog("logB", `deleteSequence returned FALSE -- "${subsequence.name}" was likely NOT removed. Check the Project panel.`, "bad");
        } else {
          writeLog("logB", `deleteSequence returned: ${deleted}. Check the Project panel to confirm "${subsequence.name}" is actually gone.`, deleted ? "ok" : "warn");
        }
      } catch (cleanupErr) {
        writeLog("logB", `deleteSequence threw: ${cleanupErr.message || cleanupErr}`, "bad");
      }
    }
    // Only reached if the early restore above didn't happen (originalSeqIn/Out
    // are nulled out once that succeeds).
    if (project && sequence && originalSeqIn && originalSeqOut) {
      try {
        let restoreOk = false;
        project.lockedAccess(() => {
          restoreOk = project.executeTransaction((compoundAction) => {
            compoundAction.addAction(sequence.createSetInPointAction(originalSeqIn));
            compoundAction.addAction(sequence.createSetOutPointAction(originalSeqOut));
          }, "Restore original sequence in/out (spike test cleanup)");
        });
        writeLog(
          "logB",
          restoreOk ? "Original sequence in/out restored." : "Could NOT restore original sequence in/out -- check the timeline manually.",
          restoreOk ? "dim" : "bad"
        );
      } catch (restoreErr) {
        writeLog("logB", `Restore threw: ${restoreErr.message || restoreErr}`, "bad");
      }
    }
  }
}

/*
 * Bulk cleanup for leftover "_Sub_NN" temporary subsequences that may have
 * accumulated from earlier test runs, in case exportViaSubsequence's own
 * cleanup wasn't actually succeeding (its deleteSequence call resolved
 * without throwing, but that alone doesn't confirm real deletion -- same
 * lesson as exportSequence's misleading "true" earlier). Also serves as an
 * independent test of whether deleteSequence can succeed at all outside the
 * "just-created, maybe-still-active" situation the export function hits.
 */
async function cleanupLeftoverSubsequences() {
  clearLog("logB");
  try {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("No project open.");

    const sequences = await project.getSequences();
    const leftovers = sequences.filter((s) => /_Sub_\d+$/.test(s.name));

    if (leftovers.length === 0) {
      writeLog("logB", "No \"_Sub_NN\" leftover subsequences found.", "ok");
      return;
    }

    writeLog("logB", `Found ${leftovers.length} leftover subsequence(s):`, "warn");
    leftovers.forEach((s) => writeLog("logB", `  ${s.name}`, "dim"));
    writeLog("logB", "");

    for (const seq of leftovers) {
      try {
        if (typeof project.closeSequence === "function") {
          try { await project.closeSequence(seq); } catch (e) { /* non-fatal */ }
        }
        const deleted = await project.deleteSequence(seq);
        writeLog("logB", `${seq.name}: deleteSequence returned ${deleted}`, deleted ? "ok" : "bad");
      } catch (err) {
        writeLog("logB", `${seq.name}: threw ${err.message || err}`, "bad");
      }
    }

    writeLog("logB", "");
    writeLog("logB", "Check the Project panel to confirm what actually got removed.", "warn");
  } catch (err) {
    writeLog("logB", String(err.message || err), "bad");
  }
}

/* ============================================================ SPIKE C: INSERTION */

/*
 * Confirmed by direct research (Adobe's own sample repo, grepped exhaustively):
 * no "addTrack"/"createAddTrackAction" method exists anywhere. The only lead is
 * that createInsertProjectItemAction takes a raw track index with no bounds
 * check demonstrated -- so the working theory is that INSERT (not overwrite)
 * auto-creates a track when given an index at or beyond the current count,
 * the same way dragging a clip below the last track in Premiere's own UI does.
 * createSetDisabledAction has ZERO evidence anywhere in the sample repo either
 * -- this whole test exists to get a real, direct answer instead of guessing.
 *
 * Both mutations happen inside a disposable subsequence copy (same pattern
 * Spike B proved safe), so nothing here can damage the real project even if
 * a hypothesis is wrong.
 */
async function testDisableAndTrackCreation() {
  clearLog("logC");
  let project = null;
  let sequence = null;
  let originalSeqIn = null;
  let originalSeqOut = null;
  let subsequence = null;

  try {
    const c = await resolveSelectedClip();
    project = c.project;
    sequence = c.sequence;

    originalSeqIn = await sequence.getInPoint();
    originalSeqOut = await sequence.getOutPoint();

    const startTime = c.startTime;
    const endTime = c.endTime;

    let setOk = false;
    project.lockedAccess(() => {
      setOk = project.executeTransaction((compoundAction) => {
        compoundAction.addAction(sequence.createSetInPointAction(startTime));
        compoundAction.addAction(sequence.createSetOutPointAction(endTime));
      }, "Narrow for isolated test copy (Spike C)");
    });
    if (!setOk) throw new Error("Failed to narrow sequence in/out for isolated copy.");

    subsequence = await sequence.createSubsequence(true);
    if (!subsequence) throw new Error("createSubsequence returned nothing.");
    writeLog("logC", `Created isolated test copy: ${subsequence.name}`, "ok");

    project.lockedAccess(() => {
      project.executeTransaction((compoundAction) => {
        compoundAction.addAction(sequence.createSetInPointAction(originalSeqIn));
        compoundAction.addAction(sequence.createSetOutPointAction(originalSeqOut));
      }, "Restore original in/out (Spike C)");
    });
    if (typeof project.setActiveSequence === "function") {
      try { await project.setActiveSequence(sequence); } catch (e) { /* non-fatal */ }
    }

    let copyItems = [];
    try {
      const copySelection = await subsequence.getSelection();
      copyItems = (await copySelection.getTrackItems()) || [];
    } catch (e) { /* fall through to track-based lookup below */ }
    if (copyItems.length === 0) {
      const audioTrack0 = await subsequence.getAudioTrack(0);
      copyItems = audioTrack0.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || [];
    }
    if (copyItems.length === 0) {
      throw new Error("Could not find any track item inside the isolated copy.");
    }
    const copyItem = copyItems[0];
    writeLog("logC", "Found the clip inside the isolated copy.", "dim");
    writeLog("logC", "");

    // --- Disable action ---
    writeLog("logC", "Testing createSetDisabledAction ...", "warn");
    if (typeof copyItem.createSetDisabledAction !== "function") {
      writeLog("logC", "copyItem.createSetDisabledAction is NOT a function -- confirmed missing on this build.", "bad");
    } else {
      let disableOk = false;
      try {
        project.lockedAccess(() => {
          disableOk = project.executeTransaction((compoundAction) => {
            compoundAction.addAction(copyItem.createSetDisabledAction(true));
          }, "Test disable (Spike C, isolated copy)");
        });
        writeLog("logC", `createSetDisabledAction(true) applied, transaction returned: ${disableOk}`, disableOk ? "ok" : "bad");
      } catch (e) {
        writeLog("logC", `createSetDisabledAction threw: ${e.message || e}`, "bad");
      }
      if (typeof copyItem.isDisabled === "function") {
        try {
          const nowDisabled = await copyItem.isDisabled();
          writeLog("logC", `copyItem.isDisabled() reads back: ${nowDisabled}`, nowDisabled ? "ok" : "warn");
        } catch (e) {
          writeLog("logC", `isDisabled() threw: ${e.message || e}`, "warn");
        }
      } else {
        writeLog("logC", "No isDisabled() getter on this object to confirm the state took effect.", "warn");
      }
    }

    writeLog("logC", "");

    // --- Track creation via insert-beyond-count ---
    writeLog("logC", "Testing track auto-creation via createInsertProjectItemAction ...", "warn");
    const beforeCount = await subsequence.getAudioTrackCount();
    writeLog("logC", `Audio track count before: ${beforeCount}`, "dim");

    const sequenceEditor = ppro.SequenceEditor.getEditor(subsequence);
    const targetIndex = beforeCount; // one beyond the last valid index
    let insertOk = false;
    try {
      project.lockedAccess(() => {
        insertOk = project.executeTransaction((compoundAction) => {
          const insertAction = sequenceEditor.createInsertProjectItemAction(
            c.projectItem,
            ppro.TickTime.TIME_ZERO,
            targetIndex, // video track index -- irrelevant for an audio-only item, testing anyway
            targetIndex, // audio track index -- one beyond current count, the actual hypothesis
            true
          );
          compoundAction.addAction(insertAction);
        }, "Test insert beyond track count (Spike C, isolated copy)");
      });
    } catch (err) {
      writeLog("logC", `createInsertProjectItemAction threw: ${err.message || err}`, "bad");
    }
    writeLog("logC", `Insert-at-index-${targetIndex} transaction returned: ${insertOk}`, insertOk ? "ok" : "bad");

    const afterCount = await subsequence.getAudioTrackCount();
    writeLog("logC", `Audio track count after: ${afterCount}`, afterCount > beforeCount ? "ok" : "bad");
    if (afterCount > beforeCount) {
      writeLog("logC", "CONFIRMED: inserting at an out-of-range index auto-creates the track.", "ok");
    } else {
      writeLog("logC", "Track count did NOT increase -- this hypothesis is wrong, need another approach.", "bad");
    }
  } catch (err) {
    writeLog("logC", String(err.message || err), "bad");
  } finally {
    if (project && subsequence) {
      if (typeof project.closeSequence === "function") {
        try { await project.closeSequence(subsequence); } catch (e) { /* non-fatal */ }
      }
      try {
        const deleted = await project.deleteSequence(subsequence);
        writeLog("logC", `Isolated test copy deleted: ${deleted}`, deleted ? "dim" : "bad");
      } catch (e) {
        writeLog("logC", `Failed to delete isolated test copy: ${e.message || e}`, "bad");
      }
    }
  }
}

/* ======================================================= SPIKE D: SECURESTORAGE */

/*
 * TextDecoder is not defined in this UXP host (confirmed live -- a genuine
 * environment gap, not a transient error). Manual UTF-8 decode as a fallback,
 * used for the API key later too since secureStorage.getItem always returns
 * a Uint8Array regardless of host.
 */
function decodeUtf8(bytes) {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder().decode(bytes);
  }
  let result = "";
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i];
    if (b1 < 0x80) {
      result += String.fromCharCode(b1);
      i += 1;
    } else if ((b1 & 0xe0) === 0xc0) {
      result += String.fromCharCode(((b1 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b1 & 0xf0) === 0xe0) {
      result += String.fromCharCode(
        ((b1 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else if ((b1 & 0xf8) === 0xf0) {
      const codepoint =
        ((b1 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      result += String.fromCodePoint(codepoint);
      i += 4;
    } else {
      result += String.fromCharCode(b1); // invalid byte -- best effort, don't throw
      i += 1;
    }
  }
  return result;
}

async function testSecureStorage() {
  clearLog("logD");
  try {
    const testKey = "auphonic_spike_test_key";
    const testValue = "test-value-" + Math.floor(Math.random() * 1e9);

    writeLog("logD", `Writing "${testValue}" via uxp.storage.secureStorage.setItem ...`, "dim");
    await uxp.storage.secureStorage.setItem(testKey, testValue);
    writeLog("logD", "setItem resolved without throwing.", "ok");

    const readBack = await uxp.storage.secureStorage.getItem(testKey);
    const readBackKind = readBack ? readBack.constructor.name : typeof readBack;
    writeLog("logD", `getItem resolved, raw type: ${readBackKind}`, "dim");

    const readBackString = readBack instanceof Uint8Array
      ? decodeUtf8(readBack)
      : String(readBack);

    const matched = readBackString === testValue;
    writeLog("logD", `Decoded value: "${readBackString}"`, matched ? "ok" : "bad");
    writeLog("logD", matched ? "ROUND-TRIP MATCHED." : "MISMATCH.", matched ? "ok" : "bad");

    await uxp.storage.secureStorage.removeItem(testKey);
    writeLog("logD", "Test key removed.", "dim");
  } catch (err) {
    writeLog("logD", String(err.message || err), "bad");
  }
}

/* ===================================================== SPIKE E: AUPHONIC UPLOAD */

/*
 * Full real round trip: pick a WAV file already on disk (use one of the
 * Test Exports from Spike B), upload it to Auphonic, start processing,
 * poll until done, download the result locally. This spends a small amount
 * of real Auphonic credit (minimum 3 minutes billed per production) --
 * confirmed acceptable by the user before this was built.
 */
function xhrRequest(method, url, apiKey, body, contentType, responseType) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    if (apiKey) xhr.setRequestHeader("Authorization", "bearer " + apiKey);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    // Confirmed real pattern (Adobe's oauth-workflow-sample, index.js): only set
    // responseType when explicitly requested, and read .response (not
    // .responseText) when it is -- .responseText would corrupt binary downloads
    // the same way an un-flagged local file read corrupts binary WAV bytes.
    if (responseType) xhr.responseType = responseType;
    xhr.onload = () => resolve({ status: xhr.status, body: responseType ? xhr.response : xhr.responseText });
    xhr.onerror = () => reject(new Error("Network/CORS failure -- no HTTP status returned"));
    xhr.ontimeout = () => reject(new Error("Request timed out"));
    xhr.timeout = 60000;
    if (body) xhr.send(body);
    else xhr.send();
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
 * Manual multipart/form-data body construction -- the documented fallback for
 * when FormData can't be trusted. Confirmed live: the WAV's bytes are intact
 * on read (RIFF/WAVE header verified), but upload via FormData+Blob still gets
 * rejected by Auphonic as "File type is not supported" regardless of filename
 * -- pointing at the FormData/Blob layer itself in this UXP host, not the file
 * or the field name. This builds the exact bytes Auphonic expects by hand, so
 * nothing depends on FormData's correctness.
 *
 * Every header line here is plain ASCII (boundary marker, Content-Disposition,
 * filename, Content-Type) so a simple char-code mapping is a correct encoder
 * -- no need for TextEncoder, which -- given TextDecoder's absence -- can't be
 * assumed to exist either.
 */
function encodeAsciiBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function concatBytes(chunks) {
  const parts = chunks.map((c) => (c instanceof Uint8Array ? c : new Uint8Array(c)));
  let total = 0;
  for (const p of parts) total += p.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }
  return result;
}

function buildMultipartBody(fieldName, filename, mimeType, fileArrayBuffer) {
  const boundary = "----AuphonicSpikeBoundary" + Math.floor(Math.random() * 1e9);
  const header =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const combined = concatBytes([
    encodeAsciiBytes(header),
    new Uint8Array(fileArrayBuffer),
    encodeAsciiBytes(footer),
  ]);

  return { body: combined.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function testAuphonicUpload() {
  clearLog("logE");
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) {
    writeLog("logE", "No API key entered in Spike A's field above.", "bad");
    return;
  }
  const presetUuid = document.getElementById("uploadPresetUuid").value.trim();
  if (!presetUuid) {
    writeLog("logE", "No preset UUID entered. Click \"Also List Presets\" in Spike A, copy one, paste it below.", "bad");
    return;
  }

  try {
    writeLog("logE", "Pick the WAV file to upload (e.g. from Test Exports) ...", "dim");
    const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["wav"] });
    if (!file) {
      writeLog("logE", "No file selected.", "bad");
      return;
    }
    writeLog("logE", `Selected: ${file.nativePath}`, "dim");

    writeLog("logE", "Reading file as binary (format: binary) ...", "dim");
    const arrayBuffer = await file.read({ format: uxp.storage.formats.binary });
    writeLog("logE", `Read ${arrayBuffer.byteLength} bytes.`, "ok");

    // Sanity-check the bytes are an intact WAV before blaming anything else --
    // "RIFF"...."WAVE" should be the first 12 bytes of any valid WAV file.
    const header = new Uint8Array(arrayBuffer.slice(0, 12));
    const headerStr = String.fromCharCode(header[0], header[1], header[2], header[3]) +
      "." + String.fromCharCode(header[8], header[9], header[10], header[11]);
    const looksLikeWav = headerStr === "RIFF.WAVE";
    writeLog("logE", `Header check: "${headerStr}" -- ${looksLikeWav ? "valid WAV header" : "NOT a valid WAV header, read may be corrupted"}`, looksLikeWav ? "ok" : "bad");

    writeLog("logE", "");
    writeLog("logE", "Step 1: creating production ...", "dim");
    const createRes = await xhrRequest(
      "POST",
      AUPHONIC + "/api/productions.json",
      apiKey,
      JSON.stringify({
        preset: presetUuid,
        metadata: { title: "Auphonic spike test upload" },
      }),
      "application/json"
    );
    writeLog("logE", `Create HTTP ${createRes.status}`, createRes.status === 200 ? "ok" : "bad");
    if (createRes.status !== 200) {
      writeLog("logE", createRes.body.slice(0, 500), "dim");
      return;
    }
    const createData = JSON.parse(createRes.body).data;
    const uuid = createData.uuid;
    writeLog("logE", `Production UUID: ${uuid}`, "ok");

    writeLog("logE", "");
    writeLog("logE", "Step 2: uploading input file (manual multipart body -- FormData ruled out) ...", "dim");
    const uploadFilename = "auphonic-spike-test.wav";
    const { body: multipartBody, contentType: multipartContentType } = buildMultipartBody(
      "input_file",
      uploadFilename,
      "audio/wav",
      arrayBuffer
    );
    writeLog("logE", `Manual multipart body: ${multipartBody.byteLength} bytes (file was ${arrayBuffer.byteLength})`, "dim");
    const uploadRes = await xhrRequest(
      "POST",
      AUPHONIC + `/api/production/${uuid}/upload.json`,
      apiKey,
      multipartBody,
      multipartContentType
    );
    writeLog("logE", `Upload HTTP ${uploadRes.status}`, uploadRes.status === 200 ? "ok" : "bad");
    if (uploadRes.status !== 200) {
      writeLog("logE", uploadRes.body.slice(0, 500), "bad");
      writeLog("logE", "Manual multipart body ALSO rejected -- FormData was not the (only) issue.", "bad");
      return;
    }

    writeLog("logE", "");
    writeLog("logE", "Step 3: starting production ...", "dim");
    const startRes = await xhrRequest("POST", AUPHONIC + `/api/production/${uuid}/start.json`, apiKey);
    writeLog("logE", `Start HTTP ${startRes.status}`, startRes.status === 200 ? "ok" : "bad");
    if (startRes.status !== 200) {
      writeLog("logE", startRes.body.slice(0, 500), "dim");
      return;
    }

    writeLog("logE", "");
    writeLog("logE", "Step 4: polling status (this bills a minimum of 3 minutes on Auphonic's side) ...", "dim");
    let statusData = null;
    for (let i = 0; i < 60; i++) {
      await sleep(i === 0 ? 8000 : 15000);
      const statusRes = await xhrRequest("GET", AUPHONIC + `/api/production/${uuid}/status.json`, apiKey);
      if (statusRes.status !== 200) {
        writeLog("logE", `Status poll HTTP ${statusRes.status}`, "bad");
        continue;
      }
      statusData = JSON.parse(statusRes.body).data;
      writeLog("logE", `  poll ${i + 1}: status=${statusData.status} (${statusData.status_string})`, "dim");
      if (statusData.status === 3) {
        writeLog("logE", "DONE.", "ok");
        break;
      }
      if (statusData.status === 2) {
        writeLog("logE", `ERROR: ${statusData.error_message}`, "bad");
        return;
      }
    }
    if (!statusData || statusData.status !== 3) {
      writeLog("logE", "Gave up polling after 60 attempts without a Done/Error status.", "bad");
      return;
    }

    writeLog("logE", "");
    writeLog("logE", "Step 5: fetching production detail for download URL ...", "dim");
    const detailRes = await xhrRequest("GET", AUPHONIC + `/api/production/${uuid}.json`, apiKey);
    if (detailRes.status !== 200) {
      writeLog("logE", `Detail HTTP ${detailRes.status}`, "bad");
      return;
    }
    const detailData = JSON.parse(detailRes.body).data;
    const outputFiles = detailData.output_files || [];
    if (outputFiles.length === 0) {
      writeLog("logE", "No output_files in the production detail response.", "bad");
      return;
    }
    const downloadUrl = outputFiles[0].download_url;
    writeLog("logE", `Download URL: ${downloadUrl}`, "dim");

    writeLog("logE", "Step 6: downloading result (binary-safe, responseType=arraybuffer) ...", "dim");
    const downloadRes = await xhrRequest(
      "GET",
      downloadUrl + `?bearer_token=${encodeURIComponent(apiKey)}`,
      null, null, null,
      "arraybuffer"
    );
    writeLog("logE", `Download HTTP ${downloadRes.status}`, downloadRes.status === 200 ? "ok" : "bad");
    if (downloadRes.status !== 200) return;
    writeLog("logE", `Downloaded ${downloadRes.body.byteLength} bytes.`, "dim");

    // Confirmed real pattern (Adobe's premiere-api sample, index.ts:2766):
    // folder.createFile(name, {overwrite}) -> file.write(data, options).
    // Using the plugin's own sandboxed data folder (getDataFolder, no picker
    // needed) rather than the external "Test Exports" folder, since writing to
    // an arbitrary external path from inside the panel needs an interactive
    // folder picker (getFolder()) -- confirmed in the same sample, and not
    // worth adding friction to this specific test.
    exportAttemptCounter += 1;
    const fileName = `auphonic-processed - attempt ${exportAttemptCounter}.wav`;
    const dataFolder = await uxp.storage.localFileSystem.getDataFolder();
    const outFile = await dataFolder.createFile(fileName, { overwrite: true });
    await outFile.write(downloadRes.body, { format: uxp.storage.formats.binary });
    writeLog("logE", `Saved to: ${outFile.nativePath}`, "ok");
    writeLog("logE", "SPIKE E PASSED -- full Auphonic round trip works.", "ok");
  } catch (err) {
    writeLog("logE", String(err.message || err), "bad");
  }
}

/* ------------------------------------------------------------------- wiring */
document.getElementById("presetPath").value = DEFAULT_WAV_PRESET;
document.getElementById("btnTestConn").addEventListener("click", testConnection);
document.getElementById("btnPresets").addEventListener("click", listPresets);
document.getElementById("btnInspect").addEventListener("click", inspectSelection);
document.getElementById("btnExportSubsequence").addEventListener("click", exportViaSubsequence);
document.getElementById("btnDebugApi").addEventListener("click", debugApiSurface);
document.getElementById("btnCleanupSubs").addEventListener("click", cleanupLeftoverSubsequences);
document.getElementById("btnTestDisableTrack").addEventListener("click", testDisableAndTrackCreation);
document.getElementById("btnTestSecureStorage").addEventListener("click", testSecureStorage);
document.getElementById("btnTestAuphonicUpload").addEventListener("click", testAuphonicUpload);
