/**
 * How far a lift's current max is toward a strength target (SPEC §5): what the target's bar and
 * its "N lb to go" line show. Display only — whether a target was *hit* (and celebrated) is
 * decided by `achievements` in gamify.ts, from the max entries since the target was set.
 */
export interface TargetProgress {
  /** The lift's current max (0 without one). */
  currentLb: number;
  targetLb: number;
  /** The current max is at or above the target. */
  reached: boolean;
  /** 0…1 of the way there. */
  fraction: number;
  /** What is left (0 once reached). */
  toGoLb: number;
}

export function targetProgress(targetLb: number, currentMaxLb: number | null | undefined): TargetProgress {
  const currentLb = currentMaxLb ?? 0;
  const reached = currentLb >= targetLb;
  return {
    currentLb,
    targetLb,
    reached,
    fraction: targetLb > 0 ? Math.max(0, Math.min(1, currentLb / targetLb)) : 0,
    toGoLb: reached ? 0 : targetLb - currentLb,
  };
}
