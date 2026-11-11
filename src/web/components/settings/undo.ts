/**
 * Undo for a settings change, from a toast — shared by Program / Settings (`useSettingsEditor`)
 * and Goals.
 *
 * The settings are one document, saved whole, and a toast outlives the screen that raised it
 * (7 s, longer while it has focus): by the time Undo is tapped the person may be on another
 * screen, or another device may have saved. So an Undo never puts back a document it remembered.
 * It reads the settings as they are at that moment (`liveSettings`) and changes only its own
 * fields on them — or declines, when what it would undo isn't there any more.
 */
import { useCallback, useRef } from "react";
import type { Settings } from "../../../shared/schemas";
import { currentData } from "../../lib/sync";
import { holdCycleCelebrations } from "../celebrationHold";
import { useToast } from "../Toast";
import { useFocusAfter } from "../useFocusAfter";

/** How long an Undo stays on offer, and so how long consecutive changes fold into one toast. */
export const UNDO_MS = 7000;
export const CANT_UNDO = "Can't undo: it was changed again since.";

/**
 * The settings as they are right now: this device's copy with every unsynced edit on top — the
 * same thing the screens render, read without waiting for one to render. `fallback` only covers
 * the moment before any data exists.
 */
export function liveSettings(fallback: Settings): Settings {
  return currentData()?.settings ?? fallback;
}

type FocusTarget = Parameters<ReturnType<typeof useFocusAfter>>[0];

export interface SettingsUndo<T = undefined> {
  /** The toast's words. `from` is where Undo goes back to (see `fold`). */
  message: string | ((from: T) => string);
  /**
   * The document Undo saves: `now` (the settings when Undo is tapped) with this change's own
   * fields put back. null when it can't be undone any more — the toast says so and saves nothing.
   */
  undo: (now: Settings, from: T) => Settings | null;
  /**
   * Consecutive changes of one thing (a slider nudged twice, a start date moved week by week)
   * share a `key`: while the earlier toast is still on offer the new one replaces it, and its
   * Undo goes back to the first one's `before`. A change that ends up back there (`after` equals
   * it) leaves nothing to undo: no toast — so a change that puts things back by hand (`after`
   * equal to its own `before`) simply withdraws the toast on offer.
   */
  fold?: { key: string; before: T; after: T };
  /** Said instead of undoing, when `undo` returns null. */
  cantUndo?: string;
  /** Where focus goes after Undo (the toast's button is gone by then): the control that was undone. */
  focus?: FocusTarget;
  /** The change moves the cycles: "Cycle N complete" waits while the Undo is on offer (`celebrationHold`). */
  holdsCycleCelebrations?: boolean;
}

/**
 * Returns `raise(undo)`: shows the Undo toast for a change that has just been saved. `save` gets
 * the document Undo produces; `fallback` is the screen's own copy of the settings (see `liveSettings`).
 */
export function useSettingsUndo(save: (next: Settings) => unknown, fallback: () => Settings) {
  const toast = useToast();
  const focusAfter = useFocusAfter();
  // The toast calls whatever these are when Undo is tapped (the last ones, once the screen is gone).
  const fns = useRef({ save, fallback });
  fns.current = { save, fallback };
  const open = useRef(new Map<string, { id: number; from: unknown; at: number }>());

  return useCallback(
    <T = undefined>(u: SettingsUndo<T>): void => {
      const at = Date.now();
      let from = u.fold?.before as T;
      const key = u.fold?.key;
      if (u.fold && key !== undefined) {
        const prev = open.current.get(key);
        open.current.delete(key);
        if (prev && at - prev.at < UNDO_MS) {
          toast.dismiss(prev.id);
          from = prev.from as T;
        }
        if (Object.is(u.fold.after, from)) return; // back where it started: nothing to undo
      }
      const id = toast.show({
        message: typeof u.message === "function" ? u.message(from) : u.message,
        duration: UNDO_MS,
        onClose: u.holdsCycleCelebrations ? holdCycleCelebrations() : undefined,
        action: {
          label: "Undo",
          onAction: () => {
            if (key !== undefined && open.current.get(key)?.id === id) open.current.delete(key);
            const next = u.undo(liveSettings(fns.current.fallback()), from);
            if (next === null) toast.show({ message: u.cantUndo ?? CANT_UNDO, tone: "warn" });
            else fns.current.save(next);
            if (u.focus) focusAfter(u.focus);
          },
        },
      });
      if (key !== undefined) open.current.set(key, { id, from, at });
    },
    [toast, focusAfter],
  );
}
