/**
 * The choice at the end of a cycle (SPEC §7): keep this plan, or set up a new one — from the
 * end-of-cycle note (Train, Program › Now), from "Cycle N complete", and from Program › Now's "Set
 * up a new plan". The rules are src/shared/plans.ts's; this only saves them, with their toasts.
 *
 * - Keep is what happens anyway: tapping it files `repeat-cycle-N` with the seen achievements (a
 *   set that only grows and syncs by union, so the note never comes back for that cycle, on any
 *   device, whatever a settings merge does), and a toast says so, with a way to change it.
 * - Set up a new plan adds a copy of the plan in force (`startNewCycle`) and goes to Program on it;
 *   its Undo removes the new plan — while it is still exactly the copy that was made. When none can
 *   be set up, a toast says why (`newCycleRefusal`).
 * - Cancelling the new plan (scheduled, or in force with nothing saved under it) removes it; its
 *   Undo puts it back.
 */
import { useLocation, useNavigate } from "react-router";
import { formatShortDate, weekdayName, type ISODate } from "../../../shared/dates";
import {
  cancelPlan,
  cycleEndCard,
  endBefore,
  newCycleRefusal,
  planById,
  removeNewPlan,
  repeatCycleKey,
  restorePlan,
  startNewCycle,
  type NewCycleOptions,
} from "../../../shared/plans";
import { cyclePosition } from "../../../shared/program";
import type { Plan } from "../../../shared/schemas";
import { newId } from "../../../shared/session";
import { useData, useMarkSeen } from "../../lib/store";
import { currentData } from "../../lib/sync";
import { useSettingsEditor } from "../settings/useSettingsEditor";
import { useToast } from "../Toast";
import { useFocusAfter } from "../useFocusAfter";
import type { CycleChoice } from "./CycleEndNote";

const day = (date: ISODate) => `${weekdayName(date, true)} ${formatShortDate(date)}`;

/** Where Program's back control may return to (see `programBackTarget`): a Train day or Settings. */
const backTarget = (path: string) => (/^\/(train|settings)/.test(path) ? path : undefined);

/** Program › Now's control to set up a new plan (its own button, or the note's there). */
export const SET_UP_PLAN = "[data-set-up-plan]";

export type CycleActions = Omit<CycleChoice, "card"> & {
  /** Cancels the new plan (with Undo): the plan before it runs on. */
  cancelNext: (plan: Plan) => void;
  /** The feedback of "Keep this plan" (a toast with a way to change it), for the cycle after `cycle`. */
  keptFeedback: (cycle: number) => void;
};

/** The end-of-cycle note for today, with its actions (`useCycleActions`). */
export function useCycleChoice(): CycleChoice & CycleActions {
  const { data, today } = useData();
  return { ...useCycleActions(), card: cycleEndCard(data.settings, data.seenAchievements, today) };
}

/** What can be done about the next cycle: keep the plan, set up a new one, cancel the one set up. */
export function useCycleActions(): CycleActions {
  const { data, today } = useData();
  const { undoableSettings } = useSettingsEditor();
  const markSeen = useMarkSeen();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const focusAfter = useFocusAfter();
  /** Program's state for a link from here: its back control keeps leading where it did. */
  const programState = (extra: Record<string, unknown> = {}) => {
    if (location.pathname === "/program") return { ...((location.state as object | null) ?? {}), ...extra };
    const from = backTarget(location.pathname);
    return { ...(from ? { from } : {}), ...extra };
  };

  const keptFeedback = (cycle: number) => {
    toast.show({
      message: `Cycle ${cycle + 1} keeps this plan`,
      action: { label: "Change", onAction: () => navigate("/program#now", { state: programState() }) },
    });
  };

  const repeat = (cycle: number) => {
    markSeen([repeatCycleKey(cycle)]);
    keptFeedback(cycle);
    // The note goes; focus goes to the screen's heading below it, without scrolling.
    const onProgram = location.pathname === "/program";
    focusAfter(() => document.querySelector<HTMLElement>(onProgram ? "#now [data-section-heading]" : "[data-train-title]"), undefined, {
      preventScroll: true,
    });
  };

  const setUpNewCycle = (opts: NewCycleOptions = {}) => {
    const id = `plan-${newId()}`;
    let made: Plan | null = null;
    let refusal: string | null = null;
    const saved = undoableSettings(
      (now) => {
        // The sessions as they are now, as the settings are (a session saved a moment ago counts).
        const sessions = currentData()?.sessions ?? data.sessions;
        const r = startNewCycle(now, sessions, today, id, opts);
        made = r?.plan ?? null;
        if (!r) refusal = newCycleRefusal(now, sessions, today, opts);
        return r?.settings ?? null;
      },
      {
        message: () => (made ? `New plan set up from ${day(made.start)}` : "New plan set up"),
        undo: (now) => (made ? removeNewPlan(now, id, made) : null),
        cantUndo: "Can't undo: the new plan was changed since.",
        // A new plan decides where later cycles fall: their celebrations wait out the Undo.
        holdsCycleCelebrations: true,
      },
    );
    if (!saved) {
      toast.show({ message: refusal ?? "Couldn't set up a new plan.", tone: "warn" });
      return;
    }
    // Program opens on the new plan (its back control keeps leading where it did).
    navigate("/program#layout", { state: programState({ plan: "next" }) });
  };

  const cancelNext = (plan: Plan) => {
    let cancelled: Plan | null = null;
    let end: ISODate | undefined;
    let cycle = 0;
    undoableSettings(
      (now) => {
        cancelled = planById(now, plan.id);
        end = endBefore(now, plan.id);
        cycle = cancelled ? (cyclePosition(now.program, cancelled.start)?.cycle ?? 0) : 0;
        return cancelPlan(now, plan.id, currentData()?.sessions ?? data.sessions, today);
      },
      {
        message: () => (cycle ? `New plan cancelled — cycle ${cycle} keeps this plan` : "New plan cancelled"),
        undo: (now) => (cancelled ? restorePlan(now, cancelled, end) : null),
        cantUndo: "Can't undo: another plan was set up since.",
        holdsCycleCelebrations: true,
      },
    );
    focusAfter(() => document.querySelector<HTMLElement>(`#now ${SET_UP_PLAN}`), 20, { preventScroll: true });
  };

  return { repeat, setUpNewCycle, cancelNext, keptFeedback };
}
