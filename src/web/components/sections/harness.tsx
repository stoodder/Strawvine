/**
 * A Metcon or Zone 2 section on its own, the way the Train screen will mount it (chunk 8): over a
 * day that takes its own patches (through `fillZone2Machine`, as the day's save does), with its
 * status from `daySections` and its fold from `useFolds`. For the web tests and the screenshot
 * harness only — nothing in the app imports it.
 *
 * The sections read `useData()` (the day logs, the settings) and the Undo reads `currentData()`:
 * the caller points both at `publish`'s latest data (a `vi.mock` of `lib/store` and `lib/sync`).
 */
import { useRef, useState, type ComponentType } from "react";
import { weekdayName } from "../../../shared/dates";
import { emptyDayLog } from "../../../shared/empty";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { daySections, type DayData, type SectionKey } from "../../../shared/sections";
import { fillZone2Machine, zone2MachineFor } from "../../../shared/zone2";
import { useFolds } from "../train/folds";
import type { LogSectionInput } from "./LogSection";

export interface HarnessControl {
  /** Every patch the section saved, in order. */
  patches: DayLogPatch[];
  /** A patch saved elsewhere (another device): applied to the day, not recorded. */
  external: (p: DayLogPatch) => void;
}

export interface SectionHarnessProps {
  Section: ComponentType<LogSectionInput>;
  kind: Extract<SectionKey, "metcon" | "zone2">;
  data: DayData;
  date: string;
  today: string;
  index?: number;
  current?: boolean;
  /** Added for the day (view state): the section has Remove. */
  added?: boolean;
  /** The data as it is now, for the mocked store (`useData`, `currentData`). */
  publish: (data: DayData) => void;
  control?: HarnessControl;
}

export function SectionHarness({
  Section,
  kind,
  data,
  date,
  today,
  index = 1,
  current,
  added = false,
  publish,
  control,
}: SectionHarnessProps) {
  const [days, setDays] = useState<DayLog[]>(() => [...data.days]);
  const latest = useRef(days);
  const [removed, setRemoved] = useState(false);
  const all: DayData = { ...data, days };
  publish(all);

  const apply = (p: DayLogPatch) => {
    const ds = latest.current;
    const before = ds.find((d) => d.date === date);
    const filled = fillZone2Machine(before, p, zone2MachineFor(date, ds).machine);
    const next = [...ds.filter((d) => d.date !== date), { ...(before ?? emptyDayLog(date)), ...filled } as DayLog];
    latest.current = next;
    publish({ ...data, days: next });
    setDays(next);
  };
  if (control) control.external = apply;

  const log = days.find((d) => d.date === date) ?? emptyDayLog(date);
  const section = daySections(date, all, { today, added: added && !removed ? [kind] : [] }).find((s) => s.key === kind);
  const folds = useFolds(date, [{ id: kind, done: section?.status === "done" }]);
  if (!section) return null;
  return (
    <Section
      day={{
        date,
        today,
        isToday: date === today,
        isPreview: date > today,
        isRecord: date < today,
        weekday: weekdayName(date),
      }}
      index={index}
      current={current}
      anchor={kind}
      folded={folds.folded(kind)}
      onFold={(f) => folds.setFolded(kind, f)}
      log={log}
      section={section}
      patch={(p) => {
        control?.patches.push(p);
        apply(p);
      }}
      onRemove={added && section.added && !section.planned ? () => setRemoved(true) : undefined}
    />
  );
}
