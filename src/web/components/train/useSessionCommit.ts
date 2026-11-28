/**
 * How the Train screen saves a session edit, and offers to undo it: `commit` (the first edit
 * persists a live draft; an Undo reverts only what the edit touched, on the session as it is when
 * Undo is tapped), `offerUndo` (an Undo toast for anything else) and the one Undo toast standing
 * (`retireUndo`). Every section of the day saves through the same `commit`.
 */
import { useEffect, useRef } from "react";
import type { Session } from "../../../shared/schemas";
import { savedAfterEdit, strengthCounts } from "../../../shared/session";
import { cachedSession, useDeleteSession, useSaveSession } from "../../lib/store";
import { useToast } from "../Toast";
import { mapBlock, mapExercise, type ExRef } from "./sessionEdit";

/**
 * A finished session stays consistent with its sets: once no strength set is logged in it any
 * more (an Undo or unlog after Finish; rehab sets don't finish strength), it's open again — unless
 * the main lift was skipped, which may finish with nothing logged.
 */
export const settled = (s: Session): Session =>
  s.completedAt && strengthCounts(s).done === 0 && !s.blocks.some((b) => b.kind === "primary" && b.skipped)
    ? { ...s, completedAt: null }
    : s;

/** An edit's Undo (see `commit`): apply it now, or offer it in a toast. */
export interface UndoHandle {
  run: () => void;
  offer: () => void;
}

/** How an edit can be undone (see `commit`). */
export interface CommitUndo {
  message: string;
  scope?: ExRef | { blockId: string };
  /**
   * Custom revert on top of the latest saved session (instead of `scope`); `saved` is what
   * this edit saved. A string instead says why it can't be undone any more (shown as a toast).
   */
  revert?: (cur: Session, saved: Session) => Session | string;
  duration?: number;
  /** After the Undo is applied: where focus should go (the toast's button is gone). */
  onUndone?: () => void;
  /** false: no toast now (an open sheet offers the undo itself; `offer` shows it later). */
  toast?: boolean;
}

/** Save a session edit (see `useSessionCommit`). */
export type Commit = (edited: Session, undo?: CommitUndo) => UndoHandle | undefined;

export interface SessionCommitInput {
  date: string;
  /** A preview never saves. */
  isPreview: boolean;
  /** The session as saved for the day (null: none yet, the draft is shown). */
  saved: Session | null;
  /** The session as saved, or the live draft. */
  stored: Session;
  /** What the screen shows and edits (`effectiveSession` of `stored`). */
  session: Session;
  /**
   * A sheet is open: it makes the app (and its toasts) inert and the toast would sit over the
   * sheet's buttons, so the last undo offer is retired when one opens.
   */
  sheetOpen: boolean;
}

export function useSessionCommit({ date, isPreview, saved, stored, session, sheetOpen }: SessionCommitInput) {
  const saveSession = useSaveSession();
  const deleteSession = useDeleteSession();
  const toast = useToast();

  // --- Undo toasts --------------------------------------------------------------------------
  const lastToast = useRef<number | null>(null);
  const offerUndo = (message: string, onUndo: () => void, duration = 7000) => {
    if (lastToast.current !== null) toast.dismiss(lastToast.current);
    lastToast.current = toast.show({ message, duration, action: { label: "Undo", onAction: onUndo } });
    return lastToast.current;
  };
  /** Take down the Undo toast standing, if any (it would undo into what comes next). */
  const retireUndo = () => {
    if (lastToast.current !== null) {
      toast.dismiss(lastToast.current);
      lastToast.current = null;
    }
  };

  // A sheet makes the app (and its toasts) inert and the toast would sit over the sheet's
  // buttons: retire the last undo offer when one opens.
  useEffect(() => {
    if (sheetOpen && lastToast.current !== null) {
      toast.dismiss(lastToast.current);
      lastToast.current = null;
    }
  }, [sheetOpen, toast]);

  /**
   * Save a change (the first one persists a draft). With `undo`, offer to revert it: just the
   * touched exercise (or block) when `scope` is given (later edits elsewhere survive), else the
   * whole session. Undoing the only change to a draft drops it back to the live plan.
   * A preview never saves. Returns the undo (it applies once): `run` applies it from elsewhere (an
   * open sheet's own Undo; the toast goes), `offer` shows the toast later (with `toast: false`).
   */
  const commit: Commit = (edited, undo) => {
    if (isPreview) return;
    const before = stored;
    const wasDraft = !saved;
    // Exercises the edit didn't touch are saved as stored: they keep following their exercise.
    const next = settled(savedAfterEdit(edited, session, stored));
    saveSession(next);
    if (!undo) return;
    let used = false;
    let toastId: number | null = null;
    const apply = () => {
      if (used) return;
      used = true;
      const cur = cachedSession(date) ?? next;
      let restored = before;
      const scope = undo.scope;
      if (undo.revert) {
        const r = undo.revert(cur, next);
        if (typeof r === "string") {
          toast.show({ message: r, tone: "warn" });
          return;
        }
        restored = r;
      } else if (scope) {
        const prevBlock = before.blocks.find((b) => b.id === scope.blockId);
        const curBlock = cur.blocks.find((b) => b.id === scope.blockId);
        const same = (i: number) => {
          const p = prevBlock?.exercises[i];
          return p && curBlock?.exercises[i]?.exerciseId === p.exerciseId ? p : null;
        };
        if ("exIdx" in scope) {
          const prevEx = same(scope.exIdx);
          if (prevEx) restored = mapExercise(cur, scope, () => prevEx);
        } else if (prevBlock && curBlock)
          restored = mapBlock(cur, scope.blockId, (b) => ({ ...b, exercises: b.exercises.map((e, i) => same(i) ?? e) }));
      }
      if (wasDraft && JSON.stringify(restored) === JSON.stringify(before)) deleteSession(date);
      else saveSession(settled(restored));
      undo.onUndone?.();
    };
    const offer = () => {
      if (!used) toastId = offerUndo(undo.message, apply, undo.duration);
    };
    if (undo.toast !== false) offer();
    return {
      run: () => {
        if (toastId !== null) {
          toast.dismiss(toastId);
          if (lastToast.current === toastId) lastToast.current = null;
        }
        apply();
      },
      offer,
    };
  };

  return { commit, offerUndo, retireUndo };
}
