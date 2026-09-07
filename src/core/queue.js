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
 * trackIndex, startTime/endTime, the preset's display name,
 * forceNewTrackBelow) -- these never survive a
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
 * Phase 4b (PRD 9.3/11): processBatch() handles a batch of jobs sharing one
 * batchId -- several jobs' audio concatenated into one shared production,
 * each job's own segment placed back separately using its own offset/
 * duration into the shared downloaded file. See that function's own header
 * for the full shape; the module-level idioms above (idempotent steps,
 * revalidate-then-redo-from-the-top retries) still hold, just broadcast to
 * every batch member instead of one job.
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on window.Auphonic.{errors, ticks,
 * jobModel, auphonicClient, selection, exportModule, insertion, organization,
 * paths, cache, wav}, which must all be loaded first (see index.html's
 * script order). Published on window.Auphonic.queue.
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
  const wav = window.Auphonic.wav;

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
   * selection.classifyAndValidate's result plus preset/forceNewTrackBelow/
   * extraFormats/labelColor). Creates and persists a
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
   * Phase 4b: same as enqueue() above, but every bundle shares one batchId
   * -- this is what tells runQueue's scan (and processBatch, retryJob,
   * cancelJob below) that these jobs belong to one consolidated production
   * rather than N independent ones. Batch membership has to be decided here,
   * client-side, before any production exists.
   */
  async function enqueueConsolidated(project, unitBundles) {
    const batchId = jobModel.makeBatchId();
    const newEntries = [];
    for (const bundle of unitBundles) {
      const job = jobModel.createJob({
        originalClipName: bundle.clipName,
        sequenceGuid: bundle.sequence.guid || bundle.sequence.name || "unknown-sequence",
        sourceProjectItemPath: bundle.mediaPath,
        timelineStartTicks: ticksStringOf(bundle.startTime),
        timelineEndTicks: ticksStringOf(bundle.endTime),
        presetUuid: bundle.preset.uuid,
        originalSelectionType: bundle.originalSelectionType,
        linkedAudioResolved: bundle.linkedAudioResolved,
        extraFormats: bundle.extraFormats,
        labelColor: bundle.labelColor,
        batchId,
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
      await exportModule.exportRangeToFile(live.project, live.sequence, live.startTime, live.endTime, inputFile);
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
        startTime: live.startTime,
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

  /* ------------------------------------------------------- batch pipeline */

  async function broadcastStatus(batchEntries, status, hooks) {
    const onStatus = hooks.onStatus || (() => {});
    for (const entry of batchEntries) {
      jobModel.markStatus(entry.job, status);
      await jobModel.saveJob(entry.live.project, entry.job);
      onStatus(entry);
    }
  }

  function broadcastLog(batchEntries, hooks, message, cls) {
    const onLog = hooks.onLog || (() => {});
    batchEntries.forEach((entry) => onLog(entry, message, cls));
  }

  async function markAllFailed(batchEntries, category, message, hooks) {
    const onStatus = hooks.onStatus || (() => {});
    for (const entry of batchEntries) {
      jobModel.markFailed(entry.job, category, message);
      try {
        await jobModel.saveJob(entry.live.project, entry.job);
      } catch (e) {
        // Non-fatal -- surfacing the original error matters more.
      }
      onStatus(entry);
    }
    broadcastLog(batchEntries, hooks, `${category}: ${message}`, "bad");
  }

  /*
   * Phase 4b (PRD 9.3/11): runs the shared prefix (export/create-production/
   * upload/start/poll/download) once for a whole batch sharing one
   * batchId, then places each member's own segment independently. Status
   * and failures are broadcast to every batch member together during the
   * shared prefix -- both so every row visibly progresses together, and so
   * every affected row ends up in a retriable "failed" state (retryJob's
   * own batch-cascade below depends on this).
   *
   * `batchEntries` is whatever runQueue's scan gathered as currently
   * "queued" for this batchId -- a fresh batch's full membership, or (after
   * a retry) just the one or few members still needing work.
   */
  async function processBatch(batchEntries, apiKey, hooks = {}) {
    const onLog = hooks.onLog || (() => {});
    const onStatus = hooks.onStatus || (() => {});

    // Revalidate every member against its own still-live trackItem -- same
    // check processJob does for a solo job. A member that's no longer
    // eligible is dropped from the batch (marked failed on its own, with its
    // own reason) rather than failing the whole batch over it.
    await broadcastStatus(batchEntries, "validating", hooks);
    const validEntries = [];
    for (const entry of batchEntries) {
      const revalidation = await selectionModule.classifyAndValidate(entry.live.sequence, entry.live.trackItem);
      if (!revalidation.eligible) {
        jobModel.markFailed(
          entry.job,
          CATEGORY.UNSUPPORTED_CLIP,
          `No longer eligible: ${revalidation.reason || "the clip changed since it was queued."}`
        );
        try {
          await jobModel.saveJob(entry.live.project, entry.job);
        } catch (e) {
          // Non-fatal.
        }
        onStatus(entry);
        onLog(entry, `${CATEGORY.UNSUPPORTED_CLIP}: dropped from its batch -- ${revalidation.reason || "no longer eligible."}`, "bad");
        continue;
      }
      validEntries.push(entry);
    }

    if (validEntries.length === 0) return;

    const project = validEntries[0].live.project;
    const sequence = validEntries[0].live.sequence;
    const sharedPrefixDone = validEntries.some((e) => e.job.outputCachePath);

    // Only delegate to the solo pipeline when there's exactly one member
    // left AND the shared work never happened for it. A single entry whose
    // shared work already succeeded (only its own placement failed, and
    // it's being retried alone) must skip straight to the placement loop
    // below, reusing the already-uploaded/processed/downloaded shared file
    // -- processJob would otherwise re-export and re-upload just this one
    // clip's own audio into the batch's already-completed production.
    if (validEntries.length === 1 && !sharedPrefixDone) {
      await processJob(validEntries[0], apiKey, hooks);
      return;
    }

    if (!sharedPrefixDone) {
      try {
        await broadcastStatus(validEntries, "exporting", hooks);
        const batchHomeFolder = await paths.getJobFolder(project, validEntries[0].job.jobId);
        const inputFile = await paths.reserveFile(batchHomeFolder, "input.wav");

        const exportResult = await exportModule.exportConsolidatedRange({
          project,
          sequence,
          // leftTicks/rightTicks are always 0 now that handles have been
          // removed -- exportConsolidatedRange still needs these fields
          // (widenSideWithBackoff's baseline-reassert-at-zero is what
          // corrects a reused source file's mismatched scratch-copy
          // default, unrelated to handles), so they stay explicit rather
          // than becoming optional.
          units: validEntries.map((e) => ({
            trackItem: e.live.trackItem,
            projectItem: e.live.projectItem,
            leftTicks: 0,
            rightTicks: 0,
          })),
          outputFile: inputFile,
        });

        let totalDurationSeconds = 0;
        for (let i = 0; i < validEntries.length; i++) {
          const entry = validEntries[i];
          const perUnit = exportResult.perUnit[i];

          const offsetSeconds = ppro.TickTime.createWithTicks(String(Math.round(perUnit.offsetTicks))).seconds;
          const durationSeconds = ppro.TickTime.createWithTicks(String(Math.round(perUnit.durationTicks))).seconds;
          entry.job.consolidationOffsetMs = Math.round(offsetSeconds * 1000);
          entry.job.consolidationDurationMs = Math.round(durationSeconds * 1000);
          entry.job.inputCachePath = inputFile.nativePath;
          totalDurationSeconds += durationSeconds;
          await jobModel.saveJob(project, entry.job);
        }
        broadcastLog(
          validEntries,
          hooks,
          `Exported as one consolidated file (${validEntries.length} clips, one shared production): ${inputFile.nativePath}`,
          "ok"
        );

        // Diagnostic (while the total-vs-actual duration discrepancy is
        // under investigation): measure the LOCAL exported file's own real
        // duration, before a single byte gets uploaded. If this already
        // disagrees with totalDurationSeconds, the bug is in export.js's
        // own render/bracket step; if it matches but Auphonic's reported
        // input length doesn't, the bug is somewhere in the upload path
        // instead.
        try {
          const localExportedSeconds = wav.wavDurationSeconds(await paths.readBinary(inputFile));
          console.log(
            `Auphonic consolidated export: local exported file is ${localExportedSeconds.toFixed(3)}s, ` +
              `computed total from per-unit durations is ${totalDurationSeconds.toFixed(3)}s` +
              (Math.abs(localExportedSeconds - totalDurationSeconds) > 0.5 ? " -- MISMATCH already at export time." : " -- matches.")
          );
        } catch (e) {
          console.warn(`Auphonic consolidated export: could not measure the local exported file for diagnostic purposes (${e.message || e}).`);
        }

        await broadcastStatus(validEntries, "creating_production", hooks);
        const presetName = validEntries[0].live.presetName;
        const outputBasename = `Batch_${validEntries.length}clips_${presetName}`.replace(/[\/:*?"<>|]/g, "_");
        // Reuse a productionId any member already carries (e.g. one that
        // briefly ran solo -- see processBatch's own single-member fallback
        // above -- before rejoining this group on a later retry) rather
        // than unconditionally creating a new one and orphaning it -- same
        // "if (job.productionId) reuse else create" idiom processJob
        // already relies on, generalized to the whole group.
        const entryWithProduction = validEntries.find((e) => e.job.productionId);
        let productionId = entryWithProduction ? entryWithProduction.job.productionId : null;
        if (productionId) {
          broadcastLog(validEntries, hooks, `Reusing existing production: ${productionId}`, "dim");
        } else {
          productionId = await auphonicClient.createProduction(apiKey, {
            presetUuid: validEntries[0].job.presetUuid,
            title: `Auphonic batch (${validEntries.length} clips)`,
            outputBasename,
            extraFormats: validEntries[0].job.extraFormats,
          });
          broadcastLog(validEntries, hooks, `Production created: ${productionId}`, "ok");
        }
        for (const entry of validEntries) {
          entry.job.productionId = productionId;
          await jobModel.saveJob(project, entry.job);
        }

        await broadcastStatus(validEntries, "uploading", hooks);
        const inputBytes = await paths.readBinary(inputFile);
        // Scaled timeout (§2's reasoning) -- a consolidated file has no size
        // cap, unlike the fixed 120s default sized for one clip.
        const scaledTimeoutMs = Math.max(120000, Math.round(totalDurationSeconds * 2000) + 60000);
        await auphonicClient.uploadInputFile(
          apiKey,
          productionId,
          inputBytes,
          "input.wav",
          (loaded, total) => broadcastLog(validEntries, hooks, `Uploading batch... ${Math.round((loaded / total) * 100)}%`, "dim"),
          scaledTimeoutMs
        );
        broadcastLog(validEntries, hooks, "Upload complete.", "ok");

        await broadcastStatus(validEntries, "processing", hooks);
        // Checked/propagated across the whole group, not just one entry --
        // a member that reused an existing productionId (see above) may
        // already have this set to true while a newly-joined sibling
        // doesn't yet.
        if (!validEntries.some((e) => e.job.productionStarted)) {
          await auphonicClient.startProduction(apiKey, productionId);
        } else {
          broadcastLog(validEntries, hooks, "Production already started -- resuming poll.", "dim");
        }
        for (const entry of validEntries) {
          if (!entry.job.productionStarted) {
            entry.job.productionStarted = true;
            await jobModel.saveJob(project, entry.job);
          }
        }
        await auphonicClient.pollUntilDone(apiKey, productionId, {
          onPoll: (statusData) =>
            broadcastLog(validEntries, hooks, `  status: ${statusData.status_string || statusData.status}`, "dim"),
        });
        broadcastLog(validEntries, hooks, "Auphonic processing done.", "ok");

        await broadcastStatus(validEntries, "downloading", hooks);
        const detail = await auphonicClient.getProductionDetail(apiKey, productionId);
        const wavMeta = findOutputFileMeta(detail, "wav");
        if (!wavMeta) {
          throw new AuphonicPluginError(CATEGORY.DOWNLOAD_FAILED, "Auphonic reported no WAV output file.");
        }
        const wavBytes = await auphonicClient.downloadOutputFile(apiKey, wavMeta.download_url, scaledTimeoutMs);

        // Safeguard (HANDOFF.md "Key risk"): some Auphonic presets
        // (silence/gap removal) shift audio in time. If the processed
        // file's real duration doesn't match what every unit's own
        // offset/duration says it should be, placing segments against it
        // would silently misplace audio -- fail the whole batch loudly
        // instead of trusting stale (pre-processing) offsets.
        const actualSeconds = wav.wavDurationSeconds(wavBytes);
        const tolerance = Math.max(1, totalDurationSeconds * 0.01);
        if (Math.abs(actualSeconds - totalDurationSeconds) > tolerance) {
          await markAllFailed(
            validEntries,
            CATEGORY.PROCESSING_FAILED,
            `Auphonic's processing changed the audio's timing (likely a silence/gap-removal setting in your preset) -- ` +
              `expected about ${totalDurationSeconds.toFixed(1)}s, got ${actualSeconds.toFixed(1)}s. Segments can't be placed ` +
              `safely in Consolidated mode. Try again with "Consolidate into one production" turned off, or pick a preset ` +
              `without automatic silence/gap removal.`,
            hooks
          );
          return;
        }

        // Slice each unit's own segment out of the one shared downloaded
        // file into its own small, standalone WAV (see wav.js's header for
        // why this -- not importing the shared file once and trimming N
        // different track-item in/out points against it -- is the safe
        // approach). Every job's own "output.wav" ends up a completely
        // normal, independent file, exactly matching the existing per-job
        // convention -- no changes needed to cache.js's cleanup, and no
        // risk of one job's cleanup ever affecting another's already-placed
        // clip, since nothing is shared at the Premiere-import level.
        for (const entry of validEntries) {
          const offsetSeconds = entry.job.consolidationOffsetMs / 1000;
          const durationSeconds = entry.job.consolidationDurationMs / 1000;
          const sliced = wav.sliceWav(wavBytes, offsetSeconds, durationSeconds);
          const folder = await paths.getJobFolder(project, entry.job.jobId);
          const outputFile = await paths.writeBinary(folder, "output.wav", sliced);
          entry.job.outputCachePath = outputFile.nativePath;
          await jobModel.saveJob(project, entry.job);
        }
        broadcastLog(validEntries, hooks, `Downloaded and split into ${validEntries.length} clips' own cleaned segments.`, "ok");

        const extraFormats = validEntries[0].job.extraFormats || [];
        for (const format of extraFormats) {
          const meta = findOutputFileMeta(detail, format);
          if (!meta) {
            broadcastLog(validEntries, hooks, `Warning: Auphonic reported no ${format.toUpperCase()} output file -- skipping.`, "warn");
            continue;
          }
          try {
            const bytes = await auphonicClient.downloadOutputFile(apiKey, meta.download_url, scaledTimeoutMs);
            const ext = EXT_FOR_FORMAT[format];
            for (const entry of validEntries) {
              const folder = await paths.getJobFolder(project, entry.job.jobId);
              const extraFile = await paths.writeBinary(folder, `output.${ext}`, bytes);
              entry.job.extraOutputCachePaths[format] = extraFile.nativePath;
              await jobModel.saveJob(project, entry.job);
            }
            const extra = await insertion.importConsolidatedFile({
              project,
              filePath: validEntries[0].job.extraOutputCachePaths[format],
              presetName,
              unitCount: validEntries.length,
              ext,
              binName: organization.DEFAULT_BIN_NAME,
              colorLabel: validEntries[0].job.labelColor,
            });
            broadcastLog(validEntries, hooks, `Imported "${extra.newName}" into the "${organization.DEFAULT_BIN_NAME}" bin.`, "ok");
            extra.organizationWarnings.forEach((w) => broadcastLog(validEntries, hooks, `Warning: ${w}`, "warn"));
          } catch (err) {
            broadcastLog(validEntries, hooks, `Warning: could not import the ${format.toUpperCase()} file (${err.message || err}).`, "warn");
          }
        }
      } catch (err) {
        const category = err instanceof AuphonicPluginError ? err.category : CATEGORY.PROCESSING_FAILED;
        const message = err instanceof AuphonicPluginError ? err.message : String(err.message || err);
        await markAllFailed(validEntries, category, message, hooks);
        return;
      }
    }

    // Per-job placement loop -- runs for every member still not terminal,
    // whether the shared prefix just ran above or was already done from a
    // prior attempt (a lone retried entry whose own placement failed). Each
    // job's own sliced "output.wav" (written above) is a completely normal,
    // independent file at this point, so placement is IDENTICAL to a solo
    // job's -- same insertion.importAndPlace call processJob itself uses.
    for (const entry of validEntries) {
      if (["inserted", "failed", "canceled"].includes(entry.job.status)) continue; // defensive idempotency guard

      const setStatus = async (status) => {
        jobModel.markStatus(entry.job, status);
        await jobModel.saveJob(project, entry.job);
        onStatus(entry);
      };

      try {
        await setStatus("placing");

        // In a batch, this checkpoint is reached both for a pre-start cancel
        // and a mid/post-start one, and it always means the same thing here
        // -- skip THIS job's placement only. The shared production was
        // already paid for either way (see cancelJob below).
        if (entry.cancelRequested) {
          jobModel.markCanceled(entry.job, "Canceled -- placement skipped. Credits for the shared production were already spent.");
          await jobModel.saveJob(project, entry.job);
          onStatus(entry);
          continue;
        }

        const placement = await insertion.importAndPlace({
          project,
          sequence: entry.live.sequence,
          originalTrackItem: entry.live.trackItem,
          originalTrackIndex: entry.live.trackIndex,
          startTime: entry.live.startTime,
          outputFilePath: entry.job.outputCachePath,
          originalClipName: entry.job.originalClipName,
          presetName: entry.live.presetName,
          forceNewTrackBelow: entry.live.forceNewTrackBelow,
          binName: organization.DEFAULT_BIN_NAME,
          colorLabel: entry.job.labelColor,
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
      } catch (err) {
        const category = err instanceof AuphonicPluginError ? err.category : CATEGORY.PROCESSING_FAILED;
        const message = err instanceof AuphonicPluginError ? err.message : String(err.message || err);
        jobModel.markFailed(entry.job, category, message);
        try {
          await jobModel.saveJob(project, entry.job);
        } catch (e) {
          // Non-fatal.
        }
        onStatus(entry);
        onLog(entry, `${category}: ${message}`, "bad");
        // One segment's placement failure must never block the others.
      }
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
        if (next.job.batchId) {
          // Gathering every currently-"queued" sibling here is also where a
          // batch's working membership gets locked in for this run -- see
          // cancelJob/retryJob below for what that means for a mid-batch
          // cancel/retry.
          const siblings = entries.filter((e) => e.live && e.job.batchId === next.job.batchId && e.job.status === "queued");
          await processBatch(siblings, apiKey, hooks);
        } else {
          await processJob(next, apiKey, hooks);
        }
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
    const onStatus = hooks.onStatus || (() => {});

    // Phase 4b: a batch member whose shared work never completed shares one
    // unfinished production with its siblings -- retrying it must retry all
    // of them together, not just the one clicked (their status was
    // broadcast together on failure by processBatch, so every one of them
    // should already show as "failed" here). A member whose shared work DID
    // complete (only its own placement failed) is retried alone -- the next
    // processBatch call will find just it "queued" and, seeing its
    // outputCachePath already set, skip straight to placement.
    if (entry.job.batchId && !entry.job.outputCachePath) {
      const siblings = entries.filter(
        (e) => e.live && e.job.batchId === entry.job.batchId && e.job.status === "failed"
      );
      for (const sibling of siblings) {
        jobModel.markStatus(sibling.job, "queued");
        sibling.cancelRequested = false;
        await jobModel.saveJob(sibling.live.project, sibling.job);
        onStatus(sibling);
      }
    } else {
      jobModel.markStatus(entry.job, "queued");
      entry.cancelRequested = false;
      await jobModel.saveJob(entry.live.project, entry.job);
      onStatus(entry);
    }

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

    // Phase 4b: once ANY member of this batch has moved past "queued",
    // processBatch has already started (or finished) the shared
    // export/upload/production for the whole batch -- those credits are
    // spent regardless of this one member's cancel. Leave cancelRequested
    // set and let the placement-loop checkpoint in processBatch handle it
    // (with wording that says credits were still spent), rather than
    // claiming "no credits were spent" here, which would be false.
    if (entry.job.batchId) {
      const batchStarted = entries.some(
        (e) => e.live && e.job.batchId === entry.job.batchId && e.job.status !== "queued"
      );
      if (batchStarted) return;
    }

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
    enqueueConsolidated,
    recordDeclinedJob,
    loadHistory,
    runQueue,
    retryJob,
    cancelJob,
    dismissHistoryEntry,
  };
})();
