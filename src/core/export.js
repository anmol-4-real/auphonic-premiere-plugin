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
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on window.Auphonic.errors, which
 * must be loaded first. Published on window.Auphonic.exportModule.
 */
(function () {
  const ppro = require("premierepro");
  const uxp = require("uxp");
  const { CATEGORY, AuphonicPluginError, wrap } = window.Auphonic.errors;

  const BUNDLED_PRESET_RELATIVE_PATH = "assets/presets/Waveform Audio 48kHz 16-bit.epr";

  async function getBundledPresetPath() {
    const pluginFolder = await uxp.storage.localFileSystem.getPluginFolder();
    const assetsFolder = await pluginFolder.getEntry("assets");
    const presetsFolder = await assetsFolder.getEntry("presets");
    const presetFile = await presetsFolder.getEntry("Waveform Audio 48kHz 16-bit.epr");
    return presetFile.nativePath;
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

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.exportModule = { exportRangeToFile, getBundledPresetPath, BUNDLED_PRESET_RELATIVE_PATH };
})();
