import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { addDays, weekdayName } from "../../../shared/dates";

export interface NextSessionInfo {
  date: string;
  label: string;
  liftName: string | null;
  weekLabel: string;
}

/**
 * The next program day after today, under the checklist: "Next · Tue Pull · Deadlift  W2".
 * The whole line links to that day's preview on Train. Lines up with the checklist rows (a
 * dashed ring in the dot column marks it as upcoming, like Goals' "next" streak).
 */
export function NextSession({ next, today }: { next: NextSessionInfo; today: string }) {
  const when = next.date === addDays(today, 1) ? "Tomorrow" : weekdayName(next.date, true);
  const what = [`${when} ${next.label}`, next.liftName].filter(Boolean).join(" · ");
  return (
    <Link
      to={`/train/${next.date}`}
      data-next-session=""
      // The visible text is the name (voice control: "tap Next"), with "session" and "preview" for screen readers.
      className="-mx-1 mt-1 flex min-h-11 items-center gap-4 rounded-lg px-1"
    >
      {/* decor: the dot column, dashed = not yet */}
      <span aria-hidden className="h-[26px] w-[26px] shrink-0 rounded-full border border-dashed border-white/20" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
        <span className="label shrink-0">
          Next<span className="sr-only"> session:</span>
        </span>{" "}
        {/* The spaces keep the accessible name's words apart (flex drops them visually). */}
        {/* Keeps ~8 characters before truncating; the week label gives way first (hidden below ~22rem, still read out). */}
        <span className="min-w-[8ch] truncate text-sm text-fg-2">{what}</span>{" "}
        {next.weekLabel && <span className="label shrink-0 max-[22rem]:sr-only">{next.weekLabel}</span>}
        <span className="sr-only">, preview</span>
      </span>
      <ChevronRight aria-hidden size={15} className="shrink-0 text-mute" />
    </Link>
  );
}
