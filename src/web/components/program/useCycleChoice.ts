/**
 * The choice at the end of a cycle (SPEC §7): repeat the cycle, or set up a new one — from the
 * end-of-cycle note (Train, Program › Now), from "Cycle N complete", and from Program's "Start a new
 * cycle". The rules are src/shared/plans.ts's; this only saves them, with their Undo toasts.
 *
 * - Repeat is what happens anyway: tapping it files `repeat-cycle-N` with the seen achievements (a
 *   set that only grows and syncs by union, so the note never comes back for that cycle, on any
 *   device, whatever a settings merge does).
 * - Set up a new cycle adds a copy of the plan in force (`startNewCycle`) and goes to Program to
 *   change it; its Undo removes the new plan entirely (while it is still the latest).
 * - Cancelling a scheduled next cycle removes it (the cycle repeats); its Undo puts it back.
 */
import { useLocation, useNavigate } from "react-router";
import { formatShortDate, weekdayName, type ISODate } from "../../../shared/dates";
import { cancelPlan, cycleEndCard, removeNewPlan, repeatCycleKey, restorePlan, startNewCycle } from "../../../shared/plans";
import type { Plan } from "../../../shared/schemas";
import { newId } from "../../../shared/session";
import { useData, useMarkSeen } from "../../lib/store";
import { currentData } from "../../lib/sync";
import { useSettingsEditor } from "../settings/useSettingsEditor";
import type { CycleChoice } from "./CycleEndNote";

const day = (date: ISODate) => `${weekdayName(date, true)} ${formatShortDate(date)}`;

/** Where Program's back control may return to (see `programBackTarget`): a Train day or Settings. */
const backTarget = (path: string) => (/^\/(train|settings)/.test(path) ? path : undefined);

/** The end-of-cycle note for today, with its actions (`useCycleActions`). */
export function useCycleChoice(): CycleChoice & { cancelNext: (plan: Plan) => void } {
  const { data, today } = useData();
  return { ...useCycleActions(), card: cycleEndCard(data.settings, data.seenAchievements, today) };
}

/** What can be done about the next cycle: repeat, set one up, cancel the one set up. */
export function useCycleActions(): Omit<CycleChoice, "card"> & { cancelNext: (plan: Plan) => void } {
  const { data, today } = useData();
  const { undoableSettings } = useSettingsEditor();
  const markSeen = useMarkSeen();
  const navigate = useNavigate();
  const location = useLocation();

  const repeat = (cycle: number) => markSeen([repeatCycleKey(cycle)]);

  const setUpNewCycle = () => {
    const id = `plan-${newId()}`;
    let start: ISODate | null = null;
    const saved = undoableSettings(
      (now) => {
        // The sessions as they are now, as the settings are (a session saved a moment ago counts).
        const made = startNewCycle(now, currentData()?.sessions ?? data.sessions, today, id);
        start = made?.plan.start ?? null;
        return made?.settings ?? null;
      },
      {
        message: () => (start ? `New cycle set up from ${day(start)}` : "New cycle set up"),
        undo: (now) => removeNewPlan(now, id),
        cantUndo: "Can't undo: the cycles were changed again since.",
        // A new plan decides where later cycles fall: their celebrations wait out the Undo.
        holdsCycleCelebrations: true,
      },
    );
    if (saved) {
      // On Program already, its back control keeps leading where it did.
      const from = backTarget(location.pathname);
      const state = location.pathname === "/program" ? location.state : from ? { from } : undefined;
      navigate("/program#layout", { state });
    }
  };

  const cancelNext = (plan: Plan) => {
    undoableSettings((now) => cancelPlan(now, plan.id, today), {
      message: "New cycle cancelled — this cycle repeats",
      undo: (now) => restorePlan(now, plan),
      cantUndo: "Can't undo: another cycle was set up since.",
      holdsCycleCelebrations: true,
    });
  };

  return { repeat, setUpNewCycle, cancelNext };
}
