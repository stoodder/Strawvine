/**
 * What every section of a Train day takes (Metcon, Strength, Rehab, Zone 2 — DESIGN A.2): the day it
 * belongs to, and its place in the day. The screen (`screens/Train.tsx`) mounts sections through
 * these props; each section adds what its own body needs.
 */

/** The day a section belongs to, as every section reads it. */
export interface TrainDay {
  /** The day shown. */
  date: string;
  /** The day the screen was opened on (a session past midnight keeps its own day). */
  today: string;
  isToday: boolean;
  /** A future day: the plan, read-only. Nothing saves, and nothing offers to. */
  isPreview: boolean;
  /** The page is a record: a finished session, or a day that isn't today. Its logged rows are its content. */
  isRecord: boolean;
  /** The day's weekday ("Monday"): "stays in next Monday's plan". */
  weekday: string;
}

/**
 * The props every day section takes. `index`, `current`, `anchor` and the fold are for the
 * numbered sections (DaySection's head, the rail's links); a section mounted without them — Train
 * as it is today — shows no head of its own.
 */
export interface SectionProps {
  day: TrainDay;
  /** Its number in the day, from 1 (shown "01"). */
  index?: number;
  /** The section the day is on: its index is lime (DESIGN A.3). */
  current?: boolean;
  /** Its anchor (`metcon`, `strength`, `rehab`, `zone2`): a rail node links to it, and its heading takes focus. */
  anchor?: string;
  /** Shows as its head and one-line summary (view state: `folds.ts`; never saved). */
  folded?: boolean;
  /** Folded or opened by hand. */
  onFold?: (fold: boolean) => void;
}
