/*
 * Panel wiring -- DOM handling and pipeline orchestration. Core logic lives
 * in ../core/*; this file just calls it in order and reflects progress/
 * errors to the user. Nothing here spends Auphonic credits without the user
 * clicking "Confirm & Process" after seeing the cost estimate (PRD principle #2).
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on every window.Auphonic.* module,
 * all of which must be loaded first (see index.html's script order).
 * Published on window.Auphonic.panel.
 */
(function () {
  const ppro = require("premierepro");
  const secureStorage = window.Auphonic.secureStorage;
  const auphonicClient = window.Auphonic.auphonicClient;
  const selection = window.Auphonic.selection;
  const costEstimate = window.Auphonic.costEstimate;
  const exportModule = window.Auphonic.exportModule;
  const insertion = window.Auphonic.insertion;
  const jobModel = window.Auphonic.jobModel;
  const cache = window.Auphonic.cache;
  const paths = window.Auphonic.paths;
  const { CATEGORY, AuphonicPluginError } = window.Auphonic.errors;

  const state = {
    apiKey: null,
    presets: [],
    pendingJob: null,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function setHtml(id, html) {
    el(id).innerHTML = html;
  }

  function show(id) {
    el(id).classList.remove("hidden");
  }

  function hide(id) {
    el(id).classList.add("hidden");
  }

  function appendLog(targetId, message, cls) {
    const container = el(targetId);
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = message;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }

  function clearLog(targetId) {
    el(targetId).textContent = "";
  }

  function describeError(err) {
    if (err instanceof AuphonicPluginError) {
      return `${err.category}: ${err.message}`;
    }
    return err && err.message ? err.message : String(err);
  }

  /* ------------------------------------------------------------ account/key */

  async function connectWithKey(apiKey, { persist }) {
    setHtml("keyStatus", '<span class="dim">Connecting...</span>');
    try {
      const user = await auphonicClient.getUser(apiKey);
      state.apiKey = apiKey;
      if (persist) await secureStorage.saveApiKey(apiKey);
      setHtml(
        "keyStatus",
        `<span class="ok">Connected as ${user.username}. Credits: ${user.credits} h</span>`
      );
      el("apiKeyInput").value = "";
      hide("apiKeyInput");
      hide("saveKeyBtn");
      show("changeKeyBtn");
      show("presetSection");
      show("processSection");
      show("cacheSection");
      await loadPresets();
      return true;
    } catch (err) {
      setHtml("keyStatus", `<span class="bad">${describeError(err)}</span>`);
      return false;
    }
  }

  function wireAccountSection() {
    el("saveKeyBtn").addEventListener("click", async () => {
      const apiKey = el("apiKeyInput").value.trim();
      if (!apiKey) {
        setHtml("keyStatus", '<span class="bad">Enter an API key first.</span>');
        return;
      }
      await connectWithKey(apiKey, { persist: true });
    });

    el("changeKeyBtn").addEventListener("click", () => {
      show("apiKeyInput");
      show("saveKeyBtn");
      hide("changeKeyBtn");
      el("apiKeyInput").value = "";
      setHtml("keyStatus", '<span class="dim">Paste a new key and click Save Key &amp; Connect.</span>');
    });
  }

  async function tryAutoConnect() {
    const savedKey = await secureStorage.loadApiKey();
    if (savedKey) {
      await connectWithKey(savedKey, { persist: false });
    }
  }

  /* --------------------------------------------------------------- presets */

  async function loadPresets() {
    setHtml("presetStatus", '<span class="dim">Loading presets...</span>');
    try {
      const presets = await auphonicClient.getPresets(state.apiKey);
      state.presets = presets;
      const select = el("presetSelect");
      select.innerHTML = "";
      presets.forEach((p) => {
        const option = document.createElement("option");
        option.value = p.uuid;
        option.textContent = p.preset_name;
        select.appendChild(option);
      });
      const settings = await cache.getSettings();
      if (settings.presetUuid && presets.some((p) => p.uuid === settings.presetUuid)) {
        select.value = settings.presetUuid;
      }
      setHtml("presetStatus", `<span class="ok">${presets.length} preset(s) loaded.</span>`);
      select.addEventListener("change", () => {
        cache.saveSettings({ presetUuid: select.value });
      });
    } catch (err) {
      setHtml("presetStatus", `<span class="bad">${describeError(err)}</span>`);
    }
  }

  function selectedPreset() {
    const select = el("presetSelect");
    const uuid = select.value;
    const preset = state.presets.find((p) => p.uuid === uuid);
    return preset ? { uuid: preset.uuid, name: preset.preset_name } : null;
  }

  /* ------------------------------------------------------------ selection */

  async function checkSelection() {
    hide("estimateBox");
    hide("progressBox");
    state.pendingJob = null;
    setHtml("selectionStatus", '<span class="dim">Checking...</span>');
    try {
      const result = await selection.resolveSelection();
      if (result.diagnostics && result.diagnostics.length > 0) {
        console.log("Auphonic eligibility diagnostics (checks this build couldn't run, or how media type was resolved):", result.diagnostics);
      }
      if (!result.eligible) {
        setHtml("selectionStatus", `<span class="bad">Skipped: ${result.clipName || "selected item"} - ${result.reason}</span>`);
        return;
      }

      const preset = selectedPreset();
      if (!preset) {
        setHtml("selectionStatus", '<span class="bad">Choose a preset first.</span>');
        return;
      }

      let credits = null;
      try {
        const user = await auphonicClient.getUser(state.apiKey);
        credits = user.credits;
      } catch (e) {
        // Non-fatal -- estimate can still show without a fresh credit check.
      }

      const est = costEstimate.estimate({ durationSeconds: result.durationSeconds, availableCreditsHours: credits });

      state.pendingJob = { ...result, preset, estimate: est };

      setHtml(
        "selectionStatus",
        `<span class="ok">Eligible: ${result.clipName} (${costEstimate.formatDuration(result.durationSeconds)})</span>`
      );

      setHtml(
        "estimateText",
        `Actual duration: ${costEstimate.formatDuration(est.durationSeconds)}<br/>` +
          `Estimated billable time: ${costEstimate.formatDuration(est.billableSeconds)}` +
          (credits !== null ? `<br/>Available credits: ${credits} h` : "")
      );
      const warningList = el("warningList");
      warningList.innerHTML = "";
      if (est.warnings.length > 0) {
        est.warnings.forEach((w) => {
          const li = document.createElement("li");
          li.textContent = w;
          warningList.appendChild(li);
        });
        show("warningList");
      } else {
        hide("warningList");
      }
      show("estimateBox");
    } catch (err) {
      setHtml("selectionStatus", `<span class="bad">${describeError(err)}</span>`);
    }
  }

  /* -------------------------------------------------------------- pipeline */

  async function runJob(pendingJob) {
    const { project, sequence, trackItem, mediaPath, trackIndex, startTime, endTime, clipName, preset } = pendingJob;
    clearLog("progressLog");
    show("progressBox");

    const setProgress = (text) => setHtml("progressStatus", `<span class="dim">${text}</span>`);
    const logStep = (text, cls) => appendLog("progressLog", text, cls);

    let job = jobModel.createJob({
      originalClipName: clipName,
      sequenceGuid: sequence.guid || sequence.name || "unknown-sequence",
      sourceProjectItemPath: mediaPath,
      timelineStartTicks: typeof startTime.ticksNumber === "number" ? String(startTime.ticksNumber) : String(startTime.seconds),
      timelineEndTicks: typeof endTime.ticksNumber === "number" ? String(endTime.ticksNumber) : String(endTime.seconds),
      presetUuid: preset.uuid,
    });

    try {
      await jobModel.saveJob(project, job);
      logStep(`Job created: ${job.jobId}`, "dim");

      setProgress("Exporting clip audio...");
      jobModel.markStatus(job, "exporting");
      await jobModel.saveJob(project, job);
      const jobFolder = await paths.getJobFolder(project, job.jobId);
      const inputFile = await paths.reserveFile(jobFolder, "input.wav");
      await exportModule.exportRangeToFile(project, sequence, startTime, endTime, inputFile);
      job.inputCachePath = inputFile.nativePath;
      logStep(`Exported: ${inputFile.nativePath}`, "ok");

      setProgress("Creating Auphonic production...");
      jobModel.markStatus(job, "creating_production");
      await jobModel.saveJob(project, job);
      const outputBasename = `${clipName}_Auphonic_${preset.name}`.replace(/[\/:*?"<>|]/g, "_");
      const productionUuid = await auphonicClient.createProduction(state.apiKey, {
        presetUuid: preset.uuid,
        title: `${clipName} - Auphonic`,
        outputBasename,
      });
      job.productionId = productionUuid;
      logStep(`Production created: ${productionUuid}`, "ok");

      setProgress("Uploading audio to Auphonic...");
      jobModel.markStatus(job, "uploading");
      await jobModel.saveJob(project, job);
      const inputBytes = await paths.readBinary(inputFile);
      await auphonicClient.uploadInputFile(state.apiKey, productionUuid, inputBytes, "input.wav", (loaded, total) => {
        setProgress(`Uploading... ${Math.round((loaded / total) * 100)}%`);
      });
      logStep("Upload complete.", "ok");

      setProgress("Starting processing...");
      jobModel.markStatus(job, "processing");
      await jobModel.saveJob(project, job);
      await auphonicClient.startProduction(state.apiKey, productionUuid);
      await auphonicClient.pollUntilDone(state.apiKey, productionUuid, {
        onPoll: (statusData) => {
          setProgress(`Processing on Auphonic... (${statusData.status_string || statusData.status})`);
          logStep(`  status: ${statusData.status_string || statusData.status}`, "dim");
        },
      });
      logStep("Auphonic processing done.", "ok");

      setProgress("Downloading cleaned audio...");
      jobModel.markStatus(job, "downloading");
      await jobModel.saveJob(project, job);
      const detail = await auphonicClient.getProductionDetail(state.apiKey, productionUuid);
      const outputFileMeta = (detail.output_files || []).find((f) => f.format === "wav") || (detail.output_files || [])[0];
      if (!outputFileMeta) {
        throw new AuphonicPluginError(CATEGORY.DOWNLOAD_FAILED, "Auphonic reported no output file.");
      }
      const downloadedBytes = await auphonicClient.downloadOutputFile(state.apiKey, outputFileMeta.download_url);
      const outputFile = await paths.writeBinary(jobFolder, "output.wav", downloadedBytes);
      job.outputCachePath = outputFile.nativePath;
      logStep(`Downloaded: ${outputFile.nativePath}`, "ok");

      setProgress("Placing cleaned audio on the timeline...");
      jobModel.markStatus(job, "placing");
      await jobModel.saveJob(project, job);
      const placement = await insertion.importAndPlace({
        project,
        sequence,
        originalTrackItem: trackItem,
        originalTrackIndex: trackIndex,
        startTime,
        outputFilePath: outputFile.nativePath,
        originalClipName: clipName,
        presetName: preset.name,
      });

      jobModel.markStatus(job, "inserted");
      await jobModel.saveJob(project, job);

      logStep(
        `Placed as "${placement.newName}" on audio track ${placement.targetTrackIndex + 1}` +
          (placement.createdNewTrack ? " (new track created)" : ""),
        "ok"
      );
      if (!placement.disableOk) {
        logStep(
          `Warning: could not disable the original clip's audio automatically (${placement.disableError || "unknown reason"}). Disable it by hand.`,
          "warn"
        );
      } else {
        logStep("Original audio disabled (clip kept, not deleted).", "ok");
      }
      setProgress("Done.");
      logStep("JOB COMPLETE.", "ok");
    } catch (err) {
      const category = err instanceof AuphonicPluginError ? err.category : CATEGORY.PROCESSING_FAILED;
      const message = err instanceof AuphonicPluginError ? err.message : String(err.message || err);
      jobModel.markFailed(job, category, message);
      try {
        await jobModel.saveJob(project, job);
      } catch (e) {
        // Non-fatal -- surfacing the original error to the user matters more.
      }
      setProgress("Failed.");
      logStep(`${category}: ${message}`, "bad");
    }
  }

  function wireProcessSection() {
    el("checkSelectionBtn").addEventListener("click", checkSelection);
    el("confirmBtn").addEventListener("click", async () => {
      if (!state.pendingJob) return;
      el("confirmBtn").disabled = true;
      await runJob(state.pendingJob);
      el("confirmBtn").disabled = false;
    });
  }

  /* ------------------------------------------------------------------ cache */

  function wireCacheSection() {
    el("revealCacheBtn").addEventListener("click", async () => {
      const result = await cache.revealCacheFolder();
      setHtml(
        "cacheStatus",
        result.opened
          ? '<span class="ok">Opened.</span>'
          : `<span class="dim">Cache folder: ${result.path}</span>`
      );
    });

    el("cleanFailedBtn").addEventListener("click", async () => {
      const project = await ppro.Project.getActiveProject();
      const count = await cache.cleanFailedTempExports(project);
      setHtml("cacheStatus", `<span class="ok">Removed temp files from ${count} failed job file(s).</span>`);
    });

    el("cleanCompletedBtn").addEventListener("click", async () => {
      const project = await ppro.Project.getActiveProject();
      const count = await cache.deleteCompletedInputTemps(project);
      setHtml("cacheStatus", `<span class="ok">Deleted ${count} completed job's input temp file(s).</span>`);
    });
  }

  async function init() {
    wireAccountSection();
    wireProcessSection();
    wireCacheSection();
    await tryAutoConnect();
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.panel = { init };
})();
