/*
 * Per-job record (PRD 9.3). Phase 1 maps one clip to one production, but the
 * consolidation fields are included from day one on the PRD's explicit
 * warning: retrofitting them later means rewriting the queue, state files,
 * polling, and retry logic. They do nothing in Phase 1.
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on window.Auphonic.paths and
 * window.Auphonic.errors, which must be loaded first (see index.html's
 * script order). Published on window.Auphonic.jobModel.
 */
(function () {
  const paths = window.Auphonic.paths;
  const { CATEGORY } = window.Auphonic.errors;

  function makeJobId(originalClipName) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "T").slice(0, 19);
    const safeName = String(originalClipName || "clip").replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${stamp}_${safeName}`;
  }

  /*
   * fields: originalClipName, sequenceGuid, sourceProjectItemPath,
   *         timelineStartTicks, timelineEndTicks, presetUuid, handlesSeconds,
   *         originalSelectionType, linkedAudioResolved (Phase 2), extraFormats,
   *         labelColor (Phase 3) -- each has a sensible default so earlier
   *         call sites that don't pass them still work.
   */
  function createJob(fields) {
    const jobId = makeJobId(fields.originalClipName);
    return {
      jobId,
      productionId: null,
      consolidationOffsetMs: 0,
      consolidationDurationMs: null,
      sourceType: "timeline",
      originalClipName: fields.originalClipName,
      sequenceGuid: fields.sequenceGuid,
      sourceProjectItemPath: fields.sourceProjectItemPath,
      timelineStartTicks: fields.timelineStartTicks,
      timelineEndTicks: fields.timelineEndTicks,
      handlesSeconds: fields.handlesSeconds || 0,
      handlesActualLeftSeconds: 0,
      handlesActualRightSeconds: 0,
      handlesClampWarnings: [],
      originalSelectionType: fields.originalSelectionType || "audio",
      linkedAudioResolved: Boolean(fields.linkedAudioResolved),
      collisionDetected: false,
      collisionDecision: null,
      sourceMode: "clean-source",
      presetUuid: fields.presetUuid,
      outputFormat: "wav",
      extraFormats: fields.extraFormats || [],
      labelColor: fields.labelColor || "none",
      inputCachePath: null,
      outputCachePath: null,
      extraOutputCachePaths: {},
      status: "created",
      errorCategory: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  async function saveJob(project, job) {
    job.updatedAt = new Date().toISOString();
    const folder = await paths.getJobFolder(project, job.jobId);
    await paths.writeJson(folder, "job.json", job);
    return job;
  }

  async function loadJob(project, jobId) {
    const folder = await paths.getJobFolder(project, jobId);
    return paths.readJson(folder, "job.json");
  }

  function markStatus(job, status) {
    job.status = status;
    job.errorCategory = null;
    job.errorMessage = null;
    return job;
  }

  function markFailed(job, category, message) {
    job.status = "failed";
    job.errorCategory = category;
    job.errorMessage = message;
    return job;
  }

  /* Phase 2: pre-flight collision decline, or any other pre-upload cancel --
   * distinct from markFailed since nothing actually went wrong, the user
   * just chose not to proceed. No credits are ever spent before this point. */
  function markCanceled(job, reason) {
    job.status = "canceled";
    job.errorCategory = CATEGORY.CANCELED;
    job.errorMessage = reason;
    return job;
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.jobModel = { createJob, saveJob, loadJob, markStatus, markFailed, markCanceled, makeJobId };
})();
