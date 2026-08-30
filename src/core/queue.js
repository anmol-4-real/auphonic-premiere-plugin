/*
 * Phase 4a (PRD 11): multi-clip queue engine. Owns the in-memory list of
 * queued jobs and the per-job pipeline -- promoted out of panel.js's old
 * single-job runJob() (Phase 1-3) so panel.js goes back to being UI wiring
 * only, matching every other module's own stated convention ("core logic
 * lives in ../core/*; panel.js just calls it in order").
 *
 * Each entry is { job, live, cancelRequested }. `job` is the plain,
 * JSON-persistable record from jobModel.js. `live` holds the Premiere object
 * references and per-run settings the pipeline needs that AREN'T already
 * persisted on `job` itself (project/sequence/trackItem/projectItem,
 * trackIndex, startTime/endTime, the preset's display name, the handles
 * plan's tick-level detail, forceNewTrackBelow) -- these never survive a
 * restart, so entries loaded back from disk via loadHistory() get
 * `live: null` and are display-only (see the Phase 4a plan for why no
 * auto-resume is attempted: there's no reliable way to reacquire "the same
 * clip" after a restart, and guessing wrong risks a redundantly-billed
 * production).
 *
 * processJob() runs the exact same steps on first run and on retry --
 * correctness against double-billing comes from two idempotency guards baked
 * into the steps themselves (job.productionId, job.productionStarted), not
 * from tracking which step a previous attempt reached. Retry is always
 * simply "revalidate the original clip against the still-live trackItem
 * reference, then redo the pipeline from the top."
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on window.Auphonic.{errors, ticks,
 * jobModel, auphonicClient, selection, exportModule, insertion, organization,
 * paths, cache}, which must all be loaded first (see index.html's script
 * order). Published on window.Auphonic.queue.
 */
(function () {
  const ppro = require("premierepro");
  const { CATEGORY, AuphonicPluginError } = window.Auphonic.errors;
  const ticks = window.Auphonic.ticks;
  const jobModel = window.Auphonic.jobModel;
  const auphonicClient = window.Auphonic.auphonicClient;
  const selectionModule = window.Auphonic.selection;
  const exportModule = window.Auphonic.exportModule;
  const insertion = window.Auphonic.insertion;
  const organization = window.Auphonic.organization;
  const paths = window.Auphonic.paths;
  const cache = window.Auphonic.cache;

  // Matches auphonicClient.js's own FORMAT_SPECS -- Auphonic echoes AAC back
  // with a "m4a" container extension, confirmed live in Phase 3.
  const EXT_FOR_FORMAT = { wav: "wav", mp3: "mp3", aac: "m4a" };

  // Cancel is only offered before any credits are at risk -- once a job
  // reaches "uploading" it's no longer in this list, in both the UI (panel.js
  // gates the Cancel button on this) and here (the in-flight checkpoints
  // below never check cancelRequested past "creating_production").
  const CANCELABLE_STATUSES = ["queued", "validating", "exporting", "creating_production"];

  const entries = [];
  let isRunning = false;

  function ticksStringOf(tickTime) {
    return String(ticks.ticksNumberOf(tickTime));
  }

  function getEntries() {
    return entries;
  }

  function findEntryByJobId(jobId) {
    return entries.find((e) => e.job.jobId === jobId) || null;
  }

  function findOutputFileMeta(detail, format) {
    const files = detail.output_files || [];
    return files.find((f) => f.format === format) || files.find((f) => f.ending === EXT_FOR_FORMAT[format]) || null;
  }

  /* ---------------------------------------------------------------- enqueue */

  /*
   * unitBundles: one entry per eligible unit from checkSelection, each the
   * same shape as Phase 1-3's single pendingJob object (a spread of
   * selection.classifyAndValidate's result plus preset/handlesPlan/
   * forceNewTrackBelow/extraFormats/labelColor). Creates and persists a
   * jobModel record for each, then queues it in memory for runQueue to pick
   * up. Does not itself start running the queue -- the caller decides that.
   */
  async function enqueue(project, unitBundles) {
    const newEntries = [];
    for (const bundle of unitBundles) {
      const job = jobModel.createJob({
        originalClipName: bundle.clipName,
        sequenceGuid: bundle.sequence.guid || bundle.sequence.name || "unknown-sequence",
        sourceProjectItemPath: bundle.mediaPath,
        timelineStartTicks: ticksStringOf(bundle.startTime),
        timelineEndTicks: ticksStringOf(bundle.endTime),
        presetUuid: bundle.preset.uuid,
        handlesSeconds:
          bundle.handlesPlan.leftSeconds > 0 || bundle.handlesPlan.rightSeconds > 0
            ? Math.max(bundle.handlesPlan.leftSeconds, bundle.handlesPlan.rightSeconds)
            : 0,
        originalSelectionType: bundle.originalSelectionType,
        linkedAudioResolved: bundle.linkedAudioResolved,
        extraFormats: bundle.extraFormats,
        labelColor: bundle.labelColor,
      });
      job.collisionDetected = Boolean(bundle.forceNewTrackBelow);
      job.collisionDecision = bundle.forceNewTrackBelow ? "created_new_track" : null;
      await jobModel.saveJob(project, job);

      const entry = {
        job,
        live: {
          project: bundle.project,
          sequence: bundle.sequence,
          trackItem: bundle.trackItem,
          projectItem: bundle.projectItem,
          trackIndex: bundle.trackIndex,
          startTime: bundle.startTime,
          endTime: bundle.endTime,
          presetName: bundle.preset.name,
          handlesPlan: bundle.handlesPlan,
          forceNewTrackBelow: Boolean(bundle.forceNewTrackBelow),
        },
        cancelRequested: false,
      };
      entries.push(entry);
      newEntries.push(entry);
    }
    return newEntries;
  }

  /*
   * Records a job that was identified (clip/preset/etc. already known) but
   * will never run -- e.g. the user declined a pre-flight collision prompt
   * before any credits were at risk. Preserves the same durable-record
   * precedent Phase 1/2 established for that exact case, generalized to any
   * unit in a multi-clip check. Shown in the table as a plain Canceled row;
   * live is null since there's nothing left to do with it.
   */
  async function recordDeclinedJob(project, bundle, reason) {
    const job = jobModel.createJob({
      originalClipName: bundle.clipName,
      sequenceGuid: bundle.sequence.guid || bundle.sequence.name || "unknown-sequence",
      sourceProjectItemPath: bundle.mediaPath,
      timelineStartTicks: ticksStringOf(bundle.startTime),
      timelineEndTicks: ticksStringOf(bundle.endTime),
      presetUuid: bundle.preset ? bundle.preset.uuid : undefined,
      originalSelectionType: bundle.originalSelectionType,
      linkedAudioResolved: bundle.linkedAudioResolved,
      extraFormats: bundle.extraFormats,
      labelColor: bundle.labelColor,
    });
    job.collisionDetected = true;
    job.collisionDecision = "canceled";
    jobModel.markCanceled(job, reason);
    try {
      await jobModel.saveJob(project, job);
    } catch (e) {
      // Non-fatal -- the cancellation itself is what matters here.
    }
    const entry = { job, live: null, cancelRequested: false };
    entries.push(entry);
    return entry;
  }

  /* --------------------------------------------------------------- history */

  /*
   * Reads back every past job for this project (this session or a previous
   * one) via cache.js's existing listJobRecords, so the queue table shows
   * real history across a restart -- with live: null, since nothing about a
   * restart-recovered row can safely resume automatically (see module header
   * and the Phase 4a plan's §5).
   */
  async function loadHistory(project) {
    const records = await cache.listJobRecords(project);
    records.sort((a, b) => (a.job.createdAt || "").localeCompare(b.job.createdAt || ""));
    for (const { job } of records) {
      if (findEntryByJobId(job.jobId)) continue;
      entries.push({ job, live: null, cancelRequested: false });
    }
    return entries;
  }

  /* -------------------------------------------------------------- pipeline */

  /*
   * Runs one job through the full pipeline: validate -> export -> create
   * production -> upload -> start -> poll -> download -> place -> extra
   * formats. Called identically on first run and on retry -- see the module
   * header for why that's safe. `hooks` lets the UI observe progress without
   * this module knowing anything about the DOM: optional
   * { onStatus(entry), onLog(entry, message, cls) }.
   */
  async function processJob(entry, apiKey, hooks = {}) {
    const { job, live } = entry;
    const onStatus = hooks.onStatus || (() => {});
    const onLog = hooks.onLog || (() => {});
    const setStatus = async (status) => {
      jobModel.markStatus(job, status);
      await jobModel.saveJob(live.project, job);
      onStatus(entry);
    };

    try {
      await setStatus("validating");
      const revalidation = await selectionModule.classifyAndValidate(live.sequence, live.trackItem);
      if (!revalidation.eligible) {
        throw new AuphonicPluginError(
          CATEGORY.UNSUPPORTED_CLIP,
          `No longer eligible: ${revalidation.reason || "the clip changed since it was queued."}`
        );
      }
      if (entry.cancelRequested) {
        throw new AuphonicPluginError(CATEGORY.CANCELED, "Canceled by user.");
      }
      if (job.linkedAudioResolved) {
        onLog(entry, `Video clip selected -- using linked audio "${job.originalClipName}".`, "dim");
      }

      await setStatus("exporting");
      const jobFolder = await paths.getJobFolder(live.project, job.jobId);
      const inputFile = await paths.reserveFile(jobFolder, "input.wav");
      let placementStartTime = live.startTime;
      if (live.handlesPlan.leftTicks > 0 || live.handlesPlan.rightTicks > 0) {
        const handleResult = await exportModule.exportHandleWidenedRange({
          project: live.project,
          sequence: live.sequence,
          trackItem: live.trackItem,
          projectItem: live.projectItem,
          leftTicks: live.handlesPlan.leftTicks,
          rightTicks: live.handlesPlan.rightTicks,
          outputFile: inputFile,
        });
        const achievedLeftSeconds = ppro.TickTime.createWithTicks(String(handleResult.achievedLeftTicks)).seconds;
        const achievedRightSeconds = ppro.TickTime.createWithTicks(String(handleResult.achievedRightTicks)).seconds;
        job.handlesActualLeftSeconds = achievedLeftSeconds;
        job.handlesActualRightSeconds = achievedRightSeconds;
        job.handlesClampWarnings = live.handlesPlan.clampWarnings;
        onLog(entry, `Handles: -${achievedLeftSeconds.toFixed(1)}s / +${achievedRightSeconds.toFixed(1)}s`, "dim");

        const originalStartTicks = ticks.ticksNumberOf(live.startTime);
        placementStartTime = ppro.TickTime.createWithTicks(
          String(Math.round(originalStartTicks - handleResult.achievedLeftTicks))
        );
      } else {
        await exportModule.exportRangeToFile(live.project, live.sequence, live.startTime, live.endTime, inputFile);
      }
      job.inputCachePath = inputFile.nativePath;
      onLog(entry, `Exported: ${inputFile.nativePath}`, "ok");

      // Last cancellation checkpoint -- past this point credits are at risk,
      // and Cancel is no longer offered (see CANCELABLE_STATUSES above).
      if (entry.cancelRequested) {
        throw new AuphonicPluginError(CATEGORY.CANCELED, "Canceled by user.");
      }

      await setStatus("creating_production");
      if (job.productionId) {
        onLog(entry, `Reusing existing production: ${job.productionId}`, "dim");
      } else {
        const outputBasename = `${job.originalClipName}_Auphonic_${live.presetName}`.replace(/[\/:*?"<>|]/g, "_");
        job.productionId = await auphonicClient.createProduction(apiKey, {
          presetUuid: job.presetUuid,
          title: `${job.originalClipName} - Auphonic`,
          outputBasename,
          extraFormats: job.extraFormats,
        });
        await jobModel.saveJob(live.project, job);
        onLog(entry, `Production created: ${job.productionId}`, "ok");
      }

      await setStatus("uploading");
      const inputBytes = await paths.readBinary(inputFile);
      await auphonicClient.uploadInputFile(apiKey, job.productionId, inputBytes, "input.wav", (loaded, total) => {
        onLog(entry, `Uploading... ${Math.round((loaded / total) * 100)}%`, "dim");
      });
      onLog(entry, "Upload complete.", "ok");

      await setStatus("processing");
      if (!job.productionStarted) {
        await auphonicClient.startProduction(apiKey, job.productionId);
        job.productionStarted = true;
        await jobModel.saveJob(live.project, job);
      } else {
        onLog(entry, "Production already started -- resuming poll.", "dim");
      }
      await auphonicClient.pollUntilDone(apiKey, job.productionId, {
        onPoll: (statusData) => {
          onLog(entry, `  status: ${statusData.status_string || statusData.status}`, "dim");
        },
      });
      onLog(entry, "Auphonic processing done.", "ok");

      await setStatus("downloading");
      const detail = await auphonicClient.getProductionDetail(apiKey, job.productionId);
      const wavMeta = findOutputFileMeta(detail, "wav");
      if (!wavMeta) {
        throw new AuphonicPluginError(CATEGORY.DOWNLOAD_FAILED, "Auphonic reported no WAV output file.");
      }
      const wavBytes = await auphonicClient.downloadOutputFile(apiKey, wavMeta.download_url);
      const outputFile = await paths.writeBinary(jobFolder, "output.wav", wavBytes);
      job.outputCachePath = outputFile.nativePath;
      onLog(entry, `Downloaded: ${outputFile.nativePath}`, "ok");

      await setStatus("placing");
      const placement = await insertion.importAndPlace({
        project: live.project,
        sequence: live.sequence,
        originalTrackItem: live.trackItem,
        originalTrackIndex: live.trackIndex,
        startTime: placementStartTime,
        outputFilePath: outputFile.nativePath,
        originalClipName: job.originalClipName,
        presetName: live.presetName,
        forceNewTrackBelow: live.forceNewTrackBelow,
        binName: organization.DEFAULT_BIN_NAME,
        colorLabel: job.labelColor,
      });

      await setStatus("inserted");
      onLog(
        entry,
        `Placed as "${placement.newName}" on audio track ${placement.targetTrackIndex + 1}` +
          (placement.createdNewTrack ? " (new track created)" : ""),
        "ok"
      );
      if (!placement.disableOk) {
        onLog(
          entry,
          `Warning: could not disable the original clip's audio automatically (${placement.disableError || "unknown reason"}). Disable it by hand.`,
          "warn"
        );
      } else {
        onLog(entry, "Original audio disabled (clip kept, not deleted).", "ok");
      }
      placement.organizationWarnings.forEach((w) => onLog(entry, `Warning: ${w}`, "warn"));

      // Extra formats (Phase 3): non-fatal, bin-only, never placed on the
      // timeline. A problem here must never undo the WAV placement above.
      for (const format of job.extraFormats) {
        const meta = findOutputFileMeta(detail, format);
        if (!meta) {
          onLog(entry, `Warning: Auphonic reported no ${format.toUpperCase()} output file -- skipping.`, "warn");
          continue;
        }
        try {
          const bytes = await auphonicClient.downloadOutputFile(apiKey, meta.download_url);
          const ext = EXT_FOR_FORMAT[format];
          const extraFile = await paths.writeBinary(jobFolder, `output.${ext}`, bytes);
          const extra = await insertion.importExtraOutputFile({
            project: live.project,
            filePath: extraFile.nativePath,
            originalClipName: job.originalClipName,
            presetName: live.presetName,
            ext,
            binName: organization.DEFAULT_BIN_NAME,
            colorLabel: job.labelColor,
          });
          job.extraOutputCachePaths[format] = extraFile.nativePath;
          onLog(entry, `Imported "${extra.newName}" into the "${organization.DEFAULT_BIN_NAME}" bin.`, "ok");
          extra.organizationWarnings.forEach((w) => onLog(entry, `Warning: ${w}`, "warn"));
        } catch (err) {
          onLog(entry, `Warning: could not import the ${format.toUpperCase()} file (${err.message || err}).`, "warn");
        }
      }
      if (job.extraFormats.length > 0) {
        await jobModel.saveJob(live.project, job);
      }
    } catch (err) {
      const category = err instanceof AuphonicPluginError ? err.category : CATEGORY.PROCESSING_FAILED;
      const message = err instanceof AuphonicPluginError ? err.message : String(err.message || err);
      if (category === CATEGORY.CANCELED) {
        jobModel.markCanceled(job, message);
      } else {
        jobModel.markFailed(job, category, message);
      }
      try {
        await jobModel.saveJob(live.project, job);
      } catch (e) {
        // Non-fatal -- surfacing the original error to the user matters more.
      }
      onStatus(entry);
      onLog(entry, `${category}: ${message}`, "bad");
    }
  }

  /* --------------------------------------------------------------- running */

  /*
   * Sequential drain: repeatedly finds the next runnable ("queued", still
   * live) entry and awaits it fully before looking again. Re-scanning by
   * status on every iteration (rather than a single fixed-order pass) is
   * what lets both newly-enqueued entries AND a just-retried entry (status
   * reset back to "queued" while this loop is already running, possibly at
   * an array position the loop already passed) get picked up correctly.
   * isRunning guards against two overlapping drains -- calling this again
   * while already running is a safe no-op, since the active loop will see
   * the same newly-queued/retried entries on its own next scan.
   */
  async function runQueue(project, apiKey, hooks = {}) {
    if (isRunning) return;
    isRunning = true;
    try {
      while (true) {
        const next = entries.find((e) => e.live && e.job.status === "queued");
        if (!next) break;
        await processJob(next, apiKey, hooks);
      }
    } finally {
      isRunning = false;
    }
  }

  /*
   * Only ever called for entries with `live` still set (this session) --
   * never attempts to reconstruct a live trackItem after a restart. Resets
   * status to "queued" (processJob's own "validating" step re-checks
   * eligibility against the still-live trackItem before doing any real
   * work) and lets runQueue's scan pick it up.
   */
  async function retryJob(entry, apiKey, hooks = {}) {
    if (!entry.live) return;
    jobModel.markStatus(entry.job, "queued");
    entry.cancelRequested = false;
    await jobModel.saveJob(entry.live.project, entry.job);
    if (hooks.onStatus) hooks.onStatus(entry);
    if (!isRunning) {
      await runQueue(entry.live.project, apiKey, hooks);
    }
  }

  /*
   * Cooperative: if the entry hasn't started yet (still in a cancelable
   * status), marks it canceled immediately, with no credits spent. If it's
   * mid-run, sets cancelRequested for processJob's own checkpoints to catch
   * on their next check -- there is no checkpoint after "creating_production"
   * finishes, matching the "cancel only before upload" requirement exactly.
   */
  async function cancelJob(entry) {
    entry.cancelRequested = true;
    if (entry.live && CANCELABLE_STATUSES.includes(entry.job.status)) {
      jobModel.markCanceled(entry.job, "Canceled before upload; no credits were spent.");
      await jobModel.saveJob(entry.live.project, entry.job);
    }
  }

  /*
   * For restart-recovered rows only (live === null) -- never resumes or
   * retries anything, just marks the record canceled so it stops showing as
   * an active/actionable row. See the Phase 4a plan's §5 for why no
   * automatic relink is attempted.
   */
  async function dismissHistoryEntry(project, entry) {
    if (entry.live) return;
    jobModel.markCanceled(entry.job, "Dismissed after restart.");
    try {
      await jobModel.saveJob(project, entry.job);
    } catch (e) {
      // Non-fatal -- the UI can still stop treating it as active either way.
    }
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.queue = {
    CANCELABLE_STATUSES,
    getEntries,
    findEntryByJobId,
    enqueue,
    recordDeclinedJob,
    loadHistory,
    runQueue,
    retryJob,
    cancelJob,
    dismissHistoryEntry,
  };
})();
