import type { DayLog, DayLogPatch } from "../../../shared/schemas";

/**
 * What a day-log editor takes: the day's saved values (every field is controlled by them) and how
 * to save a patch of it. The editor's owner re-keys it per date, so an editor never carries one
 * day's entry into another.
 */
export type EditorProps = { day: DayLog; patch: (p: DayLogPatch) => void };
