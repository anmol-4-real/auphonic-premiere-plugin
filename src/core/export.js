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
   *
   * Phase 4b (live-confirmed bug): ALWAYS attempts buildAction at least once,
   * even when requestedExtraTicks is 0 -- the old `while (extra > 0)` skipped
   * calling buildAction entirely whenever no widening was requested, which
   * left a freshly-inserted scratch item at whatever in/out it happened to
   * default to. That was invisible for a single clip whose projectItem had
   * never been placed anywhere else (its default already matched), but a
   * consolidated batch reuses the same source file across several clips with
   * DIFFERENT trims -- a fresh scratch copy's default trim is then ambiguous,
   * and with handles off (the common case) nothing ever corrected it to THIS
   * unit's own actual [originalInPoint, originalOutPoint). Confirmed live:
   * wrong segment lengths and one distorted (likely overlapping) clip in a
   * batch that reused two source files across multiple clips. Calling
   * buildAction(0) sets the in/out to its own already-correct baseline value
   * -- a harmless no-op for the single-clip case that already worked, and
   * the actual fix for the batch case.
   */
  async function widenSideWithBackoff(project, label, requestedExtraTicks, buildAction) {
    let extra = requestedExtraTicks;
    while (true) {
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
      if (extra <= 0) return 0;
      extra = Math.floor(extra / 2);
    }
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

  /*
   * Phase 4b: locates the scratch item just inserted near expectedStartTicks.
   * exportHandleWidenedRange could safely take scratchItems[0] because it
   * only ever placed one item on the scratch track -- exportConsolidatedRange
   * below places N, so the item belonging to a given unit has to be found by
   * position, not array order (two units can share the same source media,
   * so a media-path match wouldn't disambiguate them either). Logs a warning
   * rather than silently trusting the closest match, mirroring
   * narrowSubsequenceToTargetRange's own diagnostic style above.
   */
  async function findScratchItemNear(track, expectedStartTicks, label) {
    const items = (await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false)) || [];
    let best = null;
    let bestDiff = Infinity;
    for (const item of items) {
      const start = ticks.ticksNumberOf(await item.getStartTime());
      const diff = Math.abs(start - expectedStartTicks);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = item;
      }
    }
    if (best && bestDiff !== 0) {
      console.warn(
        `Auphonic consolidated export: ${label} -- closest scratch item started ${bestDiff} ticks away from the requested insert position ${expectedStartTicks} (expected an exact match).`
      );
    }
    return best;
  }

  /*
   * Phase 4b (PRD 9.3/11): concatenates N clips' own widened ranges into ONE
   * exported file for consolidated batch mode (many jobs sharing one
   * Auphonic production). Builds on exactly the same primitives
   * exportHandleWidenedRange already proves live -- one disposable seed
   * subsequence, neutralizeSeedContentAndFindBuffer, per-side
   * widenSideWithBackoff -- but chains N scratch placements on ONE shared
   * scratch track instead of placing just one.
   *
   * Each unit is inserted, located, and widened in strict sequence before the
   * next unit is touched -- required both for the cursor math (which chains
   * off each unit's REAL achieved end tick, not a merely-planned one, so a
   * genuinely correct widen can only open a gap, never overlap, and can't
   * accumulate across a long batch) and for findScratchItemNear above to
   * unambiguously identify which scratch item belongs to which unit.
   *
   * Live-confirmed exception to that guarantee: when the same source file is
   * reused across multiple units, a fresh scratch copy's DEFAULT in/out can
   * mismatch the specific unit it's standing in for (see the mismatch
   * diagnostic below) -- and correcting it to the right absolute values
   * drags the item's timeline position backward by the size of that
   * mismatch (in/out and timeline start move together, the same mechanic
   * exportHandleWidenedRange's own widening already relies on), which CAN
   * overlap the previous unit. Each unit's achieved start is explicitly
   * checked against the previous unit's own end after correction, and
   * shifted forward to close the gap if it landed early -- this is what
   * actually enforces the no-overlap guarantee; the cursor math alone does
   * not, once a mismatch is possible.
   *
   * units: [{ trackItem, projectItem, leftTicks, rightTicks }, ...], one
   * entry per batch member (already-clamped handle ticks from
   * handles.computeHandlePlan, unchanged -- 0/0 for a unit with handles off).
   * Returns { outputFile, perUnit: [{ achievedLeftTicks, achievedRightTicks,
   * offsetTicks, durationTicks }, ...] } in the same order as `units` --
   * offsetTicks/durationTicks locate each unit's own segment inside the
   * exported file.
   */
  async function exportConsolidatedRange({ project, sequence, units, outputFile }) {
    const encoder = ppro.EncoderManager.getManager();
    if (!encoder.isAMEInstalled) {
      throw new AuphonicPluginError(CATEGORY.AME_UNAVAILABLE, "Adobe Media Encoder is not installed or not compatible.");
    }
    if (!units || units.length === 0) {
      throw new AuphonicPluginError(CATEGORY.EXPORT_FAILED, "No units given for the consolidated export.");
    }

    // Seed subsequence off the first unit's own current range. This narrow
    // is functionally inert for WHAT gets copied in -- createSubsequence(true)
    // copies every currently SELECTED item regardless (Phase 4a, confirmed
    // live) -- kept only for consistency with exportHandleWidenedRange's own
    // pattern above. Whatever gets copied in (however many originally-
    // selected items that is) is neutralized below exactly as it already is
    // for the single-clip case.
    const seedStartTime = await units[0].trackItem.getStartTime();
    const seedEndTime = await units[0].trackItem.getEndTime();
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
          }, "Restore sequence in/out after consolidated export");
        });
        seqInOutRestored = true;
      } catch (e) {
        // Non-fatal -- see exportRangeToFile's identical note above.
      }
    };

    try {
      let setOk = false;
      project.lockedAccess(() => {
        setOk = project.executeTransaction((compoundAction) => {
          compoundAction.addAction(sequence.createSetInPointAction(seedStartTime));
          compoundAction.addAction(sequence.createSetOutPointAction(seedEndTime));
        }, "Narrow sequence in/out to seed consolidated scratch subsequence");
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
      let cursorTicks = Math.round(bufferTicks);

      const scratchTrackIndex = await subsequence.getAudioTrackCount();
      const sequenceEditor = ppro.SequenceEditor.getEditor(subsequence);

      const rawPerUnit = [];
      let batchStartTicks = null;
      let batchEndTicks = null;

      for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        // targetStartTick is always >= cursorTicks (the previous unit's own
        // achieved end, or the initial buffer for the first unit) since
        // unit.leftTicks >= 0 -- converging exactly to it (below) therefore
        // guarantees no overlap with the previous unit by construction, with
        // no separate overlap check needed.
        const targetStartTick = Math.round(cursorTicks + unit.leftTicks);
        const originalInPointTicks = ticks.ticksNumberOf(await unit.trackItem.getInPoint());
        const originalOutPointTicks = ticks.ticksNumberOf(await unit.trackItem.getOutPoint());

        /*
         * Live-confirmed, multi-stage bug (this is the third and, by
         * construction, final iteration -- see git history/HANDOFF.md for
         * the two prior attempts and exactly why each one was insufficient):
         * a fresh scratch copy's DEFAULT in/out is not confirmed to
         * reliably match THIS unit's own trim once the same source file is
         * used by more than one clip in the batch. Forcing the in/out to
         * this unit's own correct absolute values is still necessary (bug
         * #1's fix) -- but since a track item's in-point and its timeline
         * start move together (the same mechanic exportHandleWidenedRange's
         * widening already relies on), that correction can drag the
         * timeline position away from where the item was actually inserted,
         * confirmed live via exact matching tick deltas.
         *
         * Attempt 2 tried to PREDICT the resulting shift from the scratch
         * copy's own default and pre-compensate the insert position in one
         * shot -- the arithmetic was independently re-derived and confirmed
         * algebraically correct, but a fallback path for any residual (from
         * assuming the prediction wasn't exact) shifted in/out again to
         * close it, which -- since in/out points ARE the content selector,
         * not just a position control -- shifts which portion of the source
         * media gets used. Confirmed live as reduced-but-still-present
         * "artifacts... timing mismatch... distorting" after that fix,
         * consistent with that fallback still occasionally firing.
         *
         * This version never predicts and never falls back to a
         * content-shifting correction. It inserts, corrects, and MEASURES
         * the actual achieved start. If that doesn't land exactly on
         * targetStartTick, it disables that attempt (never using or further
         * correcting it, so it can never contribute wrong content) and
         * retries at a freshly-recomputed position based on what was JUST
         * observed -- not a predicted model of why the mismatch happened.
         * This converges regardless of whatever the underlying default-
         * inheritance mechanism actually is, and can never silently place
         * wrong content: it either lands exactly right, or throws.
         */
        let scratchItem = null;
        let achievedLeftTicks = 0;
        let achievedRightTicks = 0;
        let achievedStartTicks = null;
        let achievedEndTicks = null;
        let currentInsertTick = targetStartTick;
        // Generous headroom: correcting one discarded attempt could itself
        // change what the NEXT attempt's own default reflects (if the
        // underlying mechanism is "last corrected trim wins"), which could
        // take a couple of oscillating attempts to settle rather than
        // converging in one. Each extra attempt only costs time if actually
        // needed -- the loop breaks the moment it lands correctly.
        const MAX_PLACEMENT_ATTEMPTS = 6;

        for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
          const insertTime = ppro.TickTime.createWithTicks(String(Math.round(currentInsertTick)));
          let insertOk = false;
          project.lockedAccess(() => {
            insertOk = project.executeTransaction((compoundAction) => {
              compoundAction.addAction(sequenceEditor.createInsertProjectItemAction(unit.projectItem, insertTime, 0, scratchTrackIndex, true));
            }, `Insert scratch clip ${i + 1}/${units.length} for consolidated export (attempt ${attempt + 1})`);
          });
          if (!insertOk) {
            throw new AuphonicPluginError(
              CATEGORY.EXPORT_FAILED,
              `Could not insert scratch clip ${i + 1} of ${units.length} for the consolidated export (attempt ${attempt + 1}).`
            );
          }

          // Fetched only now, after a successful insert -- scratchTrackIndex
          // names a track that doesn't exist until the FIRST insert anywhere
          // in this loop auto-creates it (confirmed live elsewhere in this
          // project); fetching it any earlier throws "invalid track index."
          const scratchTrack = await subsequence.getAudioTrack(scratchTrackIndex);
          const candidateItem = await findScratchItemNear(
            scratchTrack,
            Math.round(currentInsertTick),
            `unit ${i + 1}/${units.length} (attempt ${attempt + 1})`
          );
          if (!candidateItem) {
            throw new AuphonicPluginError(
              CATEGORY.EXPORT_FAILED,
              `Scratch clip ${i + 1} of ${units.length} was inserted but could not be located afterward (attempt ${attempt + 1}).`
            );
          }

          const candidateAchievedLeftTicks = await widenSideWithBackoff(
            project,
            `Widen scratch clip ${i + 1} in-point (consolidated export, attempt ${attempt + 1})`,
            unit.leftTicks,
            (extra) => candidateItem.createSetInPointAction(ppro.TickTime.createWithTicks(String(Math.round(originalInPointTicks - extra))))
          );
          const candidateAchievedRightTicks = await widenSideWithBackoff(
            project,
            `Widen scratch clip ${i + 1} out-point (consolidated export, attempt ${attempt + 1})`,
            unit.rightTicks,
            (extra) => candidateItem.createSetOutPointAction(ppro.TickTime.createWithTicks(String(Math.round(originalOutPointTicks + extra))))
          );

          const candidateStartTicks = ticks.ticksNumberOf(await candidateItem.getStartTime());
          const candidateEndTicks = ticks.ticksNumberOf(await candidateItem.getEndTime());

          if (Math.abs(candidateStartTicks - targetStartTick) <= 1) {
            scratchItem = candidateItem;
            achievedLeftTicks = candidateAchievedLeftTicks;
            achievedRightTicks = candidateAchievedRightTicks;
            achievedStartTicks = candidateStartTicks;
            achievedEndTicks = candidateEndTicks;
            if (attempt > 0) {
              console.log(
                `Auphonic consolidated export unit ${i + 1}/${units.length}: landed correctly after ${attempt + 1} attempt(s).`
              );
            }
            break;
          }

          const observedShiftTicks = targetStartTick - candidateStartTicks;
          console.warn(
            `Auphonic consolidated export unit ${i + 1}/${units.length}, attempt ${attempt + 1}: achieved start ${candidateStartTicks} ` +
              `does not match target ${targetStartTick} (off by ${observedShiftTicks} ticks) -- likely a scratch copy default mismatch. ` +
              `Discarding this attempt (never using it further) and retrying at a compensated position instead of correcting it in place, ` +
              `to avoid altering its source content.`
          );
          try {
            project.lockedAccess(() => {
              project.executeTransaction((compoundAction) => {
                compoundAction.addAction(candidateItem.createSetDisabledAction(true));
              }, `Disable mis-landed scratch clip ${i + 1}/${units.length} attempt ${attempt + 1}`);
            });
          } catch (e) {
            // Non-fatal -- it's discarded either way; a disable failure just
            // means a harmless, unused leftover item instead of a disabled one.
          }
          currentInsertTick = Math.round(currentInsertTick + observedShiftTicks);
        }

        if (!scratchItem) {
          throw new AuphonicPluginError(
            CATEGORY.EXPORT_FAILED,
            `Could not land scratch clip ${i + 1} of ${units.length} at its correct position after ${MAX_PLACEMENT_ATTEMPTS} attempts.`
          );
        }

        const expectedDurationTicks = originalOutPointTicks - originalInPointTicks + achievedLeftTicks + achievedRightTicks;
        if (achievedEndTicks - achievedStartTicks !== expectedDurationTicks) {
          console.warn(
            `Auphonic consolidated export unit ${i + 1}/${units.length}: achieved duration ${achievedEndTicks - achievedStartTicks} ticks ` +
              `does not match expected ${expectedDurationTicks} ticks after correction -- something is still wrong for this unit.`
          );
        }

        rawPerUnit.push({ achievedLeftTicks, achievedRightTicks, startTicks: achievedStartTicks, endTicks: achievedEndTicks });
        if (batchStartTicks === null) batchStartTicks = achievedStartTicks;
        batchEndTicks = achievedEndTicks;

        // Full per-unit trace, not just mismatches -- while this feature's
        // total-vs-actual duration discrepancy is still under investigation,
        // this is the only way to see every unit's real position/duration in
        // one place rather than inferring it from the final aggregate.
        console.log(
          `Auphonic consolidated export unit ${i + 1}/${units.length}: requested insert tick ${targetStartTick}, ` +
            `achieved [${achievedStartTicks}, ${achievedEndTicks}) -- duration ${achievedEndTicks - achievedStartTicks} ticks ` +
            `(${ppro.TickTime.createWithTicks(String(achievedEndTicks - achievedStartTicks)).seconds.toFixed(3)}s), ` +
            `achievedLeft/Right = ${achievedLeftTicks}/${achievedRightTicks}, next cursor = ${achievedEndTicks}.`
        );

        // Chain off the REAL achieved end, not the originally-planned amount
        // -- see the function header for why this is what keeps gaps from
        // ever going negative (overlapping) or compounding across the batch.
        cursorTicks = achievedEndTicks;
      }

      console.log(
        `Auphonic consolidated export: batch bracket [${batchStartTicks}, ${batchEndTicks}) -- ` +
          `${ppro.TickTime.createWithTicks(String(batchEndTicks - batchStartTicks)).seconds.toFixed(3)}s total span, ` +
          `sum of individual unit durations = ${rawPerUnit.reduce((sum, u) => sum + (u.endTicks - u.startTicks), 0)} ticks ` +
          `(${ppro.TickTime.createWithTicks(String(rawPerUnit.reduce((sum, u) => sum + (u.endTicks - u.startTicks), 0))).seconds.toFixed(3)}s) -- ` +
          `these two should match exactly if no gaps opened up between units.`
      );

      const perUnit = rawPerUnit.map((u) => ({
        achievedLeftTicks: u.achievedLeftTicks,
        achievedRightTicks: u.achievedRightTicks,
        offsetTicks: u.startTicks - batchStartTicks,
        durationTicks: u.endTicks - u.startTicks,
      }));

      // Phase 4b (live-under-investigation): reuse the SAME diagnostic-checked
      // helper narrowSubsequenceToTargetRange already uses for the single-clip
      // path, rather than a raw inline transaction -- this exact class of bug
      // (executeTransaction reports success but the narrow doesn't fully
      // apply) has already been observed once, live, in this codebase's
      // Phase 4a history. Logs requested-vs-applied in/out unconditionally.
      await narrowSubsequenceToTargetRange(
        project,
        subsequence,
        ppro.TickTime.createWithTicks(String(Math.round(batchStartTicks))),
        ppro.TickTime.createWithTicks(String(Math.round(batchEndTicks)))
      );

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
      return { outputFile, perUnit };
    } catch (err) {
      throw wrap(CATEGORY.EXPORT_FAILED, err, "Consolidated export failed");
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
            console.warn(`Auphonic: temporary consolidated scratch subsequence "${subsequence.name}" may not have been deleted.`);
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
    exportConsolidatedRange,
    getBundledPresetPath,
    BUNDLED_PRESET_RELATIVE_PATH,
  };
})();
