/*
 * Panel wiring -- DOM handling and UI-facing orchestration. Core logic lives
 * in ../core/*, including the per-job pipeline itself (src/core/queue.js as
 * of Phase 4a); this file just calls it in order and reflects progress/
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
  const selection = window.Auphonic.selection;
  const costEstimate = window.Auphonic.costEstimate;
  const insertion = window.Auphonic.insertion;
  const organization = window.Auphonic.organization;
  const handles = window.Auphonic.handles;
  const jobModel = window.Auphonic.jobModel;
  const queueModule = window.Auphonic.queue;
  const cache = window.Auphonic.cache;
  const { AuphonicPluginError } = window.Auphonic.errors;

  const state = {
    apiKey: null,
    presets: [],
    pendingUnits: [],
  };

  /*
   * The Auphonic production-page URL format is undocumented (checked
   * auphonic.com/developers, the API details page, and the web-production
   * help page -- none show it). This is a guess, not a confirmed pattern --
   * kept here rather than in auphonicClient.js (whose header explicitly
   * states everything in it is confirmed live) until proven otherwise.
   * Confirmed live (Phase 2) to open the right production's page.
   */
  function buildProductionUrl(productionUuid) {
    return `https://auphonic.com/engine/upload/${productionUuid}`;
  }

  /* Small inline confirm -- not a native confirm(), which has never been
   * used or verified in this codebase. Resolves true/false on button click.
   * Reused sequentially, once per colliding unit, when checking a multi-clip
   * selection (Phase 4a). */
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

  /*
   * Phase 4a: checks the WHOLE current timeline selection (any number of
   * independent clips/video+linked-audio pairs) instead of exactly one, via
   * selection.resolveQueueCandidates(). Ineligible units are reported the
   * same way single-clip skips always were. A unit whose destination-track
   * collision prompt is declined gets a durable canceled job record (via
   * queueModule.recordDeclinedJob, same precedent Phase 1/2 established) and
   * is otherwise excluded from the batch -- no credits are spent for it.
   * Eligible units populate state.pendingUnits, gated behind one aggregate
   * cost estimate and an explicit Confirm & Process click, exactly like the
   * single-clip flow's confirmation gate (PRD principle #2), just summed
   * across the whole batch.
   */
  async function checkSelection() {
    hide("estimateBox");
    hide("collisionPrompt");
    state.pendingUnits = [];
    setHtml("selectionStatus", '<span class="dim">Checking...</span>');
    try {
      const result = await selection.resolveQueueCandidates();
      if (result.diagnostics && result.diagnostics.length > 0) {
        console.log("Auphonic selection diagnostics:", result.diagnostics);
      }

      const preset = selectedPreset();
      if (!preset) {
        setHtml("selectionStatus", '<span class="bad">Choose a preset first.</span>');
        return;
      }

      const skipLines = [];
      const readyBundles = [];

      for (const unit of result.units) {
        if (unit.diagnostics && unit.diagnostics.length > 0) {
          console.log(
            "Auphonic eligibility diagnostics (checks this build couldn't run, or how media type was resolved):",
            unit.diagnostics
          );
        }
        if (!unit.eligible) {
          skipLines.push(`Skipped: ${unit.clipName || "selected item"} - ${unit.reason}`);
          continue;
        }

        // Handles (PRD 9.6) -- computeHandlePlan returns a no-op plan (plain
        // clip range, no clamping) when requestedHandleSeconds is 0, so this
        // always runs and downstream code never needs a separate handles-off
        // branch.
        const handlesPlan = await handles.computeHandlePlan({
          trackItem: unit.trackItem,
          requestedHandleSeconds: requestedHandleSeconds(),
        });
        if (handlesPlan.diagnostics.length > 0) {
          console.log("Auphonic handles diagnostics:", handlesPlan.diagnostics);
        }

        // Collision detection (PRD 9.5) -- pre-flight, before any credits are
        // spent. Checked against the widened range when handles are on.
        const targetTrackIndex = unit.trackIndex + 1;
        const collisionItem = await insertion.findCollisionOnAudioTrack(
          result.sequence,
          targetTrackIndex,
          handlesPlan.widenedStartTime,
          handlesPlan.widenedEndTime
        );

        let forceNewTrackBelow = false;
        if (collisionItem) {
          const proceed = await askInlineConfirm(
            `"${unit.clipName}": destination track already has media at this time. Create a new track underneath and insert there?`
          );
          if (!proceed) {
            await queueModule.recordDeclinedJob(
              result.project,
              {
                clipName: unit.clipName,
                sequence: result.sequence,
                mediaPath: unit.mediaPath,
                startTime: unit.startTime,
                endTime: unit.endTime,
                preset,
                originalSelectionType: unit.originalSelectionType,
                linkedAudioResolved: unit.linkedAudioResolved,
                extraFormats: selectedExtraFormats(),
                labelColor: selectedLabelColor(),
              },
              "Destination track already had media at this time; user chose not to create a new track."
            );
            renderQueueTable();
            skipLines.push(`Canceled: ${unit.clipName} - destination track collision declined. No credits were spent.`);
            continue;
          }
          forceNewTrackBelow = true;
        }

        readyBundles.push({
          ...unit,
          project: result.project,
          sequence: result.sequence,
          preset,
          handlesPlan,
          forceNewTrackBelow,
          extraFormats: selectedExtraFormats(),
          labelColor: selectedLabelColor(),
        });
      }

      let credits = null;
      try {
        const user = await auphonicClient.getUser(state.apiKey);
        credits = user.credits;
      } catch (e) {
        // Non-fatal -- estimate can still show without a fresh credit check.
      }

      if (readyBundles.length === 0) {
        setHtml(
          "selectionStatus",
          skipLines.length > 0
            ? `<span class="bad">${skipLines.join("<br/>")}</span>`
            : '<span class="bad">Nothing eligible in the current selection.</span>'
        );
        return;
      }

      let totalDuration = 0;
      let totalBillable = 0;
      const allWarnings = [];
      readyBundles.forEach((bundle) => {
        const est = costEstimate.estimate({
          durationSeconds: bundle.handlesPlan.widenedDurationSeconds,
          availableCreditsHours: credits,
        });
        bundle.estimate = est;
        totalDuration += est.durationSeconds;
        totalBillable += est.billableSeconds;
        est.warnings.forEach((w) => allWarnings.push(`${bundle.clipName}: ${w}`));
        bundle.handlesPlan.clampWarnings.forEach((w) => allWarnings.push(`${bundle.clipName}: ${w}`));
      });

      state.pendingUnits = readyBundles;

      const readyNames = readyBundles.map((b) =>
        b.originalSelectionType === "video" ? `${b.clipName} (video clip -- using linked audio)` : b.clipName
      );
      const statusLines = [`<span class="ok">${readyBundles.length} clip(s) ready: ${readyNames.join(", ")}</span>`];
      if (skipLines.length > 0) statusLines.push(`<span class="bad">${skipLines.join("<br/>")}</span>`);
      setHtml("selectionStatus", statusLines.join("<br/>"));

      setHtml(
        "estimateText",
        `Clips ready: ${readyBundles.length}<br/>` +
          `Total actual duration: ${costEstimate.formatDuration(totalDuration)}<br/>` +
          `Total estimated billable time: ${costEstimate.formatDuration(totalBillable)}` +
          (credits !== null ? `<br/>Available credits: ${credits} h` : "")
      );
      const warningList = el("warningList");
      warningList.innerHTML = "";
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

  /* ------------------------------------------------------------------ queue */

  function queueHooks() {
    return {
      onStatus: (entry) => {
        const label = jobModel.STATUS_LABELS[entry.job.status] || entry.job.status;
        setHtml("progressStatus", `<span class="dim">${entry.job.originalClipName} -- ${label}</span>`);
        renderQueueTable();
      },
      onLog: (entry, message, cls) => appendLog("progressLog", `[${entry.job.originalClipName}] ${message}`, cls),
    };
  }

  function statusBadgeClass(status) {
    if (status === "inserted") return "ok";
    if (status === "failed") return "bad";
    if (status === "canceled") return "dim";
    return "warn";
  }

  function renderQueueTable() {
    const entries = queueModule.getEntries();
    const tbody = el("queueTableBody");
    tbody.innerHTML = "";

    if (entries.length === 0) {
      hide("queueSection");
      return;
    }
    show("queueSection");

    entries.forEach((entry) => {
      const { job, live } = entry;
      const row = document.createElement("tr");

      const nameCell = document.createElement("td");
      nameCell.textContent = job.originalClipName;
      row.appendChild(nameCell);

      const statusCell = document.createElement("td");
      const statusSpan = document.createElement("span");
      statusSpan.className = statusBadgeClass(job.status);
      statusSpan.textContent = jobModel.STATUS_LABELS[job.status] || job.status;
      statusCell.appendChild(statusSpan);
      if (job.status === "failed" && job.errorMessage) {
        const detail = document.createElement("div");
        detail.className = "dim queue-row-detail";
        detail.textContent = job.errorMessage;
        statusCell.appendChild(detail);
      }
      if (!live && job.productionId && !["inserted", "failed", "canceled"].includes(job.status)) {
        const warning = document.createElement("div");
        warning.className = "warn queue-row-detail";
        warning.textContent =
          "This clip may already have an Auphonic production in progress -- check auphonic.com before reprocessing it.";
        statusCell.appendChild(warning);
      }
      row.appendChild(statusCell);

      const actionsCell = document.createElement("td");
      actionsCell.className = "queue-actions";

      if (live && queueModule.CANCELABLE_STATUSES.includes(job.status)) {
        const cancelBtn = document.createElement("button");
        cancelBtn.className = "secondary";
        cancelBtn.textContent = "Cancel";
        cancelBtn.onclick = async () => {
          await queueModule.cancelJob(entry);
          renderQueueTable();
        };
        actionsCell.appendChild(cancelBtn);
      }

      if (live && job.status === "failed") {
        const retryBtn = document.createElement("button");
        retryBtn.className = "secondary";
        retryBtn.textContent = "Retry";
        retryBtn.onclick = async () => {
          retryBtn.disabled = true;
          await queueModule.retryJob(entry, state.apiKey, queueHooks());
          renderQueueTable();
        };
        actionsCell.appendChild(retryBtn);
      }

      if (job.productionId) {
        const openBtn = document.createElement("button");
        openBtn.className = "secondary";
        openBtn.textContent = "Open in Auphonic";
        openBtn.onclick = () => uxp.shell.openExternal(buildProductionUrl(job.productionId));
        actionsCell.appendChild(openBtn);
      }

      if (!live && !["inserted", "failed", "canceled"].includes(job.status)) {
        const dismissBtn = document.createElement("button");
        dismissBtn.className = "secondary";
        dismissBtn.textContent = "Dismiss";
        dismissBtn.onclick = async () => {
          const project = await ppro.Project.getActiveProject();
          await queueModule.dismissHistoryEntry(project, entry);
          renderQueueTable();
        };
        actionsCell.appendChild(dismissBtn);
      }

      row.appendChild(actionsCell);
      tbody.appendChild(row);
    });
  }

  async function wireProcessSection() {
    await wireHandlesSection();
    await wireExtraFormatsSection();
    el("checkSelectionBtn").addEventListener("click", checkSelection);
    el("confirmBtn").addEventListener("click", async () => {
      if (!state.pendingUnits || state.pendingUnits.length === 0) return;
      const project = state.pendingUnits[0].project;
      const apiKey = state.apiKey;
      el("confirmBtn").disabled = true;
      try {
        await queueModule.enqueue(project, state.pendingUnits);
        state.pendingUnits = [];
        hide("estimateBox");
        renderQueueTable();
        show("progressBox");
        await queueModule.runQueue(project, apiKey, queueHooks());
      } finally {
        el("confirmBtn").disabled = false;
      }
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
    try {
      const project = await ppro.Project.getActiveProject();
      if (project) {
        await queueModule.loadHistory(project);
        renderQueueTable();
      }
    } catch (e) {
      // Non-fatal -- history is a bonus; the panel still works without it.
    }
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.panel = { init };
})();
