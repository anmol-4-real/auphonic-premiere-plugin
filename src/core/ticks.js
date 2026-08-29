/*
 * Shared tick-arithmetic helpers (Phase 2). Collision detection, handles
 * clamping, and linked-audio resolution all need the same two primitives --
 * centralized here instead of three slightly-different copies, which is
 * exactly the kind of drift that caused Phase 1's media-type bug (see
 * HANDOFF.md bug #2: two subtly different position-matching checks disagreed
 * on what a "match" was).
 *
 * Loaded as a plain <script> tag -- see the note at the top of
 * lib/secureStorage.js for why. No local dependencies. Published on
 * window.Auphonic.ticks.
 */
(function () {
  /*
   * .ticksNumber is confirmed live as a plain number property (HANDOFF.md).
   * Falls back to .seconds only for objects that don't expose ticksNumber at
   * all -- kept for defensiveness, not because it's been needed yet.
   */
  function ticksNumberOf(tickTime) {
    if (!tickTime) return null;
    if (typeof tickTime.ticksNumber === "number") return tickTime.ticksNumber;
    if (typeof tickTime.ticksNumber === "string") return Number(tickTime.ticksNumber);
    if (typeof tickTime.seconds === "number") return tickTime.seconds;
    return null;
  }

  /*
   * Half-open [start, end) overlap test. Two ranges that merely touch (a's
   * end === b's start) do NOT count as overlapping -- matches how adjacent
   * clips are allowed to butt up against each other on a timeline.
   */
  function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
  }

  window.Auphonic = window.Auphonic || {};
  window.Auphonic.ticks = { ticksNumberOf, rangesOverlap };
})();
