/**
 * A set on the Train screen: one row grammar for the main lift and for accessories.
 *
 *   [n]  170 × 6  ✎                                   ( ✓ )
 *   └──────── values: opens the set editor ────────┘  └ check: logs / unlogs ┘
 *
 * Two explicit controls and no hidden gesture: the values (left) open the editor, the check
 * (right, a ≥ 44 px target as tall as the row) logs the set at its targets or unlogs it. What the
 * check does for a set that can't simply be logged (an AMRAP, a weighted set without a load) is
 * the screen's business (`checkAction`); the row only says that a sheet will open.
 *
 * Names. The check keeps the accessible name the set has always had ("Bench press set 1: 170 × 6",
 * "Pull-up set 1: 8 reps", "Hang set 1: 30s at 25 lb", "Curl set 1: 10 reps (no load)") with
 * `aria-pressed`. The values control is "Edit <exercise> set <n>: <what the row shows>" — the text
 * on screen, word for word ("Edit Hang set 1: 30 s · 25 lb"), so its visible label is part of its
 * name (WCAG 2.5.3; axe's label-content-name-mismatch compares them token by token).
 */
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { Check, Pencil } from "lucide-react";
import type { Measure, SetEntry } from "../../../shared/schemas";
import { shownLoad } from "../../../shared/session";
import { measureUnit } from "./SetSheets";
import { describeSet, unitWord } from "./sessionEdit";

/** iOS: no callout / text selection on a press, no double-tap zoom delay. */
const noCallout = { WebkitTouchCallout: "none", touchAction: "manipulation" } as const;
/** Stands in for a value a set doesn't have yet (no load, no target). */
const EMPTY = "–";

type Tone = "accent" | "gold" | "mute";
export interface SetTag {
  text: string;
  tone: Tone;
}
const TAG_TONE: Record<Tone, string> = { accent: "text-accent", gold: "text-gold", mute: "text-mute" };

/**
 * A main-lift set's tag: "AMRAP" until it's logged over target ("+3 reps · +3 lb" once the max
 * bump is applied), "back-off" for a set added beyond the plan.
 */
export function mainSetTag(set: SetEntry, extra: boolean): SetTag | null {
  if (set.amrap) {
    const over = set.done && set.reps !== null && set.targetReps !== null ? set.reps - set.targetReps : 0;
    if (over > 0) return { text: `+${over} reps${set.appliedProgressionLb ? ` · +${set.appliedProgressionLb} lb` : ""}`, tone: "gold" };
    return { text: "AMRAP", tone: "accent" };
  }
  return extra ? { text: "back-off", tone: "mute" } : null;
}

/**
 * "170 × 6", "140 × 12+ AMRAP": a main-lift set as its row shows it and both its controls name it
 * (what was logged, once it is).
 */
export function mainSetValues(set: SetEntry, tag: SetTag | null): string {
  const weight = set.done ? set.weight : set.targetWeight;
  const reps = set.done ? set.reps : set.targetReps;
  return `${weight ?? EMPTY} × ${reps ?? EMPTY}${set.amrap && !set.done ? "+" : ""}${tag ? ` ${tag.text}` : ""}`;
}

/**
 * "8 reps", "30s at 25 lb", "10 reps (no load)": an accessory set as its check names it. The load
 * is the one the set shows (`shownLoad`): none for an unweighted exercise's open set; a weighted
 * one without a load says so.
 */
export function accessorySetValues(set: SetEntry, measure: Measure, weighted: boolean): string {
  const amount = set.done ? set.reps : set.targetReps;
  const unit = measureUnit(measure);
  const load = shownLoad(set, weighted);
  const counted = amount === null ? "no target" : unit ? `${amount}${unit}` : `${amount} ${unitWord(measure, amount)}`;
  return `${counted}${load ? ` at ${load} lb` : weighted ? " (no load)" : ""}`;
}

/**
 * What an accessory row shows, as parts: the amount and its unit, then — for a weighted exercise,
 * or a set logged with a load — the load after a "×" (reps) or a "·" (time, distance).
 */
function accessoryParts(set: SetEntry, measure: Measure, weighted: boolean) {
  const amount = set.done ? set.reps : set.targetReps;
  const load = shownLoad(set, weighted);
  const showLoad = !!load || weighted;
  const unit = measureUnit(measure);
  return {
    amount,
    load,
    showLoad,
    /** After the amount: "s" / "m", or "reps" when no load follows ("8 reps" but "8 × 25 lb"). */
    unit: unit || (showLoad ? "" : unitWord(measure, amount)),
    joiner: unit ? "·" : "×",
  };
}

/**
 * "8 × 25 lb", "8 reps", "30 s · 25 lb", "40 m", "10 × – lb (no load)": an accessory set as its
 * row shows it — the words its values control is named by (a missing load or target also said in
 * words, since a dash says nothing aloud).
 */
export function accessorySetShown(set: SetEntry, measure: Measure, weighted: boolean): string {
  const p = accessoryParts(set, measure, weighted);
  const shown = [p.amount ?? EMPTY, p.unit, ...(p.showLoad ? [p.joiner, p.load ?? EMPTY, "lb"] : [])].filter((x) => x !== "").join(" ");
  return `${shown}${p.amount === null ? " (no target)" : ""}${p.showLoad && !p.load ? " (no load)" : ""}`;
}

/** The round check: an open ring, filled (with a tick) once the set is logged. Decorative — its button names it. */
function CheckMark({ done, tone, size }: { done: boolean; tone: "accent" | "gold"; size: number }) {
  const color = tone === "gold" ? "var(--color-gold)" : "var(--color-accent)";
  return (
    // hc-edge: in high contrast the open ring gets a visible edge (its own is only 0.35 white).
    <span aria-hidden className="hc-edge relative grid shrink-0 place-items-center rounded-full" style={{ width: size, height: size }}>
      <motion.span
        className="absolute inset-0 rounded-full"
        initial={false}
        animate={{
          backgroundColor: done ? color : "rgba(255,255,255,0)",
          boxShadow: done ? `0 0 18px -2px ${color}` : "inset 0 0 0 1.5px rgba(255,255,255,0.35)",
          scale: done ? [1, 1.18, 1] : 1,
        }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      />
      {/* Only a set logged just now gets the tick's entrance: a page of logged rows doesn't replay it on load. */}
      <AnimatePresence initial={false}>
        {done && (
          <motion.span
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 26 }}
            className="relative text-accent-ink"
          >
            <Check size={size * 0.55} strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

interface RowProps {
  /** "Bench press set 1": leads both controls' names. */
  title: string;
  /** The set as the check names it: "170 × 6", "8 reps at 25 lb". */
  spoken: string;
  /** The set as the row shows it, for the values control's name (default: `spoken`). */
  shown?: string;
  /** 1-based, shown at the start of the row. */
  number: number;
  done: boolean;
  /** Hero numerals (the main lift) or the compact row accessories use. */
  size: "main" | "compact";
  /** The check's colour once logged: gold for a beaten AMRAP. */
  tone?: "accent" | "gold";
  /** `data-set` hook (with `data-open` while unlogged), so the screen can find the next open set to reveal. */
  dataSet?: string;
  /** The check won't log this set as it is: it opens a sheet (the rep counter, the editor). */
  checkOpensSheet?: boolean;
  onCheck: () => void;
  onEdit: () => void;
  /** The visible values: spans, with a space between each (see `RowValues`). */
  children: ReactNode;
}

/**
 * The row's shared left part: set number, then the values. The spaces between the parts are real
 * text (layout ignores them in a flex row): they keep "1", "170" and "× 6" separate words for
 * anything that reads the row's text.
 */
function RowValues({ number, size, children }: Pick<RowProps, "number" | "size" | "children">) {
  return (
    <>
      <span aria-hidden className="label w-5 shrink-0">
        {number}
      </span>{" "}
      <span aria-hidden className={clsx("flex min-w-0 flex-wrap items-baseline gap-y-1", size === "main" ? "gap-x-2" : "gap-x-1.5")}>
        {children}
      </span>
    </>
  );
}

const rowGap = (size: RowProps["size"]) => (size === "main" ? "min-h-[3.75rem] gap-4" : "min-h-12 gap-3");

function SetRow({ title, spoken, shown = spoken, number, done, size, tone = "accent", dataSet, checkOpensSheet, onCheck, onEdit, children }: RowProps) {
  return (
    <li data-set={dataSet} data-open={done ? undefined : ""} className="flex items-stretch">
      <button
        type="button"
        aria-label={`Edit ${title}: ${shown}`}
        aria-haspopup="dialog"
        onClick={onEdit}
        // The press tint and the pencil say "editable" without boxing every row.
        className={clsx(
          "tap -ml-2 flex min-w-0 flex-1 items-center rounded-xl py-1 pl-2 text-left select-none active:bg-white/[0.04]",
          rowGap(size),
        )}
        style={noCallout}
      >
        <RowValues number={number} size={size}>
          {children}
        </RowValues>
        <Pencil aria-hidden size={12} className="shrink-0 text-faint" />
      </button>
      <button
        type="button"
        aria-label={`${title}: ${spoken}`}
        aria-pressed={done}
        aria-haspopup={checkOpensSheet ? "dialog" : undefined}
        onClick={onCheck}
        // As tall as the row and 64 px wide, reaching into the gutter: a target for a sweaty thumb.
        className="tap -mr-3 flex w-16 shrink-0 items-center justify-end rounded-xl pr-3 select-none"
        style={noCallout}
      >
        <CheckMark done={done} tone={tone} size={size === "main" ? 26 : 22} />
      </button>
    </li>
  );
}

/** A planned set in a read-only preview: the row's shape, nothing to press. */
function PlannedRow({ spoken, number, size, children }: { spoken: string; number: number; size: RowProps["size"]; children: ReactNode }) {
  return (
    <li className={clsx("flex items-center py-1", rowGap(size))}>
      <span className="sr-only">{spoken}</span>
      <RowValues number={number} size={size}>
        {children}
      </RowValues>
    </li>
  );
}

interface SetRowCommon {
  exerciseName: string;
  /** 0-based position among the exercise's sets. */
  index: number;
  set: SetEntry;
  dataSet?: string;
  /** A read-only preview of a coming day: the planned targets, no controls. */
  preview?: boolean;
  /** The check: log / unlog (or whatever `checkAction` says this set needs first). */
  onCheck?: () => void;
  /** The values: open the set's editor. */
  onEdit?: () => void;
}

/** A main-lift set: the load as the hero numeral, "× reps", and its tag (AMRAP, back-off). */
export function MainSetRow({
  exerciseName,
  index,
  set,
  extra = false,
  dataSet,
  preview = false,
  onCheck,
  onEdit,
}: SetRowCommon & {
  /** Added beyond the program's prescription (a back-off set). */
  extra?: boolean;
}) {
  // A preview shows the plan: targets only.
  const shown = preview ? { ...set, done: false } : set;
  const done = shown.done;
  const tag = mainSetTag(shown, extra);
  const weight = done ? shown.weight : shown.targetWeight;
  const reps = done ? shown.reps : shown.targetReps;
  const values = (
    <>
      {/* Open sets are the bright ones: what's left to do leads, what's done recedes behind its check. */}
      <span className={clsx("num text-3xl font-light tracking-tight", preview ? "text-fg-2" : done ? "text-mute" : "text-fg")}>
        {weight ?? EMPTY}
      </span>{" "}
      <span className="text-sm whitespace-nowrap text-mute">
        × {reps ?? EMPTY}
        {shown.amrap && !done && "+"}
      </span>
      {tag && (
        <>
          {" "}
          <span className={clsx("label whitespace-nowrap", TAG_TONE[tag.tone])}>{tag.text}</span>
        </>
      )}
    </>
  );
  if (preview)
    return (
      <PlannedRow spoken={`Set ${index + 1}: ${describeSet(shown, "reps")}${shown.amrap ? ", AMRAP" : ""}`} number={index + 1} size="main">
        {values}
      </PlannedRow>
    );
  return (
    <SetRow
      title={`${exerciseName} set ${index + 1}`}
      spoken={mainSetValues(set, tag)}
      number={index + 1}
      done={done}
      size="main"
      tone={tag?.tone === "gold" ? "gold" : "accent"}
      dataSet={dataSet}
      checkOpensSheet={set.amrap && !done}
      onCheck={() => onCheck?.()}
      onEdit={() => onEdit?.()}
    >
      {values}
    </SetRow>
  );
}

/**
 * An accessory set, in whatever it's measured in: "8 × 25 lb", "8 reps", "30 s · 25 lb", "40 m".
 * A weighted exercise shows its load on every set (an empty "– lb" while none is set: something
 * to fill in); an unweighted one shows none, except a load a set was logged with.
 */
export function AccessorySetRow({
  exerciseName,
  index,
  set,
  measure,
  weighted = false,
  needsLoad = false,
  dataSet,
  preview = false,
  onCheck,
  onEdit,
}: SetRowCommon & {
  measure: Measure;
  /** The exercise tracks a load. */
  weighted?: boolean;
  /** The check opens the editor instead of logging (a weighted set without a load yet). */
  needsLoad?: boolean;
}) {
  // A preview shows the plan: targets only.
  const shown = preview ? { ...set, done: false } : set;
  const done = shown.done;
  const p = accessoryParts(shown, measure, weighted);
  const numeralShape = "num text-xl font-light tracking-tight";
  const numeral = clsx(numeralShape, preview ? "text-fg-2" : done ? "text-mute" : "text-fg");
  const word = "text-sm whitespace-nowrap text-mute";
  const values = (
    <>
      <span className={numeral}>{p.amount ?? EMPTY}</span>
      {p.unit && (
        <>
          {" "}
          <span className={word}>{p.unit}</span>
        </>
      )}
      {p.showLoad && (
        <>
          {" "}
          <span className={word}>{p.joiner}</span> <span className={p.load ? numeral : clsx(numeralShape, "text-mute")}>{p.load ?? EMPTY}</span>{" "}
          <span className={word}>lb</span>
        </>
      )}
    </>
  );
  if (preview)
    return (
      <PlannedRow spoken={`Set ${index + 1}: ${describeSet(shown, measure, weighted)}`} number={index + 1} size="compact">
        {values}
      </PlannedRow>
    );
  return (
    <SetRow
      title={`${exerciseName} set ${index + 1}`}
      spoken={accessorySetValues(set, measure, weighted)}
      shown={accessorySetShown(set, measure, weighted)}
      number={index + 1}
      done={done}
      size="compact"
      dataSet={dataSet}
      checkOpensSheet={needsLoad}
      onCheck={() => onCheck?.()}
      onEdit={() => onEdit?.()}
    >
      {values}
    </SetRow>
  );
}
