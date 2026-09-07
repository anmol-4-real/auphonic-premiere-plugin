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

  // Phase 4a (PRD 11): presentation-only display strings for the queue
  // table. Internal status values (used for state-machine logic elsewhere)
  // are unchanged -- this map exists so the UI can show the PRD's exact
  // wording without renaming any working status string.
  const STATUS_LABELS = {
    queued: "Queued",
    validating: "Validating",
    exporting: "Exporting temp audio",
    creating_production: "Creating production",
    uploading: "Uploading",
    processing: "Processing on Auphonic",
    downloading: "Downloading",
    placing: "Importing",
    inserted: "Inserted",
    failed: "Failed",
    canceled: "Canceled",
  };

  // Phase 4a: enqueue() creates several jobs back-to-back, well under one
  // second apart, so the old second-precision timestamp alone could collide
  // for same-named clips (confirmed live: it did, for 4 same-named clips
  // queued together -- they all got the same jobId, and since jobId keys the
  // on-disk folder, they overwrote each other's input.wav/output.wav/job.json
  // as they ran). A per-session counter guarantees uniqueness regardless of
  // clock precision; the timestamp stays only for human-readable sorting.
  let jobSequenceCounter = 0;

  function makeJobId(originalClipName) {
    jobSequenceCounter += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeName = String(originalClipName || "clip").replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${stamp}_${String(jobSequenceCounter).padStart(4, "0")}_${safeName}`;
  }

  // Phase 4b: batch membership must be known client-side before any
  // production exists (the concatenation export needs to know which units
  // belong together before createProduction is ever called), so this can't
  // just be productionId. Same per-session counter approach as makeJobId,
  // in its own sequence so batch ids and job ids never collide.
  let batchSequenceCounter = 0;

  function makeBatchId() {
    batchSequenceCounter += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `batch_${stamp}_${String(batchSequenceCounter).padStart(4, "0")}`;
  }

  /*
   * fields: originalClipName, sequenceGuid, sourceProjectItemPath,
   *         timelineStartTicks, timelineEndTicks, presetUuid,
   *         originalSelectionType, linkedAudioResolved (Phase 2), extraFormats,
   *         labelColor (Phase 3), batchId (Phase 4b) -- each has a sensible
   *         default so earlier
   *         call sites that don't pass them still work.
   */
  function createJob(fields) {
    const jobId = makeJobId(fields.originalClipName);
    return {
      jobId,
      batchId: fields.batchId || null,
      productionId: null,
      // Phase 4a: set to true only immediately after startProduction()
      // resolves successfully, and persisted right away (see
      // src/core/queue.js). This is what makes retry safe against
      // double-billing -- it's a fact we recorded ourselves, not a guess
      // inferred from an Auphonic status code.
      productionStarted: false,
      consolidationOffsetMs: 0,
      consolidationDurationMs: null,
      sourceType: "timeline",
      originalClipName: fields.originalClipName,
      sequenceGuid: fields.sequenceGuid,
      sourceProjectItemPath: fields.sourceProjectItemPath,
      timelineStartTicks: fields.timelineStartTicks,
      timelineEndTicks: fields.timelineEndTicks,
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
      status: "queued",
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
  window.Auphonic.jobModel = {
    createJob,
    saveJob,
    loadJob,
    markStatus,
    markFailed,
    markCanceled,
    makeJobId,
    makeBatchId,
    STATUS_LABELS,
  };
})();
