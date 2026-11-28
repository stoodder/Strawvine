/**
 * The frame of a day section whose data is the day log — Metcon and Zone 2 on Train (DESIGN A.2,
 * A.4, B.4; mockups 01, 05, 06, 07). It puts the body in a `DaySection` and owns what both share:
 *
 * - **The check**, in the head's check column: the section's own done toggle.
 * - **Not today**, offered while nothing in the section is logged (the domain's To do / Not done),
 *   never on a preview, nor on a section added for the day (that one has **Remove**). It writes
 *   `metconSkipped` / `zone2Skipped` through the day's normal save, and offers Undo in a dock toast.
 *   The Undo outlives the section (and the screen): it patches only its own field, and only when
 *   the day as it is when Undo is tapped (`currentData`) is still skipped. **Bring back** clears it.
 * - **The fold**: a done section can show as its head alone, the meta its one-line summary. Which
 *   is the screen's view state (`folded` / `onFold`, from `train/folds.ts`): nothing here folds by
 *   itself, so nothing folds while the page is in use. The chevron folds or opens it by hand. The
 *   wrapper carries `data-fold` / `data-done` for `foldInPlace`, and the chevron `data-fold-toggle`.
 * - **Typing stays put.** Whether the body is there (Not today) is held while a field of the page
 *   is being typed in (`useTyping` / `useHeldWhile`): a skip or a Bring back saved elsewhere — on
 *   another device — waits, so that a body never comes or goes above or under the field in use (a
 *   field removed while focused would also commit what it holds). A tap here shows at once.
 *   Nothing else in the head changes the page's height: the meta is one truncated line, and the
 *   controls at the right sit on the title's line.
 */
import { ChevronDown, ChevronUp } from "lucide-react";
import { useRef, type ReactNode } from "react";
import type { DayLog, DayLogPatch } from "../../../shared/schemas";
import type { DaySection as DaySectionInfo, SectionStatus } from "../../../shared/sections";
import { currentData } from "../../lib/sync";
import { useToast } from "../Toast";
import { DaySection, type SectionState } from "../train/DaySection";
import type { SectionProps } from "../train/sectionProps";
import { CheckDot } from "../ui";
import { useFocusAfter } from "../useFocusAfter";
import { useHeldWhile, useTyping } from "../useHeldWhileTyping";

/** The day-log field that says a section is Not today. */
export type SkipField = "metconSkipped" | "zone2Skipped";

/** How the domain's status reads in a section head. */
export const SECTION_STATE: Record<SectionStatus, SectionState> = {
  todo: "todo",
  progress: "active",
  done: "done",
  skipped: "skipped",
  notDone: "missed",
  notSetUp: "todo",
  planned: "planned",
};

/** The props a day-log section (Metcon, Zone 2) takes, besides those of every section. */
export interface LogSectionInput extends SectionProps {
  /** The day's log as saved (`emptyDayLog(date)` when there is none). */
  log: DayLog;
  /** The day's save (a per-field patch, bound to `day.date`): Today's `save(date, p)`. */
  patch: (p: DayLogPatch) => void;
  /** The section as the day has it (`daySections`): its status, and whether it was added for the day. */
  section: DaySectionInfo;
  /**
   * The section was added for the day and holds nothing yet ("Added for today", view state): the
   * head offers Remove in place of Not today. Absent: no Remove.
   */
  onRemove?: () => void;
}

interface LogSectionProps extends LogSectionInput {
  title: string;
  /** Its anchor when `anchor` isn't given. */
  kind: "metcon" | "zone2";
  skipField: SkipField;
  /** The done toggle (the check). */
  onCheck: () => void;
  /** The line under the title: the plan, or once logged, the one-line summary. */
  meta: ReactNode;
  /** A Not-today section's one muted line. */
  skippedLine: ReactNode;
  /** The editor (not rendered while Not today, folded, or on a preview). */
  children: ReactNode;
}

export function LogSection({
  day,
  index = 1,
  current = false,
  anchor,
  folded = false,
  onFold,
  log,
  patch,
  section,
  onRemove,
  title,
  kind,
  skipField,
  onCheck,
  meta,
  skippedLine,
  children,
}: LogSectionProps) {
  const id = anchor ?? kind;
  const toast = useToast();
  const focusAfter = useFocusAfter();
  const root = useRef<HTMLDivElement>(null);
  const undoToast = useRef<number | null>(null);

  const status = section.status;
  const preview = day.isPreview || status === "planned";
  const done = status === "done";
  const skipped = status === "skipped";

  // Whether the body is there holds while a field is typed in — unless this section's own tap changed it.
  const typing = useTyping();
  const asked = useRef<boolean | null>(null);
  const shownSkipped = useHeldWhile(skipped, typing && asked.current !== skipped, day.date);
  if (asked.current === skipped) asked.current = null;

  const button = (label: string) => () => root.current?.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
  const notTodayLabel = `Not today: ${title}`;
  const bringBackLabel = `Bring back ${title}`;

  const dropUndo = () => {
    if (undoToast.current !== null) toast.dismiss(undoToast.current);
    undoToast.current = null;
  };
  const skip = () => {
    asked.current = true;
    patch({ [skipField]: true });
    focusAfter(button(bringBackLabel));
    dropUndo();
    const date = day.date;
    let mine = -1;
    mine = undoToast.current = toast.show({
      message: `${title}: not today`,
      action: {
        label: "Undo",
        onAction: () => {
          undoToast.current = null;
          // The day as it is now (another tap, another device): only this field, and only if it is still set.
          const live = currentData()?.days.find((d) => d.date === date);
          if (live && !live[skipField]) return;
          asked.current = false;
          patch({ [skipField]: false });
          focusAfter(button(notTodayLabel));
        },
      },
      onClose: () => {
        if (undoToast.current === mine) undoToast.current = null;
      },
    });
  };
  const bringBack = () => {
    asked.current = false;
    dropUndo();
    patch({ [skipField]: false });
    focusAfter(() => root.current?.querySelector<HTMLElement>("[data-section-heading]"));
  };

  // Not today while nothing is logged (To do, or a past day's Not done); an added section has Remove instead.
  const canSkip = !preview && !onRemove && (status === "todo" || status === "notDone") && !shownSkipped;
  const isFolded = folded && done && !shownSkipped;
  const action =
    onRemove && !preview && (status === "todo" || status === "notDone") ? (
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${title}`}
        className="label tap inline-flex min-h-11 shrink-0 items-center px-2 text-mute"
      >
        Remove
      </button>
    ) : done && onFold && !shownSkipped ? (
      <button
        type="button"
        aria-expanded={!isFolded}
        aria-label={isFolded ? `Show ${title}` : `Fold ${title}`}
        data-fold-toggle={id}
        onClick={() => onFold(!isFolded)}
        className="tap grid min-h-11 w-11 shrink-0 place-items-center rounded-xl active:bg-white/[0.04]"
      >
        {isFolded ? <ChevronDown aria-hidden size={16} className="text-mute" /> : <ChevronUp aria-hidden size={16} className="text-mute" />}
      </button>
    ) : undefined;

  const state: SectionState = shownSkipped ? "skipped" : skipped ? "todo" : SECTION_STATE[status];
  return (
    <div ref={root} data-fold={id} data-done={done ? "" : undefined} data-folded={isFolded ? "" : undefined}>
      <DaySection
        id={id}
        index={index}
        title={title}
        meta={meta}
        state={state}
        current={current}
        check={preview || shownSkipped ? undefined : <CheckDot done={done} onClick={onCheck} label={`${title} complete`} />}
        action={action}
        onSkip={canSkip ? skip : undefined}
        onBringBack={shownSkipped && !preview ? bringBack : undefined}
        skippedLine={skippedLine}
        folded={isFolded || preview}
      >
        {children}
      </DaySection>
    </div>
  );
}
