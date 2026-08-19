/*
 * Timeline selection + eligibility validation (PRD 9.1).
 *
 * Phase 1 scope note: linked video+audio handling is explicitly out of scope
 * (PRD section 11) -- only a directly-selected audio track item is eligible.
 * A selected video clip is reported with a named reason, not silently
 * skipped or force-processed.
 *
 * getTrackIndex() is asserted by the PRD but was never confirmed live during
 * the spike phase, so rather than depend on a method that might not exist on
 * this build, media type AND track index are both derived the same proven
 * way Spike C already used: walking sequence.getAudioTrack(i)/getVideoTrack(i)
 * and matching by exact tick position, then reading whichever track the
 * match came from.
 *
 * The proxy/merged/multicam checks below call methods PRD 9.1 says exist on
 * ClipProjectItem but that were never exercised live. Each is feature-detected
 * -- if missing on this build, it's recorded in `diagnostics` (visible in the
 * panel's advanced log) instead of silently assumed either way, so a real gap
 * is visible rather than guessed at.
 */
const ppro = require("premierepro");
const { CATEGORY, AuphonicPluginError } = require("./errors.js");

function ticksOf(tickTime) {
  if (!tickTime) return null;
  if (typeof tickTime.ticksNumber === "number") {
    return String(tickTime.ticksNumber);
  }
  return String(tickTime.seconds);
}

async function sameTrackItem(a, b) {
  try {
    const aStart = ticksOf(await a.getStartTime());
    const bStart = ticksOf(await b.getStartTime());
    if (aStart !== bStart) return false;
    const aEnd = ticksOf(await a.getEndTime());
    const bEnd = ticksOf(await b.getEndTime());
    return aEnd === bEnd;
  } catch (e) {
    return false;
  }
}

async function locateTrackItem(sequence, trackItem) {
  const audioTrackCount = await sequence.getAudioTrackCount();
  for (let i = 0; i < audioTrackCount; i++) {
    const track = await sequence.getAudioTrack(i);
    const items = (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) || [];
    for (const item of items) {
      if (await sameTrackItem(item, trackItem)) return { mediaType: "audio", trackIndex: i };
    }
  }
  const videoTrackCount = await sequence.getVideoTrackCount();
  for (let i = 0; i < videoTrackCount; i++) {
    const track = await sequence.getVideoTrack(i);
    const items = (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) || [];
    for (const item of items) {
      if (await sameTrackItem(item, trackItem)) return { mediaType: "video", trackIndex: i };
    }
  }
  return { mediaType: "unknown", trackIndex: null };
}

async function checkOptionalFlag(clipProjectItem, methodName, diagnostics) {
  if (typeof clipProjectItem[methodName] !== "function") {
    diagnostics.push(`${methodName}() not available on this build -- skipped.`);
    return false;
  }
  try {
    return await clipProjectItem[methodName]();
  } catch (e) {
    diagnostics.push(`${methodName}() threw: ${e.message || e} -- treated as not applicable.`);
    return false;
  }
}

async function classifyAndValidate(sequence, trackItem) {
  const diagnostics = [];
  const location = await locateTrackItem(sequence, trackItem);

  // Best-effort name up front so every skip reason below can name the clip
  // (PRD 6.3: "Skipped: <name> - <reason>" beats a silent or generic skip).
  let clipName = "selected item";
  let projectItem = null;
  try {
    projectItem = await trackItem.getProjectItem();
    if (projectItem && projectItem.name) clipName = projectItem.name;
  } catch (e) {
    diagnostics.push(`getProjectItem() threw: ${e.message || e}`);
  }

  if (location.mediaType === "unknown") {
    return { eligible: false, clipName, reason: "Could not determine what kind of item this is on the timeline." };
  }
  if (location.mediaType === "video") {
    return {
      eligible: false,
      clipName,
      reason: "Video clips are not supported yet -- select the audio item directly (Phase 2 will add linked-audio support).",
    };
  }

  if (!projectItem) {
    return { eligible: false, clipName, reason: "Selected item has no associated project item." };
  }

  const clipProjectItem = await ppro.ClipProjectItem.cast(projectItem);
  if (!clipProjectItem) {
    return {
      eligible: false,
      clipName,
      reason: "Not a plain clip -- merged clips, multicam clips, and nested sequences are not supported.",
    };
  }

  if (typeof clipProjectItem.isSequence === "function") {
    const isSeq = await clipProjectItem.isSequence();
    if (isSeq) return { eligible: false, clipName, reason: "Nested sequences are not supported." };
  }

  const isMulticam = await checkOptionalFlag(clipProjectItem, "isMulticam", diagnostics);
  if (isMulticam) return { eligible: false, clipName, reason: "Multicam clips are not supported." };

  const isMerged = await checkOptionalFlag(clipProjectItem, "isMergedClip", diagnostics);
  if (isMerged) return { eligible: false, clipName, reason: "Merged clips are not supported." };

  const isProxy = await checkOptionalFlag(clipProjectItem, "isProxy", diagnostics);
  if (isProxy) return { eligible: false, clipName, reason: "Proxy media is not supported -- switch to full-resolution media first." };

  let mediaPath = null;
  try {
    mediaPath = await clipProjectItem.getMediaFilePath();
  } catch (e) {
    diagnostics.push(`getMediaFilePath() threw: ${e.message || e}`);
  }
  if (!mediaPath) {
    return { eligible: false, clipName, reason: "Source media is offline -- reconnect the media and try again." };
  }

  if (typeof trackItem.getSpeed === "function") {
    try {
      const speed = await trackItem.getSpeed();
      if (speed !== undefined && speed !== null && Math.abs(speed - 1) > 0.0001) {
        return { eligible: false, clipName, reason: `Speed-changed or reversed clips are not supported (speed: ${speed}x).` };
      }
    } catch (e) {
      diagnostics.push(`getSpeed() threw: ${e.message || e}`);
    }
  }

  const startTime = await trackItem.getStartTime();
  const endTime = await trackItem.getEndTime();
  const durationSeconds = endTime.seconds - startTime.seconds;
  if (!(durationSeconds > 0)) {
    return { eligible: false, clipName, reason: "Selected clip has zero or negative duration." };
  }

  return {
    eligible: true,
    reason: null,
    clipProjectItem,
    projectItem,
    mediaPath,
    trackIndex: location.trackIndex,
    startTime,
    endTime,
    durationSeconds,
    clipName: projectItem.name,
    diagnostics,
  };
}

async function resolveSelection() {
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    throw new AuphonicPluginError(CATEGORY.SELECTION, "No project is open.");
  }
  const sequence = await project.getActiveSequence();
  if (!sequence) {
    throw new AuphonicPluginError(CATEGORY.SELECTION, "No active sequence -- open a timeline first.");
  }
  const selection = await sequence.getSelection();
  const trackItems = selection ? await selection.getTrackItems() : [];
  if (!trackItems || trackItems.length === 0) {
    throw new AuphonicPluginError(CATEGORY.SELECTION, "Nothing is selected on the timeline.");
  }
  if (trackItems.length > 1) {
    throw new AuphonicPluginError(
      CATEGORY.UNSUPPORTED_CLIP,
      `${trackItems.length} clips are selected. This version handles one clip at a time -- select just one and try again.`
    );
  }

  const trackItem = trackItems[0];
  const validation = await classifyAndValidate(sequence, trackItem);
  return { project, sequence, trackItem, ...validation };
}

module.exports = { resolveSelection, classifyAndValidate, locateTrackItem };
