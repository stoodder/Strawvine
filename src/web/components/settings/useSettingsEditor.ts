/**
 * The one save path for the settings document, shared by Settings and Program: every edit is
 * validated with the server's own schema before it leaves the device (a bad value becomes a
 * readable message instead of a rejected save), then goes through `useSaveSettings` (the outbox:
 * debounce, sync, conflict merge).
 */
import { useRef, useState } from "react";
import { trainingPrefs } from "../../../shared/defaults";
import { editPlan, planById, type PlanFields } from "../../../shared/plans";
import { settingsSchema, type Plan, type Program, type Settings } from "../../../shared/schemas";
import { fmt } from "../../lib/format";
import { useData, useSaveSettings } from "../../lib/store";
import { liveSettings, useSettingsUndo, type SettingsUndo } from "./undo";

/** Human names for settings paths, so a rejected save reads "Steps target …", not "targets.steps: …". */
const PATH_NAMES: Array<[RegExp, string]> = [
  [/^(program\.earlierPlans\.\d+\.)?targets\.steps/, "Steps target"],
  [/^(program\.earlierPlans\.\d+\.)?targets\.zone2Minutes/, "Zone 2 minutes"],
  [/^program\.earlierPlans\.\d+\.name/, "Program name"],
  [/^program\.earlierPlans\.\d+\.weeks\.(\d+)/, "Week $1"],
  [/^program\.earlierPlans\.\d+\.weeks/, "Cycle weeks"],
  [/^program\.earlierPlans\.\d+\.days/, "Weekly layout"],
  [/^program\.earlierPlans\.\d+\.(start|end)/, "Cycle start date"],
  [/^nutrition\.proteinGPerLb/, "Protein"],
  [/^nutrition\.fatGPerLb/, "Fat"],
  [/^nutrition\.initialTdee/, "Maintenance estimate"],
  [/^nutrition\.kcalPerLb/, "Calories per lb"],
  [/^limits\.maxLoss/, "Max loss"],
  [/^limits\.maxGain/, "Max gain"],
  [/^limits\.minCalories/, "Minimum calories"],
  [/^program\.name/, "Program name"],
  [/^program\.intensity/, "Working weight"],
  [/^program\.roundToLb/, "Rounding"],
  [/^program\.progression/, "Per extra rep"],
  [/^program\.deloadAccessoryLoad/, "Deload accessories"],
  [/^program\.repMaxPct/, "Rep-max table"],
  [/^program\.weeks\.(\d+)/, "Week $1"],
  [/^program\.weeks/, "Cycle weeks"],
  [/^program\.days/, "Weekly layout"],
  [/^program\.cycleStartDate/, "Cycle start date"],
  [/^training\.restSecondsMain/, "Main lift rest"],
  [/^training\.restSecondsAccessory/, "Accessory rest"],
  [/^training\.accessoryIncrementLb/, "Accessory increment"],
];

/** A readable sentence for a schema issue. */
export function readableIssue(issue: { path: PropertyKey[]; code: string; message: string } & Record<string, unknown>): string {
  const path = issue.path.join(".");
  let name = "That value";
  for (const [re, label] of PATH_NAMES) {
    const m = path.match(re);
    if (m) {
      name = label.replace("$1", String(Number(m[1] ?? 0) + 1));
      break;
    }
  }
  if (issue.code === "too_big" && typeof issue.maximum === "number")
    return `${name} can be at most ${fmt(issue.maximum, 2).replace(/\.?0+$/, "")}.`;
  if (issue.code === "too_small" && typeof issue.minimum === "number")
    return `${name} must be at least ${fmt(issue.minimum, 2).replace(/\.?0+$/, "")}.`;
  if (issue.code === "invalid_type") return `${name} needs a number.`;
  return `${name}: ${issue.message.toLowerCase()}.`;
}

export type TrainingPrefs = ReturnType<typeof trainingPrefs>;

/** An Undo for a change of one plan (see `SettingsUndo`), in the plan's own terms. */
export interface PlanUndo<T = undefined> extends Omit<SettingsUndo<T>, "undo" | "holdsCycleCelebrations"> {
  /**
   * The plan's fields to put back, from the plan as it is when Undo is tapped; null when the change
   * can't be undone any more (or the plan is gone).
   */
  undo: (now: Plan, from: T) => Partial<PlanFields> | null;
}

export function useSettingsEditor() {
  const { data, today } = useData();
  const saveSettings = useSaveSettings();
  const settings = data.settings;
  /** The last rejected save, as a sentence for the screen's alert (null once a save goes through). */
  const [error, setError] = useState<string | null>(null);
  // A patch applies to the settings as they are when it runs (`liveSettings`): two edits in one
  // tick, or one arriving from another device, must not be undone by a copy from the last render.
  const rendered = useRef(settings);
  rendered.current = settings;
  const live = () => liveSettings(rendered.current);

  /** Saves the whole document; false (with `error` set) when the schema refuses it. */
  const save = (next: Settings): boolean => {
    // Validate here with the server's own schema, so a bad value never leaves the device.
    const r = settingsSchema.safeParse(next);
    if (!r.success) {
      setError(readableIssue(r.error.issues[0] as unknown as Parameters<typeof readableIssue>[0]));
      return false;
    }
    setError(null);
    saveSettings(next).catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't save."));
    return true;
  };
  const setProgram = (p: Partial<Program>) => {
    const now = live();
    return save({ ...now, program: { ...now.program, ...p } });
  };
  const setTraining = (t: Partial<TrainingPrefs>) => {
    const now = live();
    return save({ ...now, training: { ...trainingPrefs(now), ...t } });
  };
  const raiseUndo = useSettingsUndo(save, () => rendered.current);
  /**
   * A change of the document with an Undo toast: `change` gets the settings as they are now and
   * returns the document to save (null: nothing to do). False when nothing was saved (no toast then).
   */
  const undoableSettings = <T = undefined>(change: (now: Settings) => Settings | null, u: SettingsUndo<T>): boolean => {
    const next = change(live());
    if (!next || !save(next)) return false;
    raiseUndo<T>(u);
    return true;
  };

  /**
   * One plan's fields (SPEC §6.4), on the plan as it is when the edit runs (a next plan set up for
   * the end of this cycle stays there when this cycle's weeks change: `editPlan`); false when it
   * wasn't saved.
   */
  const setPlan = (id: string, patch: Partial<PlanFields>): boolean => {
    const now = live();
    if (!planById(now, id)) return false;
    const edit = editPlan(now, id, patch, today);
    if (edit.refused) {
      setError(edit.refused);
      return false;
    }
    return save(edit.settings);
  };
  /** A change of one plan with an Undo toast (`PlanUndo`); false when the change wasn't saved. */
  const undoablePlan = <T = undefined>(id: string, patch: Partial<PlanFields>, u: PlanUndo<T>): boolean => {
    if (!setPlan(id, patch)) return false;
    raiseUndo<T>({
      ...u,
      // The weeks of a plan decide where its cycles fall.
      holdsCycleCelebrations: true,
      undo: (now, from) => {
        const plan = planById(now, id);
        const back = plan && u.undo(plan, from);
        if (!back) return null;
        const edit = editPlan(now, id, back, today);
        return edit.refused ? null : edit.settings;
      },
    });
    return true;
  };

  return {
    settings,
    training: trainingPrefs(settings),
    error,
    save,
    setProgram,
    setTraining,
    undoableSettings,
    setPlan,
    undoablePlan,
  };
}
