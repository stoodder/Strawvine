/**
 * The day's metcon on Train (DESIGN A.2, A.4, mockups 01, 07): a numbered section whose body is the
 * Metcon editor (`sections/MetconBody`: benchmark, score, notes, the best so far, recent names),
 * with its done check in the head's check column, Not today / Bring back (`metconSkipped`, with an
 * Undo toast), and — done — a one-line summary ("Fran · 4:12 · New best") that is all a folded
 * section shows. The frame (skip, undo, fold, typing) is `sections/LogSection`.
 *
 * Before anything is logged the head says "CrossFit" ("Added for today" for a section added for
 * the day, with Remove). A preview shows the head alone.
 */
import { useData } from "../../lib/store";
import { LogSection, type LogSectionInput } from "../sections/LogSection";
import { MetconBody } from "../sections/MetconBody";
import { dotted, METCON_PLAN, metconSummary } from "../sections/summary";

export type MetconSectionProps = LogSectionInput;

export function MetconSection(props: MetconSectionProps) {
  const { data } = useData();
  const { log, patch, section, onRemove } = props;
  const status = section.status;
  const meta =
    status === "done" || status === "progress"
      ? metconSummary(log, data.days)
      : onRemove && status === "todo"
        ? "Added for today"
        : status === "notDone"
          ? dotted(["Not done", METCON_PLAN])
          : METCON_PLAN;
  return (
    <LogSection
      {...props}
      title="Metcon"
      kind="metcon"
      skipField="metconSkipped"
      onCheck={() => patch({ metconDone: !log.metconDone })}
      meta={meta}
      skippedLine="Stays open on the checklist"
    >
      <MetconBody key={log.date} day={log} patch={patch} />
    </LogSection>
  );
}
