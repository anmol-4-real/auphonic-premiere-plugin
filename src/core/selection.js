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
 * Phase 2 (PRD 9.1, 9.5): a selected video clip is no longer rejected
 * outright -- resolveLinkedAudio() below looks for its linked audio item by
 * matching the same underlying media file (getMediaFilePath() equality, the
 * exact pattern already used in insertion.js's findProjectItemByMediaPath)
 * PLUS an overlapping timeline range. Overlap, not exact-match: exact-match-
 * by-position is precisely the mechanism that caused this file's own bug #2
 * (see above) -- here we deliberately want the item at the (near-)identical
 * position, since that's what "linked" means for a video+audio pair, but
 * "overlapping" tolerates a pair that's been independently trimmed slightly.
 * Once resolved, every remaining check in classifyAndValidate runs against
 * the resolved AUDIO item, never the video item -- the video is never
 * touched, exactly as PRD 9.1/9.5 require.
 *
 * Phase 4a (PRD 11): resolveQueueCandidates() replaces resolveSelection() and
 * generalizes the old exactly-2-items collapseLinkedPairSelection to any N
 * selected items -- see partitionSelectionIntoUnits below. classifyAndValidate
 * itself is unchanged; it already worked per-clip.
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on window.Auphonic.errors and
 * window.Auphonic.ticks, which must be loaded first. Published on
 * window.Auphonic.selection.
 */
(function () {
  const ppro = require("premierepro");
  const { CATEGORY, AuphonicPluginError } = window.Auphonic.errors;
  const ticks = window.Auphonic.ticks;

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

  /*
   * Searches every audio track for the item linked to videoTrackItem: same
   * underlying media file, overlapping timeline range. Returns
   * { trackItem, trackIndex } or null if nothing matches.
   */
  async function resolveLinkedAudio(sequence, videoTrackItem, diagnostics) {
    let videoMediaPath = null;
    try {
      const videoProjectItem = await videoTrackItem.getProjectItem();
      const videoClipItem = await ppro.ClipProjectItem.cast(videoProjectItem);
      if (videoClipItem) videoMediaPath = await videoClipItem.getMediaFilePath();
    } catch (e) {
      diagnostics.push(`Could not read the video clip's media path for linked-audio matching: ${e.message || e}`);
      return null;
    }
    if (!videoMediaPath) {
      diagnostics.push("Video clip has no resolvable media path -- cannot search for linked audio.");
      return null;
    }

    const videoStartTicks = ticks.ticksNumberOf(await videoTrackItem.getStartTime());
    const videoEndTicks = ticks.ticksNumberOf(await videoTrackItem.getEndTime());

    const audioTrackCount = await sequence.getAudioTrackCount();
    for (let i = 0; i < audioTrackCount; i++) {
      const track = await sequence.getAudioTrack(i);
      const items = (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) || [];
      for (const item of items) {
        let itemMediaPath = null;
        try {
          const itemProjectItem = await item.getProjectItem();
          const itemClipItem = await ppro.ClipProjectItem.cast(itemProjectItem);
          if (itemClipItem) itemMediaPath = await itemClipItem.getMediaFilePath();
        } catch (e) {
          continue;
        }
        if (!itemMediaPath || itemMediaPath !== videoMediaPath) continue;

        const itemStartTicks = ticks.ticksNumberOf(await item.getStartTime());
        const itemEndTicks = ticks.ticksNumberOf(await item.getEndTime());
        if (ticks.rangesOverlap(videoStartTicks, videoEndTicks, itemStartTicks, itemEndTicks)) {
          diagnostics.push(`Linked audio resolved on audio track ${i + 1} (matching media file + overlapping range).`);
          return { trackItem: item, trackIndex: i };
        }
      }
    }
    diagnostics.push("No audio track item with a matching media file and overlapping range was found.");
    return null;
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
    let originalSelectionType = "audio";
    let linkedAudioResolved = false;

    if (location.mediaType === "unknown") {
      return { eligible: false, clipName: "selected item", diagnostics, reason: "Could not determine what kind of item this is on the timeline." };
    }

    if (location.mediaType === "video") {
      originalSelectionType = "video";
      const linked = await resolveLinkedAudio(sequence, trackItem, diagnostics);
      if (!linked) {
        let videoClipName = "selected item";
        try {
          const videoProjectItem = await trackItem.getProjectItem();
          if (videoProjectItem && videoProjectItem.name) videoClipName = videoProjectItem.name;
        } catch (e) {
          // Best-effort name only -- fall through with the generic label.
        }
        return { eligible: false, clipName: videoClipName, diagnostics, reason: "No linked audio found for this video clip." };
      }
      // From here on, every check runs against the resolved AUDIO item --
      // the video item is never touched again (never disabled, never
      // exported), per PRD 9.1/9.5.
      trackItem = linked.trackItem;
      location.trackIndex = linked.trackIndex;
      location.mediaType = "audio";
      linkedAudioResolved = true;
    }

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
      trackItem,
      mediaPath,
      trackIndex: location.trackIndex,
      startTime,
      endTime,
      durationSeconds,
      clipName: projectItem.name,
      originalSelectionType,
      linkedAudioResolved,
      diagnostics,
    };
  }

  /*
   * Phase 4a: partitions an arbitrary N-item timeline selection into
   * independent units. Generalizes the old exactly-2-items
   * collapseLinkedPairSelection: every selected video item is paired with
   * its own linked audio (same resolveLinkedAudio media-path+overlap match
   * used everywhere else in this file) if that linked audio is ALSO present
   * in the raw selection, so a normal click on a video clip (which selects
   * video+audio together) still produces exactly one unit, not two. Any
   * selected item left over after pairing -- plain audio clips, or a video
   * whose linked audio wasn't itself selected -- becomes its own unit.
   * classifyAndValidate still does the real eligibility work per unit,
   * including resolving linked audio for a lone-selected video item -- this
   * function only decides how many independent units the raw selection
   * represents.
   */
  async function partitionSelectionIntoUnits(sequence, trackItems, diagnostics) {
    const videoItems = [];
    const leftover = [];
    for (const item of trackItems) {
      const type = detectMediaTypeByClass(item, diagnostics);
      if (type === "video") {
        videoItems.push(item);
      } else {
        leftover.push(item);
      }
    }

    for (const videoItem of videoItems) {
      const linked = await resolveLinkedAudio(sequence, videoItem, diagnostics);
      if (!linked) continue;
      for (let i = leftover.length - 1; i >= 0; i--) {
        if (await sameTrackItem(leftover[i], linked.trackItem)) {
          leftover.splice(i, 1);
          break;
        }
      }
    }

    return [...videoItems, ...leftover];
  }

  /*
   * Replaces the old single-clip resolveSelection(). Returns one entry per
   * independent unit in the current timeline selection -- eligible AND
   * ineligible units both included, each carrying classifyAndValidate's own
   * per-clip result (including its own named skip reason), exactly like the
   * single-clip flow's skip messages worked before. Throws only for the
   * selection-level cases that make no sense to report per-unit: no open
   * project/sequence, or nothing selected at all.
   */
  async function resolveQueueCandidates() {
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

    const diagnostics = [];
    const unitItems = await partitionSelectionIntoUnits(sequence, trackItems, diagnostics);

    const units = [];
    for (const unitItem of unitItems) {
      const validation = await classifyAndValidate(sequence, unitItem);
      units.push({ trackItem: unitItem, ...validation });
    }

    return { project, sequence, units, diagnostics };
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.selection = { resolveQueueCandidates, classifyAndValidate, locateTrackItem, resolveLinkedAudio };
})();
