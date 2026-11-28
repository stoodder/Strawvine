/**
 * The Zone 2 editor's body — the duration, the machine's kcal reading and the machine — shared by
 * Today's checklist row and Train's Zone 2 section (`train/Zone2Section.tsx`).
 */
import { ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  DEFAULT_ZONE2_MACHINE,
  normalizeZone2Machine,
  sameZone2Machine,
  shownZone2Machine,
  zone2Activity,
  zone2MachineLabel,
  ZONE2_MACHINE_MAX,
  ZONE2_PRESETS,
  type LastZone2Machine,
} from "../../../shared/zone2";
import { InlineText } from "../InlineText";
import { NumberInput } from "../ui";
import type { EditorProps } from "./types";

/** What the Zone 2 editor needs to offer machines (SPEC §3.5), all of it derived from the day logs. */
export interface Zone2MachineProps {
  /** The machine of the last earlier day with Zone 2 (`zone2MachineFor`). Default: none (the bike). */
  last?: LastZone2Machine;
  /** The machines offered (`zone2Machines`). Default: the common ones. */
  machines?: string[];
}

const PRESET_MACHINES: string[] = ZONE2_PRESETS.map((p) => p.key);
const NO_LAST: LastZone2Machine = { machine: DEFAULT_ZONE2_MACHINE, from: null };
/** The select's value for "Other…": no machine is stored under it (a stored name never starts with a space). */
const OTHER = " other";

/**
 * The duration (entering one ticks the session off) and, optionally, the machine's calorie reading, then the machine:
 * one line, "Machine · Rowing ▾", a native select (Bike · Row · Elliptical · Ski · the owner's own names · Other…).
 * The reading is just that: it never counts toward the day's intake, the TDEE or the targets, and it doesn't tick the
 * session off. A reading out of range is refused, not clamped.
 *
 * The machine shown is the day's own, else (Zone 2 logged before machines were) the bike, else the last one used.
 * Choosing one writes it to the day at once, even with nothing else logged; the day's first Zone 2 value saved
 * without one gets the one shown (`fillZone2Machine`, in the day's save). "Other…" shows a name field under the
 * line — the last thing in the editor, so that it comes and goes under every field — and changes nothing until a
 * name is given.
 */
export function Zone2Body({ day, patch, last = NO_LAST, machines = PRESET_MACHINES }: EditorProps & Zone2MachineProps) {
  const machine = shownZone2Machine(day, last);
  // The machine shown is always an option (a name of the day's own older than the names offered, or chosen only).
  const options = machines.some((m) => sameZone2Machine(m, machine)) ? machines : [...machines, machine];
  const value = options.find((m) => sameZone2Machine(m, machine)) ?? machine;
  // "Other…" chosen (view state): its name field shows until a machine is chosen in the select. Taking it away as a
  // name is saved would move what is under it (another row, the journal) as the field is left for it.
  const [naming, setNaming] = useState(false);
  const nameBox = useRef<HTMLDivElement>(null);

  /** A machine chosen: written at once (the one recorded already: nothing to write). */
  const choose = (m: string) => {
    if (day.zone2Machine !== m) patch({ zone2Machine: m });
  };
  const commitName = (typed: string) => {
    const m = normalizeZone2Machine(typed);
    if (m === null) return;
    // A name offered already, spelt another way ("assault-bike"), is that one.
    choose(options.find((o) => sameZone2Machine(o, m)) ?? m);
  };
  const onSelect = (picked: string) => {
    if (picked !== OTHER) {
      setNaming(false);
      return choose(picked);
    }
    // Shown at once, so that the choice can put the caret in it.
    flushSync(() => setNaming(true));
    nameBox.current?.querySelector("input")?.focus();
  };

  return (
    <div>
      {/* A container: the two fields sit side by side where both always fit at their widest (600 min, 3000 kcal),
          and one under the other where they wouldn't (a 320 px phone) — decided by the room, never by what is
          typed: a row that wraps would re-wrap, and move the field in use, as a number gains or loses a digit. */}
      <div className="group @container space-y-2">
        <div className="flex flex-col gap-y-2 @min-[17rem]:flex-row @min-[17rem]:items-baseline @min-[17rem]:gap-x-8">
          <div className="flex items-baseline gap-2">
            <NumberInput
              ariaLabel="Zone 2 minutes"
              value={day.zone2Minutes}
              onCommit={(v) => patch({ zone2Minutes: v, zone2Done: v !== null && v > 0 ? true : day.zone2Done })}
              placeholder="30"
              inputClassName="text-5xl font-light tracking-tight"
              min={0}
              max={600}
            />
            <span className="text-sm text-mute">min</span>
          </div>
          {/* Read with `??`: a day cached by an older build has no such field. The unit sits inside the
              field's label, so the range hint (when a reading is refused) goes under both. */}
          <NumberInput
            ariaLabel="Zone 2 machine calories"
            value={day.zone2Kcal ?? null}
            onCommit={(v) => patch({ zone2Kcal: v })}
            inputClassName="text-3xl font-light tracking-tight"
            unit={<span className="ml-1 text-sm">kcal</span>}
            min={0}
            max={3000}
            outOfRange="reject"
            rangeHint="0–3000 kcal"
          />
        </div>
        {/* The range of a refused reading hangs under its field, where this line is: it makes way. */}
        <p className="text-xs text-mute group-has-[[data-range-hint]]:invisible">Machine reading · not added to intake</p>
      </div>
      {/* The machine: one line, 44 px tall, the native select laid over all of it (iOS gives its wheel). What it says
          is drawn beside it and truncated, so neither a long name nor the options change the line's size. While the
          name field is out it still says the machine in force: "Other…" changes nothing until a name is given. */}
      <div className="focus-ring-within relative mt-2 flex h-11 max-w-full items-center gap-1.5 rounded-lg text-sm">
        <span className="shrink-0 text-mute" aria-hidden>
          Machine ·
        </span>
        <span className="min-w-0 truncate text-fg-2" aria-hidden>
          {zone2Activity(machine)}
        </span>
        <ChevronDown size={14} strokeWidth={2} className="shrink-0 text-mute" aria-hidden />
        <select
          aria-label="Machine"
          value={value}
          onChange={(e) => onSelect(e.target.value)}
          // text-base: a field under 16 px makes iOS zoom the page as it takes focus.
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none text-base opacity-0 [color-scheme:dark]"
        >
          {options.map((m) => (
            <option key={m} value={m}>
              {zone2MachineLabel(m)}
            </option>
          ))}
          <option value={OTHER}>Other…</option>
        </select>
      </div>
      {/* Other's name: under the line, the last thing in the editor. */}
      {naming && (
        <div ref={nameBox} className="mt-2 max-w-[16rem]">
          <InlineText
            ariaLabel="Machine name"
            value=""
            onCommit={commitName}
            maxLength={ZONE2_MACHINE_MAX}
            placeholder="Its name, e.g. Assault bike"
            inputClassName="text-base"
          />
        </div>
      )}
    </div>
  );
}
