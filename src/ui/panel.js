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
  const uxp = require("uxp");
  const secureStorage = window.Auphonic.secureStorage;
  const auphonicClient = window.Auphonic.auphonicClient;
  const ticks = window.Auphonic.ticks;
  const selection = window.Auphonic.selection;
  const costEstimate = window.Auphonic.costEstimate;
  const exportModule = window.Auphonic.exportModule;
  const insertion = window.Auphonic.insertion;
  const organization = window.Auphonic.organization;
  const handles = window.Auphonic.handles;
  const jobModel = window.Auphonic.jobModel;
  const cache = window.Auphonic.cache;
  const paths = window.Auphonic.paths;
  const { CATEGORY, AuphonicPluginError } = window.Auphonic.errors;

  const state = {
    apiKey: null,
    presets: [],
    pendingJob: null,
  };

  /*
   * The Auphonic production-page URL format is undocumented (checked
   * auphonic.com/developers, the API details page, and the web-production
   * help page -- none show it). This is a guess, not a confirmed pattern --
   * kept here rather than in auphonicClient.js (whose header explicitly
   * states everything in it is confirmed live) until proven otherwise.
   * Live-verify by checking the real production detail JSON for an
   * undocumented url-like field first (see the console.log in runJob
   * below); if none exists, confirm this guessed pattern actually opens the
   * right production before trusting it further.
   */
  function buildProductionUrl(productionUuid) {
    return `https://auphonic.com/engine/upload/${productionUuid}`;
  }

  /* Small inline confirm -- not a native confirm(), which has never been
   * used or verified in this codebase. Resolves true/false on button click. */
  function askInlineConfirm(message) {
    return new Promise((resolve) => {
      setHtml("collisionText", message);
      show("collisionPrompt");
      const confirmBtn = el("collisionConfirmBtn");
      const cancelBtn = el("collisionCancelBtn");
      const cleanup = (result) => {
        hide("collisionPrompt");
        confirmBtn.removeEventListener("click", onConfirm);
        cancelBtn.removeEventListener("click", onCancel);
        resolve(result);
      };
      const onConfirm = () => cleanup(true);
      const onCancel = () => cleanup(false);
      confirmBtn.addEventListener("click", onConfirm);
      cancelBtn.addEventListener("click", onCancel);
    });
  }

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

  /* -------------------------------------------------------------- handles */

  function requestedHandleSeconds() {
    if (!el("handlesEnabled").checked) return 0;
    const value = parseFloat(el("handlesSecondsInput").value);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  async function wireHandlesSection() {
    const settings = await cache.getSettings();
    el("handlesEnabled").checked = Boolean(settings.handlesEnabled);
    el("handlesSecondsInput").value = typeof settings.handlesSeconds === "number" ? settings.handlesSeconds : 2.0;
    el("handlesSecondsInput").disabled = !el("handlesEnabled").checked;

    el("handlesEnabled").addEventListener("change", () => {
      el("handlesSecondsInput").disabled = !el("handlesEnabled").checked;
      cache.saveSettings({ handlesEnabled: el("handlesEnabled").checked });
    });
    el("handlesSecondsInput").addEventListener("change", () => {
      cache.saveSettings({ handlesSeconds: parseFloat(el("handlesSecondsInput").value) || 2.0 });
    });
  }

  /* -------------------------------------------------------- label color */

  function populateLabelColorOptions() {
    const select = el("labelColorSelect");
    select.innerHTML = "";
    const noneOption = document.createElement("option");
    noneOption.value = "none";
    noneOption.textContent = "None";
    select.appendChild(noneOption);
    organization.listColorLabelNames().forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name.charAt(0) + name.slice(1).toLowerCase();
      select.appendChild(option);
    });
  }

  async function wireLabelColorSection() {
    populateLabelColorOptions();
    const select = el("labelColorSelect");
    const settings = await cache.getSettings();
    const isValid = settings.labelColor && Array.from(select.options).some((o) => o.value === settings.labelColor);
    select.value = isValid ? settings.labelColor : "none";
    select.addEventListener("change", () => {
      cache.saveSettings({ labelColor: select.value });
    });
  }

  function selectedLabelColor() {
    return el("labelColorSelect").value || "none";
  }

  /* ---------------------------------------------------------- formats */

  async function wireExtraFormatsSection() {
    const settings = await cache.getSettings();
    el("mp3Enabled").checked = Boolean(settings.mp3Enabled);
    el("aacEnabled").checked = Boolean(settings.aacEnabled);
    el("mp3Enabled").addEventListener("change", () => {
      cache.saveSettings({ mp3Enabled: el("mp3Enabled").checked });
    });
    el("aacEnabled").addEventListener("change", () => {
      cache.saveSettings({ aacEnabled: el("aacEnabled").checked });
    });
  }

  function selectedExtraFormats() {
    const formats = [];
    if (el("mp3Enabled").checked) formats.push("mp3");
    if (el("aacEnabled").checked) formats.push("aac");
    return formats;
  }

  /* ------------------------------------------------------------ selection */

  async function checkSelection() {
    hide("estimateBox");
    hide("progressBox");
    hide("collisionPrompt");
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

      // Handles (PRD 9.6) -- computeHandlePlan returns a no-op plan (plain
      // clip range, no clamping) when requestedHandleSeconds is 0, so this
      // always runs and downstream code never needs a separate handles-off
      // branch.
      const handlesPlan = await handles.computeHandlePlan({
        trackItem: result.trackItem,
        requestedHandleSeconds: requestedHandleSeconds(),
      });
      if (handlesPlan.diagnostics.length > 0) {
        console.log("Auphonic handles diagnostics:", handlesPlan.diagnostics);
      }

      // Collision detection (PRD 9.5) -- pre-flight, before any credits are
      // spent. Checked against the widened range when handles are on, since
      // that's the real footprint the placement will need.
      const targetTrackIndex = result.trackIndex + 1;
      const collisionItem = await insertion.findCollisionOnAudioTrack(
        result.sequence,
        targetTrackIndex,
        handlesPlan.widenedStartTime,
        handlesPlan.widenedEndTime
      );

      let forceNewTrackBelow = false;
      if (collisionItem) {
        const proceed = await askInlineConfirm(
          "Destination track already has media at this time. Create a new track underneath and insert there?"
        );
        if (!proceed) {
          const job = jobModel.createJob({
            originalClipName: result.clipName,
            sequenceGuid: result.sequence.guid || result.sequence.name || "unknown-sequence",
            sourceProjectItemPath: result.mediaPath,
            timelineStartTicks: typeof result.startTime.ticksNumber === "number" ? String(result.startTime.ticksNumber) : String(result.startTime.seconds),
            timelineEndTicks: typeof result.endTime.ticksNumber === "number" ? String(result.endTime.ticksNumber) : String(result.endTime.seconds),
            presetUuid: preset.uuid,
            handlesSeconds: requestedHandleSeconds(),
            originalSelectionType: result.originalSelectionType,
            linkedAudioResolved: result.linkedAudioResolved,
            extraFormats: selectedExtraFormats(),
            labelColor: selectedLabelColor(),
          });
          job.collisionDetected = true;
          job.collisionDecision = "canceled";
          jobModel.markCanceled(job, "Destination track already had media at this time; user chose not to create a new track.");
          try {
            await jobModel.saveJob(result.project, job);
          } catch (e) {
            // Non-fatal -- the cancellation itself is what matters here.
          }
          setHtml("selectionStatus", '<span class="dim">Canceled -- the timeline is unchanged. No credits were spent.</span>');
          return;
        }
        forceNewTrackBelow = true;
      }

      let credits = null;
      try {
        const user = await auphonicClient.getUser(state.apiKey);
        credits = user.credits;
      } catch (e) {
        // Non-fatal -- estimate can still show without a fresh credit check.
      }

      const est = costEstimate.estimate({ durationSeconds: handlesPlan.widenedDurationSeconds, availableCreditsHours: credits });

      state.pendingJob = {
        ...result,
        preset,
        estimate: est,
        handlesPlan,
        forceNewTrackBelow,
        extraFormats: selectedExtraFormats(),
        labelColor: selectedLabelColor(),
      };

      const eligibleLabel =
        result.originalSelectionType === "video"
          ? `${result.clipName} (video clip -- using linked audio)`
          : result.clipName;
      setHtml(
        "selectionStatus",
        `<span class="ok">Eligible: ${eligibleLabel} (${costEstimate.formatDuration(handlesPlan.widenedDurationSeconds)})</span>`
      );

      setHtml(
        "estimateText",
        `Actual duration: ${costEstimate.formatDuration(est.durationSeconds)}<br/>` +
          `Estimated billable time: ${costEstimate.formatDuration(est.billableSeconds)}` +
          (credits !== null ? `<br/>Available credits: ${credits} h` : "")
      );
      const warningList = el("warningList");
      warningList.innerHTML = "";
      const allWarnings = est.warnings.concat(handlesPlan.clampWarnings);
      if (allWarnings.length > 0) {
        allWarnings.forEach((w) => {
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
    const {
      project,
      sequence,
      trackItem,
      projectItem,
      mediaPath,
      trackIndex,
      startTime,
      endTime,
      clipName,
      preset,
      handlesPlan,
      forceNewTrackBelow,
      originalSelectionType,
      linkedAudioResolved,
      extraFormats,
      labelColor,
    } = pendingJob;
    clearLog("progressLog");
    show("progressBox");
    hide("openProductionBtn");

    const setProgress = (text) => setHtml("progressStatus", `<span class="dim">${text}</span>`);
    const logStep = (text, cls) => appendLog("progressLog", text, cls);

    let job = jobModel.createJob({
      originalClipName: clipName,
      sequenceGuid: sequence.guid || sequence.name || "unknown-sequence",
      sourceProjectItemPath: mediaPath,
      timelineStartTicks: typeof startTime.ticksNumber === "number" ? String(startTime.ticksNumber) : String(startTime.seconds),
      timelineEndTicks: typeof endTime.ticksNumber === "number" ? String(endTime.ticksNumber) : String(endTime.seconds),
      presetUuid: preset.uuid,
      handlesSeconds: handlesPlan.leftSeconds > 0 || handlesPlan.rightSeconds > 0 ? Math.max(handlesPlan.leftSeconds, handlesPlan.rightSeconds) : 0,
      originalSelectionType,
      linkedAudioResolved,
      extraFormats,
      labelColor,
    });
    job.collisionDetected = Boolean(forceNewTrackBelow);
    job.collisionDecision = forceNewTrackBelow ? "created_new_track" : null;

    try {
      await jobModel.saveJob(project, job);
      logStep(`Job created: ${job.jobId}`, "dim");
      if (linkedAudioResolved) {
        logStep(`Video clip selected -- using linked audio "${clipName}".`, "dim");
      }

      setProgress("Exporting clip audio...");
      jobModel.markStatus(job, "exporting");
      await jobModel.saveJob(project, job);
      const jobFolder = await paths.getJobFolder(project, job.jobId);
      const inputFile = await paths.reserveFile(jobFolder, "input.wav");
      // Placement start defaults to the plain (unwidened) start -- matches
      // Phase 1 exactly when handles are off. Overwritten below with the
      // ACTUAL achieved widen if handles are on, since export can back off
      // further than the pre-flight estimate (handlesPlan.widenedStartTime)
      // -- placement must match what was really exported, or the inserted
      // clip won't line up with its own audio.
      let placementStartTime = startTime;
      if (handlesPlan.leftTicks > 0 || handlesPlan.rightTicks > 0) {
        const handleResult = await exportModule.exportHandleWidenedRange({
          project,
          sequence,
          trackItem,
          projectItem,
          leftTicks: handlesPlan.leftTicks,
          rightTicks: handlesPlan.rightTicks,
          outputFile: inputFile,
        });
        // Export can back off further than the pre-flight estimate (e.g. if
        // a clamp it couldn't fully verify in advance turned out to be
        // tighter in practice) -- record what was actually achieved, not
        // just what was requested.
        const achievedLeftSeconds = ppro.TickTime.createWithTicks(String(handleResult.achievedLeftTicks)).seconds;
        const achievedRightSeconds = ppro.TickTime.createWithTicks(String(handleResult.achievedRightTicks)).seconds;
        job.handlesActualLeftSeconds = achievedLeftSeconds;
        job.handlesActualRightSeconds = achievedRightSeconds;
        job.handlesClampWarnings = handlesPlan.clampWarnings;
        logStep(`Handles: -${achievedLeftSeconds.toFixed(1)}s / +${achievedRightSeconds.toFixed(1)}s`, "dim");

        const originalStartTicks = ticks.ticksNumberOf(startTime);
        placementStartTime = ppro.TickTime.createWithTicks(String(Math.round(originalStartTicks - handleResult.achievedLeftTicks)));
      } else {
        await exportModule.exportRangeToFile(project, sequence, startTime, endTime, inputFile);
      }
      job.inputCachePath = inputFile.nativePath;
      logStep(`Exported: ${inputFile.nativePath}`, "ok");

      setProgress("Creating Auphonic production...");
      jobModel.markStatus(job, "creating_production");
      await jobModel.saveJob(project, job);
      const outputBasename = `${clipName}_Auphonic_${preset.name}`.replace(/[\/:*?"<>|]/g, "_");
      console.log("Auphonic: requested extra formats for this production:", JSON.stringify(extraFormats));
      const productionUuid = await auphonicClient.createProduction(state.apiKey, {
        presetUuid: preset.uuid,
        title: `${clipName} - Auphonic`,
        outputBasename,
        extraFormats,
      });
      job.productionId = productionUuid;
      logStep(`Production created: ${productionUuid}`, "ok");
      const openBtn = el("openProductionBtn");
      openBtn.onclick = () => uxp.shell.openExternal(buildProductionUrl(productionUuid));
      show("openProductionBtn");

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
      // Live-verification aid for the "open in browser" URL (see
      // buildProductionUrl above), and now also for confirming (Phase 3) that
      // output_files[] carries a `format` field that reliably distinguishes
      // wav/mp3/aac when more than one is requested at once.
      console.log("Auphonic: full production detail (checking output_files shape for each requested format):", JSON.stringify(detail));
      // Match by `format` first; fall back to `ending` in case Auphonic
      // echoes the container extension instead of the requested codec name
      // (e.g. AAC requested with ending "m4a" -- never confirmed live before
      // this phase, so both plausible response shapes are covered here
      // rather than trusting only the one the PRD's request sample shows).
      const EXT_FOR_FORMAT = { wav: "wav", mp3: "mp3", aac: "m4a" };
      const findOutputFileMeta = (format) => {
        const files = detail.output_files || [];
        return files.find((f) => f.format === format) || files.find((f) => f.ending === EXT_FOR_FORMAT[format]) || null;
      };

      const wavMeta = findOutputFileMeta("wav");
      if (!wavMeta) {
        throw new AuphonicPluginError(CATEGORY.DOWNLOAD_FAILED, "Auphonic reported no WAV output file.");
      }
      const wavBytes = await auphonicClient.downloadOutputFile(state.apiKey, wavMeta.download_url);
      const outputFile = await paths.writeBinary(jobFolder, "output.wav", wavBytes);
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
        // Widened start (handles-off: identical to the plain start) --
        // PRD 9.6: insert starting handle-seconds before the original start.
        // Uses the ACTUAL achieved widen (placementStartTime), not the
        // pre-flight estimate, since export can back off further than
        // estimated -- see the export step above.
        startTime: placementStartTime,
        outputFilePath: outputFile.nativePath,
        originalClipName: clipName,
        presetName: preset.name,
        forceNewTrackBelow,
        binName: organization.DEFAULT_BIN_NAME,
        colorLabel: labelColor,
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
      placement.organizationWarnings.forEach((w) => logStep(`Warning: ${w}`, "warn"));

      // Phase 3: MP3/AAC, generated alongside WAV at no extra Auphonic cost
      // (PRD 5). Only WAV ever goes on the timeline -- these are imported
      // into the shared bin for reference/delivery only. Each format is
      // independently non-fatal: a problem here must never undo the WAV
      // placement that already succeeded above.
      for (const format of extraFormats) {
        const meta = findOutputFileMeta(format);
        if (!meta) {
          logStep(`Warning: Auphonic reported no ${format.toUpperCase()} output file -- skipping.`, "warn");
          continue;
        }
        try {
          setProgress(`Downloading and importing ${format.toUpperCase()}...`);
          const bytes = await auphonicClient.downloadOutputFile(state.apiKey, meta.download_url);
          const ext = EXT_FOR_FORMAT[format];
          const extraFile = await paths.writeBinary(jobFolder, `output.${ext}`, bytes);
          const extra = await insertion.importExtraOutputFile({
            project,
            filePath: extraFile.nativePath,
            originalClipName: clipName,
            presetName: preset.name,
            ext,
            binName: organization.DEFAULT_BIN_NAME,
            colorLabel: labelColor,
          });
          job.extraOutputCachePaths[format] = extraFile.nativePath;
          logStep(`Imported "${extra.newName}" into the "${organization.DEFAULT_BIN_NAME}" bin.`, "ok");
          extra.organizationWarnings.forEach((w) => logStep(`Warning: ${w}`, "warn"));
        } catch (err) {
          logStep(`Warning: could not import the ${format.toUpperCase()} file (${describeError(err)}).`, "warn");
        }
      }
      if (extraFormats.length > 0) {
        await jobModel.saveJob(project, job);
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

  async function wireProcessSection() {
    await wireHandlesSection();
    await wireExtraFormatsSection();
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
    await wireProcessSection();
    await wireLabelColorSection();
    wireCacheSection();
    await tryAutoConnect();
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.panel = { init };
})();
