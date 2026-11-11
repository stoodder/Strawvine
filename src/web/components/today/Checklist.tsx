import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Fragment, useId, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { weekdayName } from "../../../shared/dates";
import type { ChecklistItem } from "../../../shared/gamify";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import { substanceSummary } from "../../../shared/substances";
import { compactSteps, fmt, minutesToHM } from "../../lib/format";
import { Bar, CheckDot } from "../ui";
import { FuelEditor, MetconEditor, MorningEditor, StepsEditor, Zone2Editor } from "./editors";
import { SavedTick, type SavedFlash } from "./saved";

export interface LiftSummary {
  href: string;
  label: string | undefined;
  primaryName: string | null | undefined;
  setsDone: number;
  setsTotal: number;
  /** The session was planned for another day and moved to this one ("Do this session today"). */
  plannedFor?: string | null;
  /** The session is finished. */
  completed?: boolean;
  /** The main lift was skipped. */
  mainSkipped?: boolean;
  /**
   * This day's plan was moved to that date (done there when `completed`); the sets shown are
   * that session's.
   */
  elsewhere?: string | null;
  /** The day the checklist is for (a moved session reads "done today" when it's today). */
  date?: string;
  today?: string;
}

/**
 * "Close the day": one row per checklist item. Render it with `key={date}` so the expanded
 * editor (and every field in it) belongs to exactly one day.
 *
 * Row anatomy — the dot is only a real control where it is a plain toggle (metcon, zone 2).
 * Derived items (morning check-in, nutrition, steps) are done by entering their value, so their dot is
 * status, and tapping it opens the editor just like the row. The lift row is a link to Train.
 */
export function DayChecklist({
  items,
  day,
  patch,
  stepTarget,
  zone2Minutes,
  lift,
  saved,
}: {
  items: ChecklistItem[];
  day: DayLog;
  patch: (p: DayLogPatch) => void;
  stepTarget: number;
  zone2Minutes: number;
  lift: LiftSummary;
  /** Shows a brief "saved" on the row whose edit the server just acknowledged. */
  saved?: SavedFlash;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (k: string) => setOpen((o) => (o === k ? null : k));

  return (
    <div className="-mx-1">
      <span role="status" className="sr-only">
        {saved?.shown ? "Saved" : ""}
      </span>
      {items.map((item) => {
        const summary = summaryFor(item, day, stepTarget, lift);
        if (item.key === "lift") return <LiftRow key={item.key} item={item} summary={summary} href={lift.href} />;
        const rowPatch = (p: DayLogPatch) => {
          saved?.mark(item.key);
          patch(p);
        };
        const onCheck =
          item.key === "metcon"
            ? () => rowPatch({ metconDone: !day.metconDone })
            : item.key === "zone2"
              ? () =>
                  rowPatch({
                    zone2Done: !day.zone2Done,
                    zone2Minutes: !day.zone2Done && day.zone2Minutes === null ? zone2Minutes : day.zone2Minutes,
                  })
              : null;
        return (
          <ChecklistRow
            key={item.key}
            item={item}
            open={open === item.key}
            onToggleOpen={() => toggle(item.key)}
            onCheck={onCheck}
            summary={summary}
            saved={saved?.shown === item.key}
          >
            {item.key === "morning" && <MorningEditor day={day} patch={rowPatch} />}
            {item.key === "fuel" && <FuelEditor day={day} patch={rowPatch} />}
            {item.key === "steps" && <StepsEditor day={day} patch={rowPatch} target={stepTarget} />}
            {item.key === "zone2" && <Zone2Editor day={day} patch={rowPatch} />}
            {item.key === "metcon" && <MetconEditor day={day} patch={rowPatch} />}
          </ChecklistRow>
        );
      })}
    </div>
  );
}

/**
 * `sub` and `note` are one line each under the label, the full width of the row (the value sits
 * up beside the label): the Nutrition row's macros and "Also today" flags, the morning check-in's
 * readings and ratings.
 */
type Summary = { value: ReactNode; sub?: ReactNode; note?: ReactNode };

/** Value column: light numerals, unit in mute — the same for every row. */
function Value({ n, unit }: { n: ReactNode; unit?: string }) {
  return (
    <>
      {n}
      {unit && <span className="text-mute"> {unit}</span>}
    </>
  );
}

const dotted = (parts: ReactNode[]): ReactNode =>
  parts.map((p, i) => (
    <Fragment key={i}>
      {i > 0 && " · "}
      {p}
    </Fragment>
  ));

/**
 * Everything the morning check-in holds besides the weight (the row's value), in two short lines
 * that each fit a 320 px phone: the night's readings — "7h 30m · score 81 · HRV 55 · RHR 48" —
 * then the slower and the felt ones — "VO2 51.6 · energy 4/5 · soreness 2/5". Only what was logged
 * (`!= null`: a day cached by an older build lacks the newer fields); nothing logged, the prompt.
 * "RHR" is read out as "resting heart rate" and "score" as "sleep score" (VoiceOver spells letters).
 */
function morningSummary(day: DayLog): { sub: ReactNode; note?: ReactNode } {
  const night: ReactNode[] = [];
  if (day.sleepMinutes != null) night.push(minutesToHM(day.sleepMinutes));
  if (day.sleepScore != null)
    night.push(
      <>
        <span className="sr-only">sleep</span> score {fmt(day.sleepScore)}
      </>,
    );
  if (day.hrvMs != null) night.push(`HRV ${fmt(day.hrvMs)}`);
  if (day.restingHrBpm != null)
    night.push(
      <>
        <span aria-hidden>RHR</span>
        <span className="sr-only">resting heart rate</span> {fmt(day.restingHrBpm)}
      </>,
    );
  const felt: ReactNode[] = [];
  if (day.vo2Max != null) felt.push(`VO2 ${fmt(day.vo2Max, 1)}`);
  if (day.energy != null) felt.push(`energy ${day.energy}/5`);
  if (day.soreness != null) felt.push(`soreness ${day.soreness}/5`);
  const lines = [night, felt].filter((l) => l.length > 0).map(dotted);
  if (lines.length === 0) return { sub: "Weight · sleep · recovery" };
  return { sub: lines[0], note: lines[1] };
}

function summaryFor(item: ChecklistItem, day: DayLog, stepTarget: number, lift: LiftSummary): Summary {
  switch (item.key) {
    case "morning":
      return {
        value: day.weightLb !== null ? <Value n={fmt(day.weightLb, 1)} unit="lb" /> : null,
        ...morningSummary(day),
      };
    case "fuel":
      return {
        value: day.calories !== null ? <Value n={fmt(day.calories)} unit="kcal" /> : null,
        sub:
          day.proteinG !== null ? (
            <>
              <span className="whitespace-nowrap">P {fmt(day.proteinG)}</span> ·{" "}
              <span className="whitespace-nowrap">C {fmt(day.carbsG)}</span> · <span className="whitespace-nowrap">F {fmt(day.fatG)}</span>
            </>
          ) : (
            "Daily totals"
          ),
        note: substanceSummary(day) || undefined,
      };
    case "steps":
      return {
        value: day.steps !== null ? <Value n={fmt(day.steps)} /> : null,
        sub: `Target ${compactSteps(stepTarget)}`,
      };
    case "zone2":
      return {
        value: day.zone2Done ? <Value n={fmt(day.zone2Minutes)} unit="min" /> : null,
        // The machine's reading, once logged (`!= null`: absent on a day cached by an older build).
        sub: day.zone2Kcal != null ? `Cycling · ${fmt(day.zone2Kcal)} kcal` : "Cycling",
      };
    case "metcon":
      return {
        value: day.metconScore ? <span className="block max-w-[8.5rem] truncate">{day.metconScore}</span> : null,
        sub: day.metconBenchmark ?? (day.metconNotes ? day.metconNotes.slice(0, 40) : "CrossFit"),
      };
    case "lift":
      return {
        value: lift.setsTotal ? <Value n={`${lift.setsDone}/${lift.setsTotal}`} unit="sets" /> : null,
        sub: liftSub(lift),
      };
  }
}

/**
 * The lift row's second line. The main lift's state leads when the session moved, so a narrow
 * screen truncates the "moved" part, not the lift:
 *   "Legs · Back squat"                         (as planned)
 *   "Back squat · Wed's Legs, moved here"       (moved to this day, not finished yet)
 *   "Back squat · Wed's Legs, done today"       (moved here and finished)
 *   "Back squat skipped · Legs"                 (main lift skipped)
 *   "Done Sun · Push · Back squat"              (this day's plan, done early on Sunday)
 *   "Moved to Sun · Push · Back squat"          (…moved there, not finished yet)
 */
export function liftSub(lift: LiftSummary): string {
  const main = lift.primaryName ? (lift.mainSkipped ? `${lift.primaryName} skipped` : lift.primaryName) : null;
  if (lift.elsewhere && lift.date && lift.elsewhere !== lift.date)
    return [`${lift.completed ? "Done" : "Moved to"} ${weekdayName(lift.elsewhere, true)}`, lift.label, main].filter(Boolean).join(" · ");
  const moved = movedLabel(lift);
  if (moved) return [main, moved].filter(Boolean).join(" · ");
  if (lift.mainSkipped && main) return [main, lift.label].filter(Boolean).join(" · ");
  return [lift.label, main].filter(Boolean).join(" · ") || "Session";
}

/** "Wed's Legs, moved here" (then "…, done today" once finished) for a session moved from another day; null otherwise. */
function movedLabel(lift: LiftSummary): string | null {
  const from = lift.plannedFor;
  if (!from || !lift.date || from === lift.date) return null;
  const name = lift.label ? `${weekdayName(from, true)}'s ${lift.label}` : `${weekdayName(from, true)}'s session`;
  if (!lift.completed) return `${name}, moved here`;
  return `${name}, done ${lift.date === lift.today ? "today" : weekdayName(lift.date, true)}`;
}

/** Status-only dot: hidden from assistive tech (the row says done / not done), tap forwards to the row. */
function StatusDot({ done, onActivate }: { done: boolean; onActivate?: () => void }) {
  return (
    <div className="-m-[9px] shrink-0 cursor-pointer p-[9px]" onClick={onActivate} aria-hidden="true">
      <div inert>
        <CheckDot done={done} />
      </div>
    </div>
  );
}

function RowText({ item, summary, srState, saved = false }: { item: ChecklistItem; summary: Summary; srState: boolean; saved?: boolean }) {
  return (
    <span className="block min-w-0 flex-1">
      {/* The value sits beside the label, so the lines under them have the row's whole width. */}
      <span className="flex items-baseline gap-4">
        <span className={clsx("block min-w-0 flex-1 text-[0.9375rem]", item.done ? "text-fg" : "text-fg-2")}>
          {item.label}
          {srState && <span className="sr-only">{item.done ? ", done" : ", not done"}</span>}
          {/* Announced once by the checklist's status region, not from inside the button. */}
          <SavedTick show={saved} live={false} className="ml-2.5 inline-block align-[1px]" />
        </span>
        {summary.value && <span className="num shrink-0 text-right text-lg leading-6 font-light">{summary.value}</span>}
      </span>
      {summary.sub && <span className="mt-0.5 block truncate text-xs text-mute">{summary.sub}</span>}
      {summary.note && <span className="mt-0.5 block truncate text-xs text-mute">{summary.note}</span>}
      {item.key === "steps" && !item.done && item.progress > 0 && <Bar className="mt-2 w-32" value={item.progress} />}
    </span>
  );
}

function ChecklistRow({
  item,
  open,
  onToggleOpen,
  onCheck,
  summary,
  saved = false,
  children,
}: {
  item: ChecklistItem;
  open: boolean;
  onToggleOpen: () => void;
  /** A real done/not-done toggle (metcon, zone 2); `null` for items done by entering a value. */
  onCheck: (() => void) | null;
  summary: Summary;
  /** The server just acknowledged an edit made in this row. */
  saved?: boolean;
  children: ReactNode;
}) {
  const panelId = useId();
  return (
    <div
      className="rounded-2xl transition-colors"
      style={{ background: open ? "rgba(255,255,255,0.025)" : undefined }}
      // While an editor is open, celebrations wait (see Celebrations).
      data-celebration-hold={open ? "" : undefined}
    >
      <div className="flex items-center gap-4 px-1">
        {onCheck ? (
          <CheckDot done={item.done} onClick={onCheck} label={`${item.label} complete`} />
        ) : (
          <StatusDot done={item.done} onActivate={onToggleOpen} />
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggleOpen}
          className="flex min-w-0 flex-1 items-center gap-4 rounded-lg py-3.5 text-left"
        >
          <RowText item={item} summary={summary} srState={!onCheck} saved={saved} />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            role="group"
            aria-label={`${item.label} details`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="px-1 pt-1 pb-4 pl-[46px]">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The lift is logged on Train: the whole row is a link there; the dot shows completion. */
function LiftRow({ item, summary, href }: { item: ChecklistItem; summary: Summary; href: string }) {
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-4 px-1">
      <StatusDot done={item.done} onActivate={() => navigate(href)} />
      <Link to={href} className="flex min-w-0 flex-1 items-center gap-4 rounded-lg py-3.5">
        <RowText item={item} summary={summary} srState />
      </Link>
    </div>
  );
}
