/*
 * Billing math (PRD 9.7). Nothing here uploads anything -- this is shown to
 * the user and requires explicit confirmation before the first byte goes
 * anywhere (PRD principle #2 and #5).
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. No local dependencies. Published on
 * window.Auphonic.costEstimate.
 */
(function () {
  const BILLABLE_MINIMUM_SECONDS = 3 * 60;
  const LONG_CLIP_WARNING_SECONDS = 5 * 60;

  function formatDuration(seconds) {
    const whole = Math.round(seconds);
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
  }

  /*
   * durationSeconds should already include handles when handles are enabled
   * (Phase 2) -- Phase 1 always passes the plain clip duration.
   */
  function estimate({ durationSeconds, availableCreditsHours }) {
    const billableSeconds = Math.max(durationSeconds, BILLABLE_MINIMUM_SECONDS);
    const billableHours = billableSeconds / 3600;
    const warnings = [];

    if (billableSeconds > durationSeconds) {
      warnings.push(
        `Auphonic bills a 3-minute minimum per production. This clip is ${formatDuration(
          durationSeconds
        )}, so it will be billed as ${formatDuration(billableSeconds)}.`
      );
    }
    if (durationSeconds > LONG_CLIP_WARNING_SECONDS) {
      warnings.push(`This is a long clip (${formatDuration(durationSeconds)}) -- double-check it's the one you meant to select.`);
    }
    if (typeof availableCreditsHours === "number" && billableHours > availableCreditsHours) {
      warnings.push(
        `Estimated billable time is ${formatDuration(billableSeconds)}, which is more than your available credits ` +
          `(${availableCreditsHours.toFixed(2)}h). This job may fail or not start.`
      );
    }

    return { durationSeconds, billableSeconds, billableHours, warnings, formatDuration };
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.costEstimate = { estimate, formatDuration, BILLABLE_MINIMUM_SECONDS, LONG_CLIP_WARNING_SECONDS };
})();
