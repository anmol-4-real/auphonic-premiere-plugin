/*
 * Timeline placement (PRD 9.5). Order matters: the original clip's audio is
 * only disabled AFTER the cleaned file is placed successfully. If anything
 * above fails, the user's edit is untouched.
 *
 * Track auto-creation is confirmed live only for createInsertProjectItemAction
 * (HANDOFF.md) -- createOverwriteItemAction's behavior at an out-of-range
 * track index was never tested. So: when no track exists below the original,
 * use insert (with limitedShift=true, so it can't ripple other tracks) to
 * create the track and place the clip in one step -- on a brand-new empty
 * track, insert and overwrite have identical effect anyway, since there's
 * nothing there to shift. When a track already exists below, use overwrite,
 * per the PRD's explicit preference, to avoid rippling the timeline.
 *
 * Phase 2 (PRD 9.5's "prompt rather than assume"): collision detection on an
 * existing destination track is now available via findCollisionOnAudioTrack,
 * built on the same track.getTrackItems() primitive selection.js already
 * uses to enumerate tracks -- no such API existed anywhere in this project
 * or in Adobe's own reference sample before this (confirmed by grep). The
 * caller (panel.js) runs this pre-flight, before any credits are spent, and
 * if it finds a collision, passes forceNewTrackBelow=true to importAndPlace
 * rather than letting overwrite silently clobber whatever's there.
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on window.Auphonic.errors and
 * window.Auphonic.ticks, which must be loaded first. Published on
 * window.Auphonic.insertion.
 */
(function () {
  const ppro = require("premierepro");
  const { CATEGORY, AuphonicPluginError, wrap } = window.Auphonic.errors;
  const ticks = window.Auphonic.ticks;

  /*
   * Does anything already sit in [startTime, endTime) on the given audio
   * track? Returns the colliding track item, or null if the track doesn't
   * exist yet (no track = nothing to collide with) or is clear in that range.
   * Overlap, not exact-match -- a collision doesn't require identical
   * boundaries, just any shared time.
   */
  async function findCollisionOnAudioTrack(sequence, audioTrackIndex, startTime, endTime) {
    const audioTrackCount = await sequence.getAudioTrackCount();
    if (audioTrackIndex >= audioTrackCount) return null;

    const track = await sequence.getAudioTrack(audioTrackIndex);
    const items = (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) || [];
    const targetStart = ticks.ticksNumberOf(startTime);
    const targetEnd = ticks.ticksNumberOf(endTime);

    for (const item of items) {
      const itemStart = ticks.ticksNumberOf(await item.getStartTime());
      const itemEnd = ticks.ticksNumberOf(await item.getEndTime());
      if (ticks.rangesOverlap(targetStart, targetEnd, itemStart, itemEnd)) {
        return item;
      }
    }
    return null;
  }

  function sanitizeFilenamePart(name) {
    const cleaned = String(name || "").replace(/[\/:*?"<>|]/g, "_").trim();
    return cleaned || "clip";
  }

  function buildOutputName(originalClipName, presetName) {
    return `${sanitizeFilenamePart(originalClipName)}_Auphonic_${sanitizeFilenamePart(presetName)}.wav`;
  }

  async function findProjectItemByMediaPath(project, mediaPath) {
    const rootItem = await project.getRootItem();
    const items = (await rootItem.getItems()) || [];
    for (const item of items) {
      try {
        const clipItem = await ppro.ClipProjectItem.cast(item);
        if (!clipItem) continue;
        const path = await clipItem.getMediaFilePath();
        if (path === mediaPath) return item;
      } catch (e) {
        // Not a clip project item (e.g. a bin) -- skip.
      }
    }
    return null;
  }

  /*
   * originalTrackItem/originalTrackIndex/startTime describe the clip Phase 1
   * validated and exported. outputFilePath is the local cleaned WAV on disk.
   */
  async function importAndPlace({
    project,
    sequence,
    originalTrackItem,
    originalTrackIndex,
    startTime,
    outputFilePath,
    originalClipName,
    presetName,
    forceNewTrackBelow = false,
  }) {
    // Adobe's own sample calls importFiles(filePaths, true, undefined, false)
    // -- confirmed live to throw "Illegal Parameter type" on this build.
    // Passing explicit `undefined`/`false` for the optional trailing args
    // may not be accepted the same way an absent argument is (the same class
    // of quirk already found with encodeFile's arg count) -- dropping them
    // and coercing the path to a plain string covers both plausible causes.
    const filePath = String(outputFilePath);
    let importOk = false;
    try {
      console.log(`Auphonic: project.importFiles(["${filePath}"], true) -- native arity is importFiles.length=${project.importFiles.length}`);
      importOk = await project.importFiles([filePath], true);
    } catch (err) {
      throw wrap(CATEGORY.IMPORT_FAILED, err, "Import failed");
    }
    if (!importOk) {
      throw new AuphonicPluginError(CATEGORY.IMPORT_FAILED, "Premiere reported the import did not succeed.");
    }

    const importedItem = await findProjectItemByMediaPath(project, filePath);
    if (!importedItem) {
      throw new AuphonicPluginError(
        CATEGORY.IMPORT_FAILED,
        "File imported, but could not find the resulting project item to place it on the timeline."
      );
    }

    const newName = buildOutputName(originalClipName, presetName);
    try {
      let renameOk = false;
      project.lockedAccess(() => {
        renameOk = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(importedItem.createSetNameAction(newName));
        }, "Rename Auphonic result");
      });
      if (!renameOk) {
        // Non-fatal -- placement can proceed under the default imported name.
      }
    } catch (e) {
      // Non-fatal.
    }

    const preferredTrackIndex = originalTrackIndex + 1;
    const audioTrackCount = await sequence.getAudioTrackCount();
    // forceNewTrackBelow (set when the pre-flight collision check found
    // something already on preferredTrackIndex) always targets a track index
    // equal to the current count -- the only index auto-creation is
    // confirmed to work at (HANDOFF.md) -- rather than the colliding index.
    const needsNewTrack = forceNewTrackBelow || preferredTrackIndex >= audioTrackCount;
    const targetTrackIndex = needsNewTrack ? audioTrackCount : preferredTrackIndex;
    const sequenceEditor = ppro.SequenceEditor.getEditor(sequence);

    let placeOk = false;
    try {
      project.lockedAccess(() => {
        placeOk = project.executeTransaction((compoundAction) => {
          const action = needsNewTrack
            ? sequenceEditor.createInsertProjectItemAction(importedItem, startTime, 0, targetTrackIndex, true)
            : sequenceEditor.createOverwriteItemAction(importedItem, startTime, 0, targetTrackIndex);
          compoundAction.addAction(action);
        }, "Place Auphonic result on timeline");
      });
    } catch (err) {
      throw wrap(CATEGORY.INSERTION_COLLISION, err, "Placement failed");
    }
    if (!placeOk) {
      throw new AuphonicPluginError(CATEGORY.INSERTION_COLLISION, "Could not place the cleaned clip on the timeline.");
    }

    // Only now -- after placement is confirmed -- disable the original.
    let disableOk = false;
    let disableError = null;
    try {
      project.lockedAccess(() => {
        disableOk = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(originalTrackItem.createSetDisabledAction(true));
        }, "Disable original audio after Auphonic replacement");
      });
    } catch (err) {
      disableError = err.message || String(err);
    }

    return {
      importedItem,
      newName,
      targetTrackIndex,
      createdNewTrack: needsNewTrack,
      disableOk,
      disableError,
    };
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.insertion = {
    importAndPlace,
    buildOutputName,
    findProjectItemByMediaPath,
    findCollisionOnAudioTrack,
  };
})();
