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
 *
 * Phase 5: this file's own calls into every core module are unchanged from
 * Phase 4c -- same functions, same arguments, same order. Only what happens
 * with their return values on the DOM side changed (card-based markup
 * instead of flat sections, a per-clip card list instead of a queue table).
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
  const jobModel = window.Auphonic.jobModel;
  const queueModule = window.Auphonic.queue;
  const cache = window.Auphonic.cache;
  const { AuphonicPluginError } = window.Auphonic.errors;

  // Kept in sync with manifest.json's own "version" by hand -- bump both
  // together on every release (see RELEASING.md). Only used to stamp the
  // "Report a Bug" email below; nothing reads the manifest file at runtime.
  const PLUGIN_VERSION = "1.1.0";
  const BUG_REPORT_EMAIL = "anmolpreet@hackerrank.com";

  /*
   * Rough, approximate stage weighting for the combined progress bar on a
   * clip card -- there's no real end-to-end percentage anywhere in the
   * pipeline (Auphonic's own "processing" step reports no byte/percent
   * progress at all, just a status string), so this is a reasonable-looking
   * approximation across queued -> ... -> placing, not a measured one.
   * "uploading" is the one stage with real byte-level progress (the
   * existing "Uploading... N%" log line) -- its own range is interpolated
   * using that, everything else jumps straight to its base value.
   */
  const STAGE_PROGRESS = {
    queued: 2,
    validating: 8,
    exporting: 18,
    creating_production: 28,
    uploading: { start: 35, end: 60 },
    processing: 65,
    downloading: 78,
    placing: 90,
  };

  function computeProgressPercent(job) {
    const stage = STAGE_PROGRESS[job.status];
    if (stage === undefined) return null;
    if (typeof stage === "object") {
      const pct = state.uploadPct[job.jobId];
      return Math.round(typeof pct === "number" ? stage.start + (pct / 100) * (stage.end - stage.start) : stage.start);
    }
    return stage;
  }

  const state = {
    apiKey: null,
    presets: [],
    pendingUnits: [],
    consolidating: false,
    // Phase 5: per-clip log lines and "Show details" open state, keyed by
    // jobId -- the clip list re-renders on every status change, so this is
    // what lets accumulated log lines and an open details panel survive
    // that re-render instead of being wiped each time.
    clipLogs: {},
    expandedClips: {},
    // Collapsed-by-default state for a batch's own member-list disclosure,
    // keyed by batchId -- see appendEntriesWithBatchProgress.
    expandedBatches: {},
    // Latest parsed "Uploading... N%" value per jobId, for the combined
    // progress bar's one real-progress stage -- see STAGE_PROGRESS above.
    uploadPct: {},
    // Phase 5 (round 2): "current run" now means exactly one thing -- the
    // batch of jobIds created by the most recent Confirm & Process click
    // (see wireProcessSection below), plus anything the user just retried.
    // Everything else, live or not, renders in the Past Productions
    // disclosure instead of "Your Clips" -- see isCurrentRunEntry.
    currentBatchJobIds: new Set(),
    labelColor: "none",
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
      const cleanup = (result) => {
        hide("collisionPrompt");
        detachConfirm();
        detachCancel();
        resolve(result);
      };
      const onConfirm = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const detachConfirm = onActivate("collisionConfirmBtn", onConfirm);
      const detachCancel = onActivate("collisionCancelBtn", onCancel);
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

  /*
   * Every clickable control in this panel is a plain `<div role="button"
   * tabindex="0">`, never a real `<button>` -- see the top-of-file note in
   * styles.css for why (a real `<button>` renders with native chrome no
   * CSS override, including `!important`, could fully strip in this host,
   * confirmed live across three separate attempts). These three helpers
   * are what a real `<button>` would have given for free: click *and*
   * keyboard (Enter/Space) activation, and a disabled state that both
   * looks disabled and actually blocks clicks (`pointer-events: none` via
   * the `.is-disabled` class -- see styles.css).
   */
  function onActivate(elOrId, handler) {
    const target = typeof elOrId === "string" ? el(elOrId) : elOrId;
    const onKey = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handler(event);
      }
    };
    target.addEventListener("click", handler);
    target.addEventListener("keydown", onKey);
    return () => {
      target.removeEventListener("click", handler);
      target.removeEventListener("keydown", onKey);
    };
  }

  function setBtnDisabled(elOrId, isDisabled) {
    const target = typeof elOrId === "string" ? el(elOrId) : elOrId;
    target.classList.toggle("is-disabled", isDisabled);
    target.setAttribute("aria-disabled", String(isDisabled));
  }

  function makeBtn(className, text) {
    const b = document.createElement("div");
    b.className = className;
    b.setAttribute("role", "button");
    b.setAttribute("tabindex", "0");
    b.textContent = text;
    return b;
  }

  /*
   * Phase 5: dropped the raw err.category prefix from the default-visible
   * line (e.g. just "Enter an API key first." instead of "Premiere
   * selection error: ..."). For a failed clip in the "Your Clips" list, the
   * category is still shown -- inside that card's "Show details" panel,
   * see renderClipCard below -- rather than on the default line.
   */
  function describeError(err) {
    return err && err.message ? err.message : String(err);
  }

  // Auphonic's own credits figure comes back with long floating-point
  // precision (e.g. 15.509233333333256) -- purely a display rounding, the
  // real value passed to any cost/estimate math elsewhere is untouched.
  function formatCredits(hours) {
    return Number(hours).toFixed(1);
  }

  // Phase 5: the default-visible line for a failed clip now shows a short
  // excerpt rather than job.errorMessage in full -- the full text still
  // shows, unabridged, inside that clip's "Show details" panel.
  function shortErrorSummary(message) {
    if (!message) return "";
    const LIMIT = 40;
    const sentenceEnd = message.indexOf(". ");
    if (sentenceEnd > -1 && sentenceEnd < LIMIT) return message.slice(0, sentenceEnd + 1);
    if (message.length <= LIMIT) return message;
    // A few words, then "...", cut at the last whole word rather than
    // mid-word (was slicing to an exact character count regardless of
    // word boundaries, which produced things like "...in your prese...").
    const truncated = message.slice(0, LIMIT);
    const lastSpace = truncated.lastIndexOf(" ");
    const base = lastSpace > 10 ? truncated.slice(0, lastSpace) : truncated;
    return `${base.trim()}...`;
  }

  /* ------------------------------------------------------------ account/key */

  async function connectWithKey(apiKey, { persist }) {
    setHtml("keyStatus", '<span class="dim">Connecting...</span>');
    try {
      const user = await auphonicClient.getUser(apiKey);
      state.apiKey = apiKey;
      if (persist) await secureStorage.saveApiKey(apiKey);
      el("apiKeyInput").value = "";
      setHtml("connectedSummary", `Connected &middot; ${formatCredits(user.credits)}h credits`);
      hide("connectExpanded");
      show("connectCollapsed");
      show("settingsCard");
      show("actionCard");
      show("advancedSection");
      await loadPresets();
      return true;
    } catch (err) {
      setHtml("keyStatus", `<span class="bad">${describeError(err)}</span>`);
      return false;
    }
  }

  function wireAccountSection() {
    onActivate("saveKeyBtn", async () => {
      const apiKey = el("apiKeyInput").value.trim();
      if (!apiKey) {
        setHtml("keyStatus", '<span class="bad">Enter an API key first.</span>');
        return;
      }
      await connectWithKey(apiKey, { persist: true });
    });

    onActivate("changeKeyBtn", () => {
      hide("connectCollapsed");
      show("connectExpanded");
      show("cancelChangeKeyBtn");
      el("apiKeyInput").value = "";
      setHtml("keyStatus", '<span class="dim">Paste a new key and click Connect.</span>');
    });

    // Backs out of "Change key" without touching the already-saved key --
    // only reachable via changeKeyBtn above, so an existing connection is
    // guaranteed here (there was previously no way back to the collapsed
    // "Connected" line short of actually entering and saving a new key).
    onActivate("cancelChangeKeyBtn", () => {
      hide("connectExpanded");
      hide("cancelChangeKeyBtn");
      show("connectCollapsed");
      el("apiKeyInput").value = "";
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
      // No lingering "N preset(s) loaded" success message -- the loading
      // and error states below are still shown since those are actually
      // useful; a successful load just clears the line.
      setHtml("presetStatus", "");
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

  /* ---------------------------------------------------- consolidation */

  /*
   * Phase 4b: opt-in, default ON (your call this session) whenever 2+
   * clips end up eligible in a checked batch -- inert below that, same as
   * unchecking it. Persisted like every other toggle.
   */
  function consolidateRequested() {
    return el("consolidateEnabled").checked;
  }

  async function wireConsolidateSection() {
    const settings = await cache.getSettings();
    el("consolidateEnabled").checked = settings.consolidateEnabled !== false;
    el("consolidateEnabled").addEventListener("change", () => {
      cache.saveSettings({ consolidateEnabled: el("consolidateEnabled").checked });
    });
  }

  /* -------------------------------------------------------- label color */

  /*
   * Approximate swatch hues for Premiere's named label colors, keyed by the
   * same uppercase enum keys organization.listColorLabelNames() returns.
   * ppro.Constants.ProjectItemColorLabel only exposes an enum for SETTING a
   * label -- it has no getter for the actual RGB Premiere paints on screen
   * for each name, and there's no live way to read that back. These hex
   * values are a by-eye approximation (violet=purple, forest=dark green,
   * etc.), not sampled from Premiere itself -- if any look visibly wrong
   * next to Premiere's own Label Colors preferences, they're safe to adjust
   * here without touching anything else.
   */
  const LABEL_COLOR_HEX = {
    VIOLET: "#b166e0",
    IRIS: "#6a5fc4",
    LAVENDER: "#c9b8ea",
    CERULEAN: "#4fa3e0",
    FOREST: "#3f8f4f",
    ROSE: "#e0708a",
    MANGO: "#eba13c",
    PURPLE: "#9a4fcf",
    BLUE: "#4a72e0",
    TEAL: "#3fa89e",
    MAGENTA: "#d43fae",
    TAN: "#c9a876",
    GREEN: "#5cbf5c",
    BROWN: "#8a5a3c",
    YELLOW: "#e0cf3f",
  };

  function labelColorNames() {
    return ["none", ...organization.listColorLabelNames()];
  }

  function labelColorDisplayName(value) {
    if (!value || value === "none") return "None";
    return value.charAt(0) + value.slice(1).toLowerCase();
  }

  function paintSwatch(swatchEl, value) {
    const hex = LABEL_COLOR_HEX[value];
    if (hex) {
      swatchEl.style.background = hex;
      swatchEl.style.border = "none";
    } else {
      swatchEl.style.background = "transparent";
      swatchEl.style.border = "1px solid var(--input-border)";
    }
  }

  function setColorSelectButton(value) {
    paintSwatch(el("labelColorSwatch"), value);
    el("labelColorButtonText").textContent = labelColorDisplayName(value);
  }

  function setColorListOpen(isOpen) {
    el("labelColorList").classList.toggle("hidden", !isOpen);
    el("labelColorButton").setAttribute("aria-expanded", String(isOpen));
  }

  function selectLabelColor(value) {
    state.labelColor = value;
    setColorSelectButton(value);
    setColorListOpen(false);
    cache.saveSettings({ labelColor: value });
  }

  function buildColorOptionsList() {
    const list = el("labelColorList");
    list.innerHTML = "";
    labelColorNames().forEach((name) => {
      const row = document.createElement("div");
      row.className = "color-select-option";
      row.setAttribute("role", "option");
      row.setAttribute("tabindex", "0");
      const swatch = document.createElement("span");
      swatch.className = "color-swatch";
      paintSwatch(swatch, name);
      row.appendChild(swatch);
      const label = document.createElement("span");
      label.textContent = labelColorDisplayName(name);
      row.appendChild(label);
      onActivate(row, () => selectLabelColor(name));
      list.appendChild(row);
    });
  }

  async function wireLabelColorSection() {
    buildColorOptionsList();
    const settings = await cache.getSettings();
    const isValid = settings.labelColor && labelColorNames().includes(settings.labelColor);
    state.labelColor = isValid ? settings.labelColor : "none";
    setColorSelectButton(state.labelColor);

    onActivate("labelColorButton", (event) => {
      event.stopPropagation();
      setColorListOpen(el("labelColorList").classList.contains("hidden"));
    });
    document.addEventListener("click", (event) => {
      if (!el("labelColorSelect").contains(event.target)) setColorListOpen(false);
    });
  }

  function selectedLabelColor() {
    return state.labelColor || "none";
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

        // Collision detection (PRD 9.5) -- pre-flight, before any credits
        // are spent.
        const targetTrackIndex = unit.trackIndex + 1;
        const collisionItem = await insertion.findCollisionOnAudioTrack(
          result.sequence,
          targetTrackIndex,
          unit.startTime,
          unit.endTime
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
            renderClipsList();
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
          forceNewTrackBelow,
          extraFormats: selectedExtraFormats(),
          labelColor: selectedLabelColor(),
        });
      }

      /*
       * Phase 4c: this briefly merged into whatever was already staged
       * (deduped by source range) instead of replacing it, specifically to
       * support "check a handles-on group, then a handles-off group, then
       * confirm both together." Now that the handles feature has been
       * removed entirely, that's no longer a real workflow -- and the merge
       * became a live bug in its own right: leftover units from an earlier,
       * unrelated "Check Selected Clip(s)" click silently piled up alongside
       * a later, unrelated selection (confirmed live: checking 3 clips
       * showed 5 staged). Each check now reflects exactly the current
       * selection again, matching every phase before Phase 4c.
       */
      state.pendingUnits = readyBundles;

      let credits = null;
      try {
        const user = await auphonicClient.getUser(state.apiKey);
        credits = user.credits;
      } catch (e) {
        // Non-fatal -- estimate can still show without a fresh credit check.
      }

      if (state.pendingUnits.length === 0) {
        setHtml(
          "selectionStatus",
          skipLines.length > 0
            ? `<span class="bad">${skipLines.join("<br/>")}</span>`
            : '<span class="bad">Nothing eligible in the current selection.</span>'
        );
        return;
      }

      // Consolidation only means anything for 2+ clips -- inert (falls back
      // to Phase 4a's per-clip-summed estimate/production below) otherwise.
      state.consolidating = consolidateRequested() && state.pendingUnits.length >= 2;

      let totalDuration = 0;
      const allWarnings = [];
      state.pendingUnits.forEach((bundle) => {
        totalDuration += bundle.durationSeconds;
      });

      const readyNames = state.pendingUnits.map((b) =>
        b.originalSelectionType === "video" ? `${b.clipName} (video clip - using linked audio)` : b.clipName
      );
      const statusLines = [
        `<span class="ok">${state.pendingUnits.length} clip(s) ready${state.consolidating ? " (consolidating into one production)" : ""}: ${readyNames.join(", ")}</span>`,
      ];
      if (skipLines.length > 0) statusLines.push(`<span class="bad">${skipLines.join("<br/>")}</span>`);
      setHtml("selectionStatus", statusLines.join("<br/>"));

      if (state.consolidating) {
        // One combined estimate (one 3-minute floor across the whole batch)
        // -- shown instead of, not alongside, a per-clip-summed number, so
        // there's only ever one "this is what it'll bill" figure on screen.
        const est = costEstimate.estimate({ durationSeconds: totalDuration, availableCreditsHours: credits });
        est.warnings.forEach((w) => allWarnings.push(w));
        setHtml(
          "estimateText",
          `Clips ready: ${state.pendingUnits.length}, consolidated into one production<br/>` +
            `Total actual duration: ${costEstimate.formatDuration(totalDuration)}<br/>` +
            `Estimated billable time: ${costEstimate.formatDuration(est.billableSeconds)}` +
            (credits !== null ? `<br/>Available credits: ${credits} h` : "")
        );
      } else {
        let totalBillable = 0;
        state.pendingUnits.forEach((bundle) => {
          const est = costEstimate.estimate({
            durationSeconds: bundle.durationSeconds,
            availableCreditsHours: credits,
          });
          bundle.estimate = est;
          totalBillable += est.billableSeconds;
          est.warnings.forEach((w) => allWarnings.push(`${bundle.clipName}: ${w}`));
        });
        setHtml(
          "estimateText",
          `Clips ready: ${state.pendingUnits.length}<br/>` +
            `Total actual duration: ${costEstimate.formatDuration(totalDuration)}<br/>` +
            `Total estimated billable time: ${costEstimate.formatDuration(totalBillable)}` +
            (credits !== null ? `<br/>Available credits: ${credits} h` : "")
        );
      }
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

  /*
   * Phase 5: log lines used to print straight into one always-visible,
   * console-style box. Now every job's own lines are buffered here (keyed
   * by jobId) so they survive the clip list's own re-renders, and are only
   * shown inside that clip's "Show details" panel -- collapsed by default,
   * same underlying content onLog has always produced.
   */
  function queueHooks() {
    return {
      onStatus: () => renderClipsList(),
      onLog: (entry, message, cls) => {
        const jobId = entry.job.jobId;
        if (!state.clipLogs[jobId]) state.clipLogs[jobId] = [];
        state.clipLogs[jobId].push({ message, cls });
        appendLiveLogLine(jobId, message, cls);
        const uploadMatch = /Uploading\.\.\. (\d+)%/.exec(message);
        if (uploadMatch) {
          state.uploadPct[jobId] = Number(uploadMatch[1]);
          updateLiveProgressBar(jobId, entry.job);
        }
      },
    };
  }

  // Same fast-path idea as appendLiveLogLine below -- upload progress can
  // fire many times per job, well more often than the status changes that
  // trigger a full renderClipsList(), so this updates an already-rendered
  // bar's width directly instead of waiting for the next full re-render.
  // A batch member has no bar of its own (see buildClipCard) -- its shared
  // batch-progress row is the one that needs the live update instead.
  function updateLiveProgressBar(jobId, job) {
    const percent = computeProgressPercent(job);
    if (percent === null) return;
    const targetId = job.batchId ? `batchProgress-${job.batchId}` : `clipProgress-${jobId}`;
    const fill = document.getElementById(targetId);
    const pctLabel = document.getElementById(`${targetId}-pct`);
    if (fill) fill.style.width = `${percent}%`;
    if (pctLabel) pctLabel.textContent = `${percent}%`;
  }

  // Shared by both the per-card progress row (a solo job) and the
  // per-batch one (see buildBatchProgressHeader below) -- a thin bar plus a
  // minimal percentage label, nothing more.
  function buildProgressRow(percent, fillId) {
    const row = document.createElement("div");
    row.className = "progress-row";
    const bar = document.createElement("div");
    bar.className = "progress-bar";
    const fill = document.createElement("div");
    fill.className = "progress-bar-fill";
    if (fillId) fill.id = fillId;
    fill.style.width = `${percent}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
    const pct = document.createElement("span");
    pct.className = "progress-percent";
    if (fillId) pct.id = `${fillId}-pct`;
    pct.textContent = `${percent}%`;
    row.appendChild(pct);
    return row;
  }

  /*
   * One shared progress row for an entire consolidated batch, rendered
   * once above its member cards -- every member's status is broadcast
   * together by processBatch (see queue.js), so N identical per-card bars
   * were always showing the exact same number N times over. The header
   * itself is a disclosure toggle -- collapsed by default (state tracked
   * in state.expandedBatches, keyed by batchId) -- individual member
   * cards are a "Show details"-style drill-in, not something shown by
   * default alongside every other clip.
   */
  function buildBatchProgressHeader(members, isExpanded) {
    const first = members[0].job;
    const wrap = document.createElement("div");
    wrap.className = "batch-progress";
    const header = document.createElement("div");
    header.className = "batch-progress-header disclosure-toggle";
    header.setAttribute("role", "button");
    header.setAttribute("tabindex", "0");
    header.setAttribute("aria-expanded", String(isExpanded));
    header.innerHTML =
      '<svg class="chevron" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
      `Batch of ${members.length} - ${jobModel.STATUS_LABELS[first.status] || first.status}`;
    wrap.appendChild(header);
    const percent = computeProgressPercent(first);
    if (percent !== null) {
      wrap.appendChild(buildProgressRow(percent, `batchProgress-${first.batchId}`));
    }
    return { wrap, header };
  }

  // Fast path: if this clip's details panel is already in the DOM, append
  // the new line directly instead of waiting for the next full re-render
  // (which only happens on status changes, not on every log line -- upload
  // progress alone can log many lines per job).
  function appendLiveLogLine(jobId, message, cls) {
    const container = document.getElementById(`clipLog-${jobId}`);
    if (!container) return;
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = message;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }

  function statusDotClass(status) {
    if (status === "inserted") return "dot-done";
    if (status === "failed") return "dot-bad";
    if (status === "canceled") return "dot-dim";
    return "dot-warn";
  }

  /*
   * Phase 5 (round 2): "current run" is exactly the batch of jobIds from
   * the most recent Confirm & Process click (state.currentBatchJobIds,
   * populated below in wireProcessSection's confirm handler, and extended
   * whenever the user retries an older job from Past Productions).
   * Everything else -- including a job that's still `live` from an earlier
   * click this same session -- renders in Past Productions instead, so
   * repeated testing/use doesn't pile jobs up in "Your Clips" forever.
   * queueModule.loadHistory() itself is untouched; this is purely which of
   * its loaded entries render in which of the two lists.
   */
  function isCurrentRunEntry(entry) {
    return state.currentBatchJobIds.has(entry.job.jobId);
  }

  // Plain-language facts pulled straight off the persisted job record, for
  // a card's "Show details" panel when there's no live log to show (a job
  // from a past session that was never processed this run).
  function buildJobFactLines(job) {
    const lines = [];
    const preset = state.presets.find((p) => p.uuid === job.presetUuid);
    lines.push(`Preset: ${preset ? preset.preset_name : job.presetUuid || "unknown"}`);
    if (job.labelColor && job.labelColor !== "none") {
      lines.push(`Label color: ${labelColorDisplayName(job.labelColor)}`);
    }
    if (job.extraFormats && job.extraFormats.length > 0) {
      lines.push(`Extra formats: ${job.extraFormats.join(", ").toUpperCase()}`);
    }
    if (job.productionId) lines.push(`Production: ${job.productionId}`);
    if (job.createdAt) lines.push(`Created: ${new Date(job.createdAt).toLocaleString()}`);
    if (job.outputCachePath) lines.push(`Output file: ${job.outputCachePath}`);
    return lines;
  }

  function buildClipCard(entry) {
    const { job, live } = entry;
    const jobId = job.jobId;

    const card = document.createElement("div");
    card.className = "clip-card";
    if (job.batchId) card.classList.add("batch-member");

    const row = document.createElement("div");
    row.className = "clip-card-row";

    const dot = document.createElement("span");
    dot.className = `status-dot ${statusDotClass(job.status)}`;
    row.appendChild(dot);

    const name = document.createElement("span");
    name.className = "clip-name";
    name.textContent = job.originalClipName;
    row.appendChild(name);

    const statusLabel = document.createElement("span");
    statusLabel.className = "clip-status-label";
    statusLabel.textContent = jobModel.STATUS_LABELS[job.status] || job.status;
    row.appendChild(statusLabel);

    card.appendChild(row);

    // Combined progress across the whole pipeline (queued through
    // placing) -- see STAGE_PROGRESS above. Only while a job is actually
    // in flight; a terminal job's status label already says everything.
    // A batch member gets none of its own -- its shared batchProgress row
    // (built once per batch, see buildBatchProgressHeader) covers it instead,
    // since every member's status changes together anyway.
    if (!job.batchId && !["inserted", "failed", "canceled"].includes(job.status)) {
      const percent = computeProgressPercent(job);
      if (percent !== null) card.appendChild(buildProgressRow(percent, `clipProgress-${jobId}`));
    }

    if (job.status === "failed" && job.errorMessage) {
      const detail = document.createElement("div");
      detail.className = "bad clip-card-note";
      detail.textContent = shortErrorSummary(job.errorMessage);
      card.appendChild(detail);
    }
    if (!live && job.productionId && !["inserted", "failed", "canceled"].includes(job.status)) {
      const warning = document.createElement("div");
      warning.className = "warn clip-card-note";
      warning.textContent =
        "This clip may already have an Auphonic production in progress - check auphonic.com before reprocessing it.";
      card.appendChild(warning);
    }

    // "Show details" -- collapsed by default, on every card (a past job
    // with no live log lines still has a persisted job record worth
    // showing, so this no longer only appears when there happens to be a
    // log or a failure -- see buildJobFactLines below for that fallback).
    {
      const isExpanded = Boolean(state.expandedClips[jobId]);
      const toggle = document.createElement("div");
      toggle.className = "disclosure-toggle small";
      toggle.setAttribute("role", "button");
      toggle.setAttribute("tabindex", "0");
      toggle.setAttribute("aria-expanded", String(isExpanded));
      toggle.innerHTML =
        '<svg class="chevron" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
        (isExpanded ? "Hide details" : "Show details");
      const details = document.createElement("div");
      details.className = "clip-card-details" + (isExpanded ? "" : " hidden");
      const log = document.createElement("div");
      log.className = "log";
      log.id = `clipLog-${jobId}`;
      const logLines = state.clipLogs[jobId] || [];
      if (job.status === "failed" && job.errorMessage) {
        const fullLine = document.createElement("div");
        fullLine.className = "bad";
        fullLine.textContent = job.errorCategory
          ? `${job.errorCategory}: ${job.errorMessage}`
          : job.errorMessage;
        log.appendChild(fullLine);
      }
      logLines.forEach(({ message, cls }) => {
        const line = document.createElement("div");
        if (cls) line.className = cls;
        line.textContent = message;
        log.appendChild(line);
      });
      // No live log lines (e.g. a job loaded from a past session, never
      // processed this run) -- fall back to the persisted job record's
      // own facts instead of leaving the panel empty.
      if (logLines.length === 0 && !(job.status === "failed" && job.errorMessage)) {
        buildJobFactLines(job).forEach((text) => {
          const line = document.createElement("div");
          line.className = "dim";
          line.textContent = text;
          log.appendChild(line);
        });
      }
      details.appendChild(log);
      onActivate(toggle, () => {
        const nowExpanded = !state.expandedClips[jobId];
        state.expandedClips[jobId] = nowExpanded;
        toggle.setAttribute("aria-expanded", String(nowExpanded));
        toggle.innerHTML =
          '<svg class="chevron" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>' +
          (nowExpanded ? "Hide details" : "Show details");
        details.classList.toggle("hidden", !nowExpanded);
      });
      card.appendChild(toggle);
      card.appendChild(details);
    }

    const actions = document.createElement("div");
    actions.className = "clip-card-actions";

    if (live && queueModule.CANCELABLE_STATUSES.includes(job.status)) {
      const cancelBtn = makeBtn("btn btn-secondary", "Cancel");
      onActivate(cancelBtn, async () => {
        await queueModule.cancelJob(entry);
        renderClipsList();
      });
      actions.appendChild(cancelBtn);
    }

    if (live && job.status === "failed") {
      const retryBtn = makeBtn("btn btn-secondary", "Retry");
      onActivate(retryBtn, async () => {
        setBtnDisabled(retryBtn, true);
        // Retrying (even from Past Productions) makes it "current" again --
        // and if it's a consolidated batch member whose shared work never
        // completed, retryJob resets every failed sibling too, so promote
        // the whole batch, not just the card that was clicked.
        queueModule
          .getEntries()
          .filter((e) => (job.batchId ? e.job.batchId === job.batchId : e.job.jobId === job.jobId))
          .forEach((e) => state.currentBatchJobIds.add(e.job.jobId));
        await queueModule.retryJob(entry, state.apiKey, queueHooks());
        renderClipsList();
      });
      actions.appendChild(retryBtn);
    }

    if (job.productionId) {
      const openBtn = makeBtn("btn btn-secondary", "Open in Auphonic");
      onActivate(openBtn, () => uxp.shell.openExternal(buildProductionUrl(job.productionId)));
      actions.appendChild(openBtn);
    }

    if (!live && !["inserted", "failed", "canceled"].includes(job.status)) {
      const dismissBtn = makeBtn("btn btn-secondary", "Dismiss");
      onActivate(dismissBtn, async () => {
        const project = await ppro.Project.getActiveProject();
        await queueModule.dismissHistoryEntry(project, entry);
        renderClipsList();
      });
      actions.appendChild(dismissBtn);
    }

    if (actions.children.length > 0) card.appendChild(actions);

    return card;
  }

  /*
   * Phase 5 (round 2): queueModule.loadHistory() loads every past job into
   * memory same as always -- "Your Clips" only ever showed the current-run
   * subset (isCurrentRunEntry), and everything else was simply never
   * rendered anywhere. This renders that other half into its own
   * collapsed-by-default "Past Productions" list instead, reusing the same
   * buildClipCard -- a past entry is always !live, so it naturally gets
   * just a plain status line and, if it has one, an "Open in Auphonic"
   * button; no Cancel/Retry/Dismiss ever renders for it, same as before.
   */
  // Past Productions only shows this many most-recent PRODUCTIONS (a
  // consolidated batch counts as one, not one per member) by default --
  // queueModule.loadHistory() itself still loads everything, this is
  // purely a display cap so the list doesn't grow without bound the
  // longer this panel stays open across many sessions.
  const PAST_PRODUCTIONS_LIMIT = 15;

  // Groups entries into one item per production (a batch's members
  // collapse into a single group keyed by its shared batchId; a solo job
  // is its own group of one), each carrying the most recent createdAt
  // among its members so the groups can be sorted newest-first and capped
  // without ever splitting one batch's cards across the cutoff.
  function groupIntoProductions(entries) {
    const groups = [];
    const seenBatchIds = new Set();
    entries.forEach((entry) => {
      const batchId = entry.job.batchId;
      if (batchId) {
        if (seenBatchIds.has(batchId)) return;
        seenBatchIds.add(batchId);
        const members = entries.filter((e) => e.job.batchId === batchId);
        const newest = members.reduce(
          (max, e) => (e.job.createdAt > max ? e.job.createdAt : max),
          members[0].job.createdAt || ""
        );
        groups.push({ sortKey: newest, entries: members });
      } else {
        groups.push({ sortKey: entry.job.createdAt || "", entries: [entry] });
      }
    });
    return groups;
  }

  // Appends each entry's card into container, inserting one shared
  // batchProgress row right before the first member of each batchId
  // encountered -- entries within one batch are always contiguous in
  // practice (enqueueConsolidated adds them together), but this groups
  // correctly even if that ever weren't true.
  function appendEntriesWithBatchProgress(container, entries) {
    const renderedBatchIds = new Set();
    entries.forEach((entry) => {
      const batchId = entry.job.batchId;
      if (!batchId) {
        container.appendChild(buildClipCard(entry));
        return;
      }
      if (renderedBatchIds.has(batchId)) return;
      renderedBatchIds.add(batchId);

      const members = entries.filter((e) => e.job.batchId === batchId);
      const isExpanded = Boolean(state.expandedBatches[batchId]);
      const { wrap, header } = buildBatchProgressHeader(members, isExpanded);

      const membersWrap = document.createElement("div");
      membersWrap.className = "batch-members" + (isExpanded ? "" : " hidden");
      members.forEach((member) => membersWrap.appendChild(buildClipCard(member)));

      onActivate(header, () => {
        const nowExpanded = !state.expandedBatches[batchId];
        state.expandedBatches[batchId] = nowExpanded;
        header.setAttribute("aria-expanded", String(nowExpanded));
        membersWrap.classList.toggle("hidden", !nowExpanded);
      });

      container.appendChild(wrap);
      container.appendChild(membersWrap);
    });
  }

  function renderClipsList() {
    const allEntries = queueModule.getEntries();

    const current = allEntries.filter(isCurrentRunEntry);
    const list = el("clipsList");
    list.innerHTML = "";
    if (current.length === 0) {
      hide("clipsSection");
    } else {
      show("clipsSection");
      appendEntriesWithBatchProgress(list, current);
    }

    const past = allEntries.filter((entry) => !isCurrentRunEntry(entry));
    const pastList = el("pastProductionsList");
    pastList.innerHTML = "";
    if (past.length === 0) {
      hide("pastProductionsSection");
    } else {
      show("pastProductionsSection");
      const pastGroups = groupIntoProductions(past).sort((a, b) => (b.sortKey > a.sortKey ? 1 : -1));
      const visibleGroups = pastGroups.slice(0, PAST_PRODUCTIONS_LIMIT);
      const hiddenCount = pastGroups.length - visibleGroups.length;
      appendEntriesWithBatchProgress(pastList, visibleGroups.flatMap((g) => g.entries));
      if (hiddenCount > 0) {
        const note = document.createElement("div");
        note.className = "dim past-productions-note";
        note.textContent = `+ ${hiddenCount} older production${hiddenCount === 1 ? "" : "s"} not shown.`;
        pastList.appendChild(note);
      }
    }
  }

  async function wireProcessSection() {
    await wireExtraFormatsSection();
    await wireConsolidateSection();
    onActivate("checkSelectionBtn", checkSelection);
    onActivate("confirmBtn", async () => {
      if (!state.pendingUnits || state.pendingUnits.length === 0) return;
      const project = state.pendingUnits[0].project;
      const apiKey = state.apiKey;
      setBtnDisabled("confirmBtn", true);
      try {
        const newEntries = state.consolidating
          ? await queueModule.enqueueConsolidated(project, state.pendingUnits)
          : await queueModule.enqueue(project, state.pendingUnits);
        // This click's own jobs are the new "current run" -- replaces
        // whatever an earlier click left staged, so Your Clips always
        // reflects the batch just confirmed rather than accumulating.
        state.currentBatchJobIds = new Set(newEntries.map((e) => e.job.jobId));
        state.pendingUnits = [];
        state.consolidating = false;
        hide("estimateBox");
        renderClipsList();
        await queueModule.runQueue(project, apiKey, queueHooks());
      } finally {
        setBtnDisabled("confirmBtn", false);
      }
    });
  }

  /* ------------------------------------------------------------------ cache */

  function wireDisclosure(toggleId, panelId) {
    onActivate(toggleId, () => {
      const isOpen = !el(panelId).classList.contains("hidden");
      el(panelId).classList.toggle("hidden", isOpen);
      el(toggleId).setAttribute("aria-expanded", String(!isOpen));
    });
  }

  function wireCacheSection() {
    wireDisclosure("advancedToggle", "advancedPanel");

    onActivate("revealCacheBtn", async () => {
      const result = await cache.revealCacheFolder();
      setHtml(
        "cacheStatus",
        result.opened
          ? '<span class="ok">Opened.</span>'
          : `<span class="dim">Cache folder: ${result.path}</span>`
      );
    });

    onActivate("cleanFailedBtn", async () => {
      const project = await ppro.Project.getActiveProject();
      const count = await cache.cleanFailedTempExports(project);
      setHtml("cacheStatus", `<span class="ok">Removed temp files from ${count} failed job file(s).</span>`);
    });

    onActivate("cleanCompletedBtn", async () => {
      const project = await ppro.Project.getActiveProject();
      const count = await cache.deleteCompletedInputTemps(project);
      setHtml("cacheStatus", `<span class="ok">Deleted ${count} completed job's input temp file(s).</span>`);
    });
  }

  /* --------------------------------------------------------------- bugs */

  // No new backend for this -- just opens the editor's own mail client via
  // mailto: (same uxp.shell.openExternal mechanism already used for "Open
  // in Auphonic"), pre-filled with a plain-language template plus a little
  // technical context. "mailto" was added to manifest.json's launchProcess
  // schemes (previously "https" only) so this is allowed to open at all.
  function buildBugReportMailto() {
    let platform = "unknown";
    try {
      platform = navigator.platform || navigator.userAgent || "unknown";
    } catch (e) {
      // Non-fatal -- the report still works without this line.
    }
    const subject = "Awwphonic bug report";
    const body =
      "What happened?\n(describe the issue here)\n\n" +
      "What were you trying to do?\n(describe here)\n\n" +
      "--\n" +
      `Plugin version: ${PLUGIN_VERSION}\n` +
      `Platform: ${platform}`;
    return `mailto:${BUG_REPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function wireBugReportSection() {
    onActivate("reportBugBtn", () => {
      uxp.shell.openExternal(buildBugReportMailto());
    });
  }

  async function init() {
    wireAccountSection();
    await wireProcessSection();
    await wireLabelColorSection();
    wireCacheSection();
    wireDisclosure("pastProductionsToggle", "pastProductionsPanel");
    wireBugReportSection();
    await tryAutoConnect();
    try {
      const project = await ppro.Project.getActiveProject();
      if (project) {
        await queueModule.loadHistory(project);
        renderClipsList();
      }
    } catch (e) {
      // Non-fatal -- history is a bonus; the panel still works without it.
    }
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.panel = { init };
})();
