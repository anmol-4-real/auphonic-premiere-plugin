/*
 * Timeline selection + eligibility validation (PRD 9.1).
 *
 * Phase 1 scope note: linked video+audio handling is explicitly out of scope
 * (PRD section 11) -- only a directly-selected audio track item is eligible.
 * A selected video clip is reported with a named reason, not silently
 * skipped or force-processed.
 *
 * getTrackIndex() is asserted by the PRD but was never confirmed live during
 * the spike phase, so trackIndex is derived the same proven way Spike C
 * already used: walking sequence.getAudioTrack(i)/getVideoTrack(i) and
 * matching by exact tick position.
 *
 * Media TYPE (audio vs. video) is NOT derived by tick position, even though
 * an earlier version of this file did that -- confirmed live to misclassify
 * a video clip as "audio" whenever it has linked audio at the same timeline
 * position, which is the normal case for any video-with-sound clip (they
 * share the exact same start/end time by construction, so tick-matching
 * finds the linked audio item first and wrongly reports the selection as
 * eligible audio). Fixed by checking the selected trackItem's own type
 * directly: ppro.AudioClipTrackItem.cast()/VideoClipTrackItem.cast() were
 * tried first but confirmed NOT to exist on this build (a live shape dump of
 * the actual object settled it). What does work, confirmed live: the classes
 * ppro.AudioClipTrackItem/ppro.VideoClipTrackItem exist (just without a
 * .cast() static method), and instanceof against them correctly identifies
 * a real selected trackItem -- confirmed via trackItem.constructor.name
 * reading exactly "VideoClipTrackItem" for a selected video clip. The old
 * tick heuristic remains only as a last-resort fallback if instanceof ever
 * fails to resolve either way, and every step is recorded in `diagnostics`
 * so this stays visible, not silent.
 *
 * The proxy/merged/multicam checks below call methods PRD 9.1 says exist on
 * ClipProjectItem but that were never exercised live. Each is feature-detected
 * -- if missing on this build, it's recorded in `diagnostics` (visible in the
 * panel's advanced log) instead of silently assumed either way, so a real gap
 * is visible rather than guessed at.
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on window.Auphonic.errors, which
 * must be loaded first. Published on window.Auphonic.selection.
 */
(function () {
  const ppro = require("premierepro");
  const { CATEGORY, AuphonicPluginError } = window.Auphonic.errors;

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

  /*
   * Primary media-type check: ask the trackItem itself what it is, via the
   * same cast() convention confirmed for ClipProjectItem/FolderItem. Not
   * itself confirmed live for track items -- feature-detected, and every
   * outcome (available/unavailable/threw) is recorded in diagnostics.
   */
  /*
   * Confirmed live (via a one-shot shape dump): ppro.AudioClipTrackItem and
   * ppro.VideoClipTrackItem are real classes on this build -- they just
   * don't have a .cast() static method like ClipProjectItem does. The
   * trackItem's own constructor is directly named after its real type
   * (confirmed: trackItem.constructor.name === "VideoClipTrackItem" for a
   * selected video clip), so instanceof against those classes is the
   * correct check, with the constructor-name string as a fallback in case
   * instanceof somehow doesn't hold on a differently-built object.
   */
  function detectMediaTypeByClass(trackItem, diagnostics) {
    try {
      if (ppro.VideoClipTrackItem && trackItem instanceof ppro.VideoClipTrackItem) {
        diagnostics.push("Media type resolved via instanceof ppro.VideoClipTrackItem: video.");
        return "video";
      }
    } catch (e) {
      diagnostics.push(`instanceof ppro.VideoClipTrackItem threw: ${e.message || e}`);
    }
    try {
      if (ppro.AudioClipTrackItem && trackItem instanceof ppro.AudioClipTrackItem) {
        diagnostics.push("Media type resolved via instanceof ppro.AudioClipTrackItem: audio.");
        return "audio";
      }
    } catch (e) {
      diagnostics.push(`instanceof ppro.AudioClipTrackItem threw: ${e.message || e}`);
    }

    let ctorName = null;
    try {
      ctorName = trackItem && trackItem.constructor && trackItem.constructor.name;
    } catch (e) {
      diagnostics.push(`reading trackItem.constructor.name threw: ${e.message || e}`);
    }
    if (ctorName === "VideoClipTrackItem") {
      diagnostics.push("Media type resolved via constructor.name fallback: video.");
      return "video";
    }
    if (ctorName === "AudioClipTrackItem") {
      diagnostics.push("Media type resolved via constructor.name fallback: audio.");
      return "audio";
    }

    diagnostics.push(`Could not resolve media type via instanceof or constructor.name (constructor.name was "${ctorName}").`);
    return null;
  }

  async function findTrackIndexByTicks(sequence, trackItem, mediaType) {
    const count = mediaType === "video" ? await sequence.getVideoTrackCount() : await sequence.getAudioTrackCount();
    for (let i = 0; i < count; i++) {
      const track = mediaType === "video" ? await sequence.getVideoTrack(i) : await sequence.getAudioTrack(i);
      const items = (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) || [];
      for (const item of items) {
        if (await sameTrackItem(item, trackItem)) return i;
      }
    }
    return null;
  }

  async function locateTrackItem(sequence, trackItem, diagnostics) {
    const diag = diagnostics || [];
    const classType = detectMediaTypeByClass(trackItem, diag);
    if (classType) {
      const trackIndex = await findTrackIndexByTicks(sequence, trackItem, classType);
      return { mediaType: classType, trackIndex };
    }

    // Fallback only: instanceof/constructor.name above couldn't resolve it.
    // This tick-position heuristic CAN misclassify a video clip as audio
    // when it has linked audio at the same position -- flagged loudly
    // rather than silently trusted.
    diag.push("Falling back to tick-position heuristic for media type -- this can misclassify a video clip that has linked audio at the same position.");
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
    const location = await locateTrackItem(sequence, trackItem, diagnostics);

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
      return { eligible: false, clipName, diagnostics, reason: "Could not determine what kind of item this is on the timeline." };
    }
    if (location.mediaType === "video") {
      return {
        eligible: false,
        clipName,
        diagnostics,
        reason: "Video clips are not supported yet -- select the audio item directly (Phase 2 will add linked-audio support).",
      };
    }

    if (!projectItem) {
      return { eligible: false, clipName, diagnostics, reason: "Selected item has no associated project item." };
    }

    const clipProjectItem = await ppro.ClipProjectItem.cast(projectItem);
    if (!clipProjectItem) {
      return {
        eligible: false,
        clipName,
        diagnostics,
        reason: "Not a plain clip -- merged clips, multicam clips, and nested sequences are not supported.",
      };
    }

    if (typeof clipProjectItem.isSequence === "function") {
      const isSeq = await clipProjectItem.isSequence();
      if (isSeq) return { eligible: false, clipName, diagnostics, reason: "Nested sequences are not supported." };
    }

    const isMulticam = await checkOptionalFlag(clipProjectItem, "isMulticam", diagnostics);
    if (isMulticam) return { eligible: false, clipName, diagnostics, reason: "Multicam clips are not supported." };

    const isMerged = await checkOptionalFlag(clipProjectItem, "isMergedClip", diagnostics);
    if (isMerged) return { eligible: false, clipName, diagnostics, reason: "Merged clips are not supported." };

    const isProxy = await checkOptionalFlag(clipProjectItem, "isProxy", diagnostics);
    if (isProxy) return { eligible: false, clipName, diagnostics, reason: "Proxy media is not supported -- switch to full-resolution media first." };

    let mediaPath = null;
    try {
      mediaPath = await clipProjectItem.getMediaFilePath();
    } catch (e) {
      diagnostics.push(`getMediaFilePath() threw: ${e.message || e}`);
    }
    if (!mediaPath) {
      return { eligible: false, clipName, diagnostics, reason: "Source media is offline -- reconnect the media and try again." };
    }

    if (typeof trackItem.getSpeed === "function") {
      try {
        const speed = await trackItem.getSpeed();
        if (speed !== undefined && speed !== null && Math.abs(speed - 1) > 0.0001) {
          return { eligible: false, clipName, diagnostics, reason: `Speed-changed or reversed clips are not supported (speed: ${speed}x).` };
        }
      } catch (e) {
        diagnostics.push(`getSpeed() threw: ${e.message || e}`);
      }
    }

    const startTime = await trackItem.getStartTime();
    const endTime = await trackItem.getEndTime();
    const durationSeconds = endTime.seconds - startTime.seconds;
    if (!(durationSeconds > 0)) {
      return { eligible: false, clipName, diagnostics, reason: "Selected clip has zero or negative duration." };
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

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.selection = { resolveSelection, classifyAndValidate, locateTrackItem };
})();
