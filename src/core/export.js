/*
 * Clip audio export -- the proven subsequence approach from Spike B,
 * generalized for reuse (see HANDOFF.md for why this exists at all):
 * encodeFile()/encodeProjectItem() with explicit in/out silently export the
 * WHOLE source file, not the trim. Narrowing the sequence's own In/Out and
 * exporting a subsequence created from that range is what actually works.
 *
 * ExportType.IMMEDIATELY renders synchronously -- the resolved boolean IS
 * the finished signal. Do not wait for EVENT_RENDER_COMPLETE; it never fires
 * for this path (confirmed live).
 *
 * The WAV preset is bundled with the plugin (assets/presets/) rather than
 * referenced by an absolute Adobe Media Encoder install path, so this
 * doesn't break on a version upgrade or on a machine with AME installed
 * somewhere else. getPluginFolder() has not been exercised live yet in this
 * project -- worth confirming on the first real export test.
 *
 * Phase 2 handles (PRD 9.6): widening the sequence-time export range fed to
 * exportRangeToFile does NOT work -- a subsequence created from a narrowed
 * sequence range only ever contains what's actually edited onto the
 * timeline in that window, not the real trimmed-off source audio sitting
 * unused in the source file. exportHandleWidenedRange below works around
 * this using only already-proven primitives: create a disposable
 * subsequence exactly as exportRangeToFile does, disable whatever got
 * copied into it (so it can't contaminate the render either way -- whether
 * exportSequence respects a further in/out narrow or renders the whole
 * subsequence), insert a SECOND placement of the same clipProjectItem on a
 * fresh scratch track far past any existing content, widen THAT scratch
 * item's own in/out to the handle range (never the original's), then narrow
 * the subsequence to bracket exactly the widened scratch item before
 * exporting. See HANDOFF.md/the Phase 2 plan for the full reasoning -- this
 * is the one genuinely new hypothesis in Phase 2 and needs live
 * verification (listen to the exported WAV for real widened content at both
 * edges) before any UI is built on top of it.
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on window.Auphonic.errors and
 * window.Auphonic.ticks, which must be loaded first. Published on
 * window.Auphonic.exportModule.
 */
(function () {
  const ppro = require("premierepro");
  const uxp = require("uxp");
  const { CATEGORY, AuphonicPluginError, wrap } = window.Auphonic.errors;
  const ticks = window.Auphonic.ticks;

  const BUNDLED_PRESET_RELATIVE_PATH = "assets/presets/Waveform Audio 48kHz 16-bit.epr";

  async function getBundledPresetPath() {
    const pluginFolder = await uxp.storage.localFileSystem.getPluginFolder();
    const assetsFolder = await pluginFolder.getEntry("assets");
    const presetsFolder = await assetsFolder.getEntry("presets");
    const presetFile = await presetsFolder.getEntry("Waveform Audio 48kHz 16-bit.epr");
    return presetFile.nativePath;
  }

  /*
   * Phase 4a (confirmed live, two rounds of live evidence -- see HANDOFF.md
   * discipline): sequence.createSubsequence(true) copies in every currently
   * SELECTED item, not just whatever falls inside the narrowed in/out range
   * set right before it, and items keep their ORIGINAL ABSOLUTE timeline
   * position (no renormalization to relative tick 0). Never surfaced in
   * Phases 1-3 because exactly one item was ever selected during a
   * single-clip run.
   *
   * First fix attempt: disable every copied item except the one nearest
   * relative tick 0. Wrong on two counts, both confirmed live: (1) disabling
   * a clip only silences it within the render, it does NOT shrink the
   * exported duration -- the "fixed" export was still the full combined
   * duration of every originally-selected clip, just with everything but one
   * clip's own portion silenced. (2) matching against relative tick 0
   * happened to work for the one clip whose own absolute start truly was 0,
   * and wrongly disabled every OTHER job's own legitimate clip too (since
   * their absolute start isn't near 0), leaving them fully silent --
   * exactly the kind of input Auphonic's own processing rejected with a
   * generic error.
   *
   * Real fix: exportHandleWidenedRange already proves the correct mechanism
   * for bounding export duration -- narrow the SUBSEQUENCE's OWN in/out
   * (not the original sequence's) to the exact range that should be
   * rendered, confirmed live to work (Phase 2's widened-handles audio was
   * confirmed audible exactly at its intended boundaries, not the whole
   * seed range). Applying that same proven step here, narrowed to the
   * target clip's own absolute [startTime, endTime), correctly bounds the
   * export regardless of whatever else got copied in by selection.
   */
  async function narrowSubsequenceToTargetRange(project, subsequence, startTime, endTime) {
    // Diagnostic (not yet confirmed live for every case -- one batch job in
    // 4 came back at the full pre-narrow duration despite this transaction
    // reporting success): log requested vs. actually-applied in/out so a
    // mismatch is visible directly, rather than inferred from output file
    // size after the fact a second time.
    const beforeIn = ticks.ticksNumberOf(await subsequence.getInPoint());
    const beforeOut = ticks.ticksNumberOf(await subsequence.getOutPoint());

    let narrowOk = false;
    project.lockedAccess(() => {
      narrowOk = project.executeTransaction((compoundAction) => {
        compoundAction.addAction(subsequence.createSetInPointAction(startTime));
        compoundAction.addAction(subsequence.createSetOutPointAction(endTime));
      }, "Narrow export subsequence to the target clip's own range");
    });
    if (!narrowOk) {
      throw new AuphonicPluginError(
        CATEGORY.EXPORT_FAILED,
        "Could not narrow the export subsequence to the target clip's own range."
      );
    }

    const afterIn = ticks.ticksNumberOf(await subsequence.getInPoint());
    const afterOut = ticks.ticksNumberOf(await subsequence.getOutPoint());
    const requestedIn = ticks.ticksNumberOf(startTime);
    const requestedOut = ticks.ticksNumberOf(endTime);
    console.log(
      `Auphonic export narrow diagnostic: requested in/out = ${requestedIn}/${requestedOut}, ` +
        `subsequence before = ${beforeIn}/${beforeOut}, after = ${afterIn}/${afterOut}` +
        (afterIn !== requestedIn || afterOut !== requestedOut ? " -- MISMATCH, narrow did not apply as requested." : " -- matches.")
    );
  }

  /*
   * Exports the audio range [startTime, endTime) of `sequence` to `outputFile`
   * (a UXP File entry -- its .nativePath is what's actually handed to the
   * encoder). Leaves the sequence's own In/Out exactly as found, regardless of
   * success or failure.
   */
  async function exportRangeToFile(project, sequence, startTime, endTime, outputFile) {
    const encoder = ppro.EncoderManager.getManager();
    if (!encoder.isAMEInstalled) {
      throw new AuphonicPluginError(CATEGORY.AME_UNAVAILABLE, "Adobe Media Encoder is not installed or not compatible.");
    }

    const originalSeqIn = await sequence.getInPoint();
    const originalSeqOut = await sequence.getOutPoint();
    let subsequence = null;
    let seqInOutRestored = false;

    const restoreSeqInOut = () => {
      if (seqInOutRestored) return;
      try {
        project.lockedAccess(() => {
          project.executeTransaction((compoundAction) => {
            compoundAction.addAction(sequence.createSetInPointAction(originalSeqIn));
            compoundAction.addAction(sequence.createSetOutPointAction(originalSeqOut));
          }, "Restore sequence in/out after export");
        });
        seqInOutRestored = true;
      } catch (e) {
        // Non-fatal -- surfaced to the caller via the thrown error's details if
        // the outer export itself fails; a restore failure alone shouldn't mask
        // whether the export succeeded.
      }
    };

    try {
      let setOk = false;
      project.lockedAccess(() => {
        setOk = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(sequence.createSetInPointAction(startTime));
          compoundAction.addAction(sequence.createSetOutPointAction(endTime));
        }, "Narrow sequence in/out for clip export");
      });
      if (!setOk) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "Could not narrow the sequence in/out to the clip's range.");
      }

      subsequence = await sequence.createSubsequence(true);
      if (!subsequence) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "createSubsequence() returned nothing.");
      }

      // Subsequence is independent from here on -- restore the real sequence's
      // in/out immediately rather than leaving it narrowed for the rest of export.
      restoreSeqInOut();

      await narrowSubsequenceToTargetRange(project, subsequence, startTime, endTime);

      if (typeof project.setActiveSequence === "function") {
        try {
          await project.setActiveSequence(sequence);
        } catch (e) {
          // Non-fatal.
        }
      }

      const exportType = ppro.Constants && ppro.Constants.ExportType && ppro.Constants.ExportType.IMMEDIATELY;
      if (exportType === undefined) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "ppro.Constants.ExportType.IMMEDIATELY is not available on this build.");
      }

      const presetPath = await getBundledPresetPath();
      const done = await encoder.exportSequence(subsequence, exportType, outputFile.nativePath, presetPath);
      if (!done) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "exportSequence() reported failure.");
      }
      return outputFile;
    } catch (err) {
      throw wrap(CATEGORY.EXPORT_FAILED, err, "Export failed");
    } finally {
      if (project && subsequence) {
        if (typeof project.closeSequence === "function") {
          try {
            await project.closeSequence(subsequence);
          } catch (e) {
            // Non-fatal.
          }
        }
        try {
          // A resolved promise here doesn't guarantee real deletion (HANDOFF.md:
          // exportSequence's own boolean taught us that lesson) -- check the
          // actual return value, but still don't fail the export over it. A
          // leftover temp subsequence is a cosmetic project-panel issue.
          const deleted = await project.deleteSequence(subsequence);
          if (deleted === false) {
            console.warn(`Auphonic: temporary subsequence "${subsequence.name}" may not have been deleted.`);
          }
        } catch (e) {
          // Non-fatal.
        }
      }
      restoreSeqInOut();
    }
  }

  /*
   * Disables every clip on the subsequence's audio tracks (the seed content
   * copied in when it was created from a narrowed range around the
   * original clip -- see the module comment above for why this must not be
   * allowed to leak into the render) and returns the furthest tick any item
   * on the subsequence currently reaches, so the caller can place a scratch
   * item well clear of everything else.
   */
  async function neutralizeSeedContentAndFindBuffer(project, subsequence) {
    let maxEndTicks = 0;
    const audioTrackCount = await subsequence.getAudioTrackCount();
    for (let i = 0; i < audioTrackCount; i++) {
      const track = await subsequence.getAudioTrack(i);
      const items = (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) || [];
      for (const item of items) {
        const end = ticks.ticksNumberOf(await item.getEndTime());
        if (end > maxEndTicks) maxEndTicks = end;
        try {
          project.lockedAccess(() => {
            project.executeTransaction((compoundAction) => {
              compoundAction.addAction(item.createSetDisabledAction(true));
            }, "Disable copied seed content in scratch subsequence");
          });
        } catch (e) {
          // Non-fatal -- worst case this seed item stays enabled; narrowing
          // the subsequence's own in/out to the scratch item's span later is
          // a second, independent line of defense against contamination.
        }
      }
    }
    return maxEndTicks;
  }

  /*
   * Tries to widen one side of scratchItem's source trim by extraTicks; on
   * failure (Premiere rejects the new in/out -- e.g. it would exceed the
   * clip's real source media, which handles.js's own clamp couldn't fully
   * verify for the right side), halves the amount and retries rather than
   * throwing. Live evidence this is needed: an untrimmed clip reached this
   * step with a left handle that should have been 0 and crashed with
   * "Invalid parameter" trying to set a negative in-point -- this backoff
   * means a clamp being wrong or unavailable degrades the handle amount
   * instead of failing the whole job. Returns the amount actually achieved.
   */
  async function widenSideWithBackoff(project, label, requestedExtraTicks, buildAction) {
    let extra = requestedExtraTicks;
    while (extra > 0) {
      let ok = false;
      try {
        project.lockedAccess(() => {
          ok = project.executeTransaction((compoundAction) => {
            compoundAction.addAction(buildAction(extra));
          }, label);
        });
      } catch (e) {
        ok = false;
      }
      if (ok) return extra;
      extra = Math.floor(extra / 2);
    }
    return 0;
  }

  /*
   * Exports [originalInPoint - leftTicks, originalOutPoint + rightTicks] of
   * trackItem's own source media -- real widened audio, not just a wider
   * slice of the timeline -- to outputFile. Never touches trackItem itself;
   * all widening happens on a disposable scratch copy. leftTicks/rightTicks
   * are already clamped (handles.js's computeHandlePlan) and may be 0.
   * Returns { outputFile, achievedLeftTicks, achievedRightTicks } -- the
   * actual amounts achieved, which may be less than requested if the
   * backoff above kicked in.
   */
  async function exportHandleWidenedRange({ project, sequence, trackItem, projectItem, leftTicks, rightTicks, outputFile }) {
    const encoder = ppro.EncoderManager.getManager();
    if (!encoder.isAMEInstalled) {
      throw new AuphonicPluginError(CATEGORY.AME_UNAVAILABLE, "Adobe Media Encoder is not installed or not compatible.");
    }

    const originalStartTime = await trackItem.getStartTime();
    const originalEndTime = await trackItem.getEndTime();
    const originalSeqIn = await sequence.getInPoint();
    const originalSeqOut = await sequence.getOutPoint();
    let subsequence = null;
    let seqInOutRestored = false;

    const restoreSeqInOut = () => {
      if (seqInOutRestored) return;
      try {
        project.lockedAccess(() => {
          project.executeTransaction((compoundAction) => {
            compoundAction.addAction(sequence.createSetInPointAction(originalSeqIn));
            compoundAction.addAction(sequence.createSetOutPointAction(originalSeqOut));
          }, "Restore sequence in/out after handle export");
        });
        seqInOutRestored = true;
      } catch (e) {
        // Non-fatal -- see exportRangeToFile's identical note above.
      }
    };

    try {
      // Seed subsequence from the clip's own plain (unwidened) range -- the
      // exact narrow-then-createSubsequence step already proven by
      // exportRangeToFile. What gets copied in is neutralized below.
      let setOk = false;
      project.lockedAccess(() => {
        setOk = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(sequence.createSetInPointAction(originalStartTime));
          compoundAction.addAction(sequence.createSetOutPointAction(originalEndTime));
        }, "Narrow sequence in/out to seed handle scratch subsequence");
      });
      if (!setOk) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "Could not narrow the sequence in/out to seed the scratch subsequence.");
      }

      subsequence = await sequence.createSubsequence(true);
      if (!subsequence) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "createSubsequence() returned nothing.");
      }
      restoreSeqInOut();

      const bufferTicks = (await neutralizeSeedContentAndFindBuffer(project, subsequence)) + ticks.ticksNumberOf(ppro.TickTime.createWithSeconds(30));
      const bufferTime = ppro.TickTime.createWithTicks(String(Math.round(bufferTicks)));

      const scratchTrackIndex = await subsequence.getAudioTrackCount();
      const sequenceEditor = ppro.SequenceEditor.getEditor(subsequence);
      let insertOk = false;
      project.lockedAccess(() => {
        insertOk = project.executeTransaction((compoundAction) => {
          // Plain ProjectItem, not the ClipProjectItem cast -- confirmed live
          // that passing the cast wrapper here throws "Invalid parameter"
          // (same class of type-strictness Phase 1 hit with encodeFile/
          // importFiles). insertion.js's own working insert call uses a
          // plain ProjectItem too.
          compoundAction.addAction(sequenceEditor.createInsertProjectItemAction(projectItem, bufferTime, 0, scratchTrackIndex, true));
        }, "Insert scratch clip for handle widening");
      });
      if (!insertOk) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "Could not insert the scratch clip needed to render handles.");
      }

      const scratchTrack = await subsequence.getAudioTrack(scratchTrackIndex);
      const scratchItems = (await scratchTrack.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) || [];
      const scratchItem = scratchItems[0];
      if (!scratchItem) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "Scratch clip was inserted but could not be located afterward.");
      }

      const originalInPointTicks = ticks.ticksNumberOf(await trackItem.getInPoint());
      const originalOutPointTicks = ticks.ticksNumberOf(await trackItem.getOutPoint());

      // Each side widens independently with its own backoff -- a rejected
      // in-point (e.g. handles.js's clamp was still too generous, or the
      // media-boundary lookup it depends on for the right side wasn't
      // available) reduces that side's handle rather than failing the job.
      const achievedLeftTicks = await widenSideWithBackoff(project, "Widen scratch clip in-point to handle range", leftTicks, (extra) =>
        scratchItem.createSetInPointAction(ppro.TickTime.createWithTicks(String(Math.round(originalInPointTicks - extra))))
      );
      const achievedRightTicks = await widenSideWithBackoff(project, "Widen scratch clip out-point to handle range", rightTicks, (extra) =>
        scratchItem.createSetOutPointAction(ppro.TickTime.createWithTicks(String(Math.round(originalOutPointTicks + extra))))
      );

      const scratchStart = await scratchItem.getStartTime();
      const scratchEnd = await scratchItem.getEndTime();

      let narrowOk = false;
      project.lockedAccess(() => {
        narrowOk = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(subsequence.createSetInPointAction(scratchStart));
          compoundAction.addAction(subsequence.createSetOutPointAction(scratchEnd));
        }, "Narrow scratch subsequence to widened handle range");
      });
      if (!narrowOk) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "Could not narrow the scratch subsequence to the widened handle range.");
      }

      if (typeof project.setActiveSequence === "function") {
        try {
          await project.setActiveSequence(sequence);
        } catch (e) {
          // Non-fatal.
        }
      }

      const exportType = ppro.Constants && ppro.Constants.ExportType && ppro.Constants.ExportType.IMMEDIATELY;
      if (exportType === undefined) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "ppro.Constants.ExportType.IMMEDIATELY is not available on this build.");
      }

      const presetPath = await getBundledPresetPath();
      const done = await encoder.exportSequence(subsequence, exportType, outputFile.nativePath, presetPath);
      if (!done) {
        throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "exportSequence() reported failure.");
      }
      return { outputFile, achievedLeftTicks, achievedRightTicks };
    } catch (err) {
      throw wrap(CATEGORY.EXPORT_FAILED, err, "Handle-widened export failed");
    } finally {
      if (project && subsequence) {
        if (typeof project.closeSequence === "function") {
          try {
            await project.closeSequence(subsequence);
          } catch (e) {
            // Non-fatal.
          }
        }
        try {
          const deleted = await project.deleteSequence(subsequence);
          if (deleted === false) {
            console.warn(`Auphonic: temporary handle scratch subsequence "${subsequence.name}" may not have been deleted.`);
          }
        } catch (e) {
          // Non-fatal.
        }
      }
      restoreSeqInOut();
    }
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.exportModule = {
    exportRangeToFile,
    exportHandleWidenedRange,
    getBundledPresetPath,
    BUNDLED_PRESET_RELATIVE_PATH,
  };
})();
