/**
 * The day's Zone 2 on Train (DESIGN A.2, A.4, A.8, mockups 05, 06, 07): a numbered section whose
 * body is the Zone 2 editor (`sections/Zone2Body`: minutes, the machine's kcal reading, and the one
 * "Machine · Rowing ▾" line), with its done check in the head's check column, Not today / Bring
 * back (`zone2Skipped`, with an Undo toast), and — done — a one-line summary ("Rowing · 35 min ·
 * 320 kcal") that is all a folded section shows. The frame (skip, undo, fold, typing) is
 * `sections/LogSection`.
 *
 * Before anything is logged the head says the plan's minutes ("30 min planned"; "Added for today"
 * for a section added for the day, with Remove); a preview adds the machine it will start on. The
 * check ticks Zone 2 off as Today's row does: with the plan's minutes when none are entered. The
 * plan's minutes, the machine a day starts on and the machines offered are all read from the data
 * (`planTargets`, `zone2MachineFor`, `zone2Machines`), never stored.
 */
import { useMemo } from "react";
import { planTargets } from "../../../shared/program";
import { shownZone2Machine, zone2Activity, zone2MachineFor, zone2Machines } from "../../../shared/zone2";
import { fmt } from "../../lib/format";
import { useData } from "../../lib/store";
import { LogSection, skippedLine, type LogSectionInput } from "../sections/LogSection";
import { dotted, zone2Plan, zone2Summary } from "../sections/summary";
import { Zone2Body } from "../sections/Zone2Body";

export type Zone2SectionProps = LogSectionInput;

export function Zone2Section(props: Zone2SectionProps) {
  const { data } = useData();
  const { log, patch, section, onRemove } = props;
  const date = log.date;
  const offer = useMemo(() => ({ last: zone2MachineFor(date, data.days), machines: zone2Machines(data.days, date) }), [date, data.days]);
  const target = planTargets(data.settings, date).zone2Minutes;
  const machine = shownZone2Machine(log, offer.last);
  const status = section.status;
  const meta =
    status === "done" || status === "progress"
      ? zone2Summary(log, machine)
      : status === "planned"
        ? dotted([zone2Plan(target), zone2Activity(machine)])
        : onRemove && status === "todo"
          ? "Added for today"
          : status === "notDone"
            ? dotted(["Not done", zone2Plan(target)])
            : zone2Plan(target);
  return (
    <LogSection
      {...props}
      title="Zone 2"
      kind="zone2"
      skipField="zone2Skipped"
      // Ticked with the plan's minutes when none are entered; the minutes are never written otherwise (a count typed
      // and saved as the field was left for the check stays).
      onCheck={(want, live) => {
        if (!!live.zone2Done === want) return;
        patch(want && live.zone2Minutes == null ? { zone2Done: true, zone2Minutes: target } : { zone2Done: want });
      }}
      meta={meta}
      skippedLine={skippedLine(`${fmt(target)} min`, props.day.isToday)}
    >
      <Zone2Body key={date} day={log} patch={patch} last={offer.last} machines={offer.machines} />
    </LogSection>
  );
}
