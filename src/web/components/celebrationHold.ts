/**
 * "Cycle N complete" is derived from the program's cycle start and length, so a program change
 * can make one appear — and its Undo makes it go away again. While such an Undo is still on
 * offer, Celebrations (components/Celebrations.tsx) leaves cycle achievements alone: it neither
 * shows them nor files them as seen (a seen mark is stored on the server and can't be taken
 * back, so the cycle's real completion would never be celebrated).
 */

/** Achievement keys that depend on where the cycles fall (`cycle-<n>`, src/shared/gamify.ts). */
export const isCycleAchievement = (key: string) => key.startsWith("cycle-");

/**
 * How long after the Undo is gone the hold lasts: an Undo that was tapped has saved by then, and
 * the achievements derived from it have caught up.
 */
export const HOLD_GRACE_MS = 1000;

let holds = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of [...listeners]) l();
};

export const cycleCelebrationsHeld = () => holds > 0;
export function subscribeCelebrationHold(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/**
 * Holds cycle celebrations until the returned function is called (when the Undo's toast has
 * gone) and `HOLD_GRACE_MS` more have passed. Calling it twice releases once.
 */
export function holdCycleCelebrations(): () => void {
  holds++;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    window.setTimeout(() => {
      holds--;
      emit();
    }, HOLD_GRACE_MS);
  };
}
