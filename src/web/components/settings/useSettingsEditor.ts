/**
 * The one save path for the settings document, shared by Settings and Program: every edit is
 * validated with the server's own schema before it leaves the device (a bad value becomes a
 * readable message instead of a rejected save), then goes through `useSaveSettings` (the outbox:
 * debounce, sync, conflict merge).
 */
import { useRef, useState } from "react";
import { trainingPrefs } from "../../../shared/defaults";
import { settingsSchema, type Program, type Settings } from "../../../shared/schemas";
import { fmt } from "../../lib/format";
import { useData, useSaveSettings } from "../../lib/store";
import { useToast } from "../Toast";

/** Human names for settings paths, so a rejected save reads "Steps target …", not "targets.steps: …". */
const PATH_NAMES: Array<[RegExp, string]> = [
  [/^targets\.steps/, "Steps target"],
  [/^targets\.zone2Minutes/, "Zone 2 minutes"],
  [/^nutrition\.proteinGPerLb/, "Protein"],
  [/^nutrition\.fatGPerLb/, "Fat"],
  [/^nutrition\.initialTdee/, "Maintenance estimate"],
  [/^nutrition\.kcalPerLb/, "Calories per lb"],
  [/^limits\.maxLoss/, "Max loss"],
  [/^limits\.maxGain/, "Max gain"],
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

export function useSettingsEditor() {
  const { data } = useData();
  const saveSettings = useSaveSettings();
  const toast = useToast();
  const settings = data.settings;
  /** The last rejected save, as a sentence for the screen's alert (null once a save goes through). */
  const [error, setError] = useState<string | null>(null);
  // Patches apply to the settings as they are when the patch runs — an Undo runs from a toast,
  // later, and must not put back everything else as it was when the toast was raised.
  const latest = useRef(settings);
  latest.current = settings;

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
  const setProgram = (p: Partial<Program>) => save({ ...latest.current, program: { ...latest.current.program, ...p } });
  const setTraining = (t: Partial<TrainingPrefs>) =>
    save({ ...latest.current, training: { ...trainingPrefs(latest.current), ...t } });
  /**
   * A program change with an Undo toast. `undo` gets the program as it is when Undo is tapped and
   * returns what to put back; the toast only shows when the change was saved.
   */
  const undoableProgram = (p: Partial<Program>, message: string, undo: (now: Program) => Partial<Program>) => {
    if (!setProgram(p)) return;
    toast.show({ message, action: { label: "Undo", onAction: () => void setProgram(undo(latest.current.program)) } });
  };

  return { settings, training: trainingPrefs(settings), error, save, setProgram, setTraining, undoableProgram };
}
