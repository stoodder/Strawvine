/**
 * Program (`/program`, reached from Train's header and from Settings): the training program —
 * where the cycle is now, the weekly layout, the cycle's weeks, the rules, the rep-max table and
 * the exercise library. It edits the same settings document as Settings, through the same save
 * path (`useSettingsEditor`).
 */
import { useLocation } from "react-router";
import { LiftsEditor } from "../components/program/LiftsEditor";
import { CycleNow, CycleWeeks, ProgramRules, RepMaxTable, WeeklyLayout } from "../components/program/ProgramSections";
import { PROGRAM_SECTIONS } from "../components/program/sections";
import { ScreenHeader } from "../components/ScreenHeader";
import { JumpList, useJumpToHash } from "../components/settings/JumpList";
import { useSettingsEditor } from "../components/settings/useSettingsEditor";
import { useTitle } from "../components/useTitle";
import { useData } from "../lib/store";

/**
 * Where Program's back control leads: the screen the link was followed from, when it says so
 * (`state.from`) — a Train day (`/train`, `/train/2026-10-19`) or Settings (`/settings`,
 * `/settings#schedule`) — and nothing else; without one, Train (today's). The label is the
 * control's accessible name: it says where it goes.
 */
export function programBackTarget(state: unknown): { to: string; label: string } {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from === "string") {
    if (/^\/train(\/\d{4}-\d{2}-\d{2})?$/.test(from)) return { to: from, label: "Back to Train" };
    if (/^\/settings(#[a-z-]+)?$/.test(from)) return { to: from, label: "Back to Settings" };
  }
  return { to: "/train", label: "Back to Train" };
}

export function ProgramScreen() {
  const { today } = useData();
  const { settings, training, error, setProgram, setTraining, undoableProgram } = useSettingsEditor();
  const program = settings.program;
  const location = useLocation();
  useTitle("Program");

  useJumpToHash();

  return (
    <div>
      <ScreenHeader
        back={programBackTarget(location.state)}
        // The program's name (edited under Now).
        eyebrow={
          <span data-program-name="" className="block truncate">
            {program.name}
          </span>
        }
        title="Program"
        tagline="The program Train follows. Change it and the sessions ahead recalculate."
      />
      <JumpList label="Program sections" items={PROGRAM_SECTIONS} />
      {error && (
        <p role="alert" className="mt-4 text-sm text-warn">
          {error}
        </p>
      )}

      <CycleNow id="now" program={program} setProgram={setProgram} undoable={undoableProgram} today={today} />
      <WeeklyLayout id="layout" program={program} setProgram={setProgram} undoable={undoableProgram} />
      <CycleWeeks id="weeks" program={program} setProgram={setProgram} undoable={undoableProgram} />
      <ProgramRules id="rules" program={program} setProgram={setProgram} training={training} setTraining={setTraining} />
      <RepMaxTable id="rep-max" program={program} setProgram={setProgram} />
      <LiftsEditor id="library" />
    </div>
  );
}
