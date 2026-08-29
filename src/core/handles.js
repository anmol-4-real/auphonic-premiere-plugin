/*
 * Handles clamp/widen math (PRD 9.6, defaults PRD 12). Pure math and
 * read-only Premiere lookups -- nothing here mutates the project. The
 * actual widened export (which DOES need to touch a disposable scratch
 * item) lives in export.js's exportHandleWidenedRange; this file only
 * decides HOW MUCH handle is actually achievable.
 *
 * Two independent clamps, both from the PRD:
 *   - Left handle only: can't place the clip before sequence tick 0.
 *   - Both sides: can't reach past the real source media's own boundaries.
 *
 * The source-media boundary lookup (ppro.Metadata.getProjectColumnsMetadata
 * with Column.Intrinsic.MediaStart/MediaEnd) is a live-verification item --
 * feature-detected and guarded exactly like checkOptionalFlag in
 * selection.js. If unavailable, the media-boundary clamp is skipped (with a
 * diagnostic, not silently) and only the sequence-start clamp applies.
 *
 * Deliberately does NOT port the frame-rate/timebase-ratio math from Adobe's
 * reference sample (sequence.ts's addHandlesToTrackItem) -- that dance exists
 * only to convert a raw frame count through the correct frame rate. Handle
 * amounts here are already in seconds and converted straight to ticks via
 * ppro.TickTime.createWithSeconds(), which is timebase-agnostic, so no ratio
 * conversion is needed. Flagged for live verification anyway (see HANDOFF.md
 * discipline: every new API assumption gets checked against a real clip
 * before UI is built on top of it).
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. Depends on window.Auphonic.ticks, which must
 * be loaded first. Published on window.Auphonic.handles.
 */
(function () {
  const ppro = require("premierepro");
  const ticks = window.Auphonic.ticks;

  function ticksToSeconds(tickCount) {
    return ppro.TickTime.createWithTicks(String(Math.round(tickCount))).seconds;
  }

  function fmt(tickCount) {
    return ticksToSeconds(tickCount).toFixed(1);
  }

  async function getMediaBoundaryTicks(projectItem, diagnostics) {
    if (!ppro.Metadata || typeof ppro.Metadata.getProjectColumnsMetadata !== "function") {
      diagnostics.push("ppro.Metadata.getProjectColumnsMetadata() not available on this build -- source-media handle clamp skipped.");
      return null;
    }
    try {
      const raw = await ppro.Metadata.getProjectColumnsMetadata(projectItem);
      const columns = JSON.parse(raw);
      let startTicks = null;
      let endTicks = null;
      for (const entry of columns) {
        if (entry.ColumnID === "Column.Intrinsic.MediaStart") startTicks = Number(entry.ColumnValue);
        else if (entry.ColumnID === "Column.Intrinsic.MediaEnd") endTicks = Number(entry.ColumnValue);
        if (startTicks !== null && endTicks !== null) break;
      }
      if (startTicks === null || endTicks === null) {
        diagnostics.push("Media start/end columns not found in project metadata -- source-media handle clamp skipped.");
        return null;
      }
      return { startTicks, endTicks };
    } catch (e) {
      diagnostics.push(`getProjectColumnsMetadata() threw: ${e.message || e} -- source-media handle clamp skipped.`);
      return null;
    }
  }

  /*
   * requestedHandleSeconds <= 0 returns a no-op plan matching exact Phase 1
   * behavior (handles off): the plain clip range, unwidened.
   */
  async function computeHandlePlan({ trackItem, requestedHandleSeconds }) {
    const diagnostics = [];
    const originalStartTime = await trackItem.getStartTime();
    const originalEndTime = await trackItem.getEndTime();

    if (!requestedHandleSeconds || requestedHandleSeconds <= 0) {
      return {
        leftSeconds: 0,
        rightSeconds: 0,
        leftTicks: 0,
        rightTicks: 0,
        widenedStartTime: originalStartTime,
        widenedEndTime: originalEndTime,
        widenedDurationSeconds: originalEndTime.seconds - originalStartTime.seconds,
        clampWarnings: [],
        diagnostics,
      };
    }

    const originalStartTicks = ticks.ticksNumberOf(originalStartTime);
    const originalEndTicks = ticks.ticksNumberOf(originalEndTime);
    const requestedTicks = ticks.ticksNumberOf(ppro.TickTime.createWithSeconds(requestedHandleSeconds));

    const clampWarnings = [];

    // Left handle: clamp 1 -- never precede sequence tick 0.
    let leftTicks = Math.min(requestedTicks, Math.max(0, originalStartTicks));
    if (leftTicks < requestedTicks) {
      clampWarnings.push(
        `Left handle reduced from ${fmt(requestedTicks)}s to ${fmt(leftTicks)}s because that would start before the sequence.`
      );
    }

    // Left handle: clamp 2 -- never exceed the clip's own actual source
    // head-room. Uses trackItem.getInPoint() directly (confirmed reliable,
    // source-relative to media start -- HANDOFF.md) rather than depending on
    // the Metadata lookup below, so a clip with zero untrimmed head-room
    // (e.g. using its source media from the very start) is ALWAYS caught
    // here, even if that lookup fails or is unavailable. Live evidence: an
    // untrimmed clip previously reached export with an uncaught left handle
    // and crashed trying to set a negative in-point -- this clamp can never
    // be skipped, unlike the media-boundary one below.
    const inPointTicks = ticks.ticksNumberOf(await trackItem.getInPoint());
    if (inPointTicks < leftTicks) {
      const before = fmt(leftTicks);
      leftTicks = Math.max(0, inPointTicks);
      clampWarnings.push(`Left handle reduced from ${before}s to ${fmt(leftTicks)}s because source media starts there.`);
    }

    let rightTicks = requestedTicks;

    // Right handle: best-effort clamp against the real source media end,
    // via project metadata -- the one side that genuinely has no simpler
    // proven source of truth. If this lookup is unavailable, export.js's
    // own defensive backoff (it actually attempts the widen and shrinks on
    // failure) is the final safety net, so this being skipped never crashes
    // the export -- it may just estimate a slightly generous right handle
    // here that gets reduced for real at export time.
    const projectItem = await trackItem.getProjectItem();
    const mediaRange = await getMediaBoundaryTicks(projectItem, diagnostics);
    if (mediaRange) {
      const outPointTicks = ticks.ticksNumberOf(await trackItem.getOutPoint());
      const absoluteOutTicks = outPointTicks + mediaRange.startTicks;
      const maxRightFromMedia = Math.max(0, mediaRange.endTicks - absoluteOutTicks);
      if (maxRightFromMedia < rightTicks) {
        const before = fmt(rightTicks);
        rightTicks = maxRightFromMedia;
        clampWarnings.push(`Right handle reduced from ${before}s to ${fmt(rightTicks)}s because source media ends there.`);
      }
    }

    const widenedStartTicks = originalStartTicks - leftTicks;
    const widenedEndTicks = originalEndTicks + rightTicks;
    const widenedStartTime = ppro.TickTime.createWithTicks(String(Math.round(widenedStartTicks)));
    const widenedEndTime = ppro.TickTime.createWithTicks(String(Math.round(widenedEndTicks)));

    return {
      leftSeconds: ticksToSeconds(leftTicks),
      rightSeconds: ticksToSeconds(rightTicks),
      leftTicks,
      rightTicks,
      widenedStartTime,
      widenedEndTime,
      widenedDurationSeconds: widenedEndTime.seconds - widenedStartTime.seconds,
      clampWarnings,
      diagnostics,
    };
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.handles = { computeHandlePlan };
})();
