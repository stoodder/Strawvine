import { useRef } from "react";

/**
 * A done check that does what the finger meant (Metcon and Zone 2 on Train, Today's checklist rows).
 *
 * A field being typed in saves as it is left — and a tap on the check leaves it: its blur commit
 * (minutes typed, notes written) can tick the section off *before* the check's click arrives, and a
 * plain toggle would then untick what the person meant to tick. So the value the check sets is
 * decided when the finger lands (`pointerdown`, before any blur), from the day as it is then
 * (`isDone`, read live), and applied as a value, not a toggle: `take()` says it, and the caller
 * writes it only if the day doesn't already say so (idempotent). Either order works — a blur first
 * (desktop, Android) or the click first with the field still focused (iOS: a tap on a button
 * doesn't move focus).
 *
 * Keyboard activation (Enter / Space: a click with no pointerdown) decides at the click itself; a
 * key press drops a decision a pointer left behind (a press that never became a click).
 *
 * Spread `capture` on an element around the check (its events bubble through it).
 */
export function useCheckIntent(isDone: () => boolean) {
  const pending = useRef<boolean | null>(null);
  const drop = () => {
    pending.current = null;
  };
  return {
    capture: {
      onPointerDownCapture: () => {
        pending.current = !isDone();
      },
      onPointerCancelCapture: drop,
      onKeyDownCapture: drop,
    },
    /** The value the check sets now: decided at pointerdown, else (the keyboard) now. Consumes the decision. */
    take: (): boolean => {
      const want = pending.current ?? !isDone();
      pending.current = null;
      return want;
    },
  };
}
