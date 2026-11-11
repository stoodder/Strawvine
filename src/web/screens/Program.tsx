/**
 * Program (`/program`, reached from Train): the training plan — where the cycle is now, the weekly
 * layout, the cycle's weeks, the rules, the rep-max table and the exercise library. It edits the
 * same settings document as Settings, through the same save path (`useSettingsEditor`).
 */
import { Link, useLocation } from "react-router";
import { ChevronLeft } from "lucide-react";
import { LiftsEditor } from "../components/program/LiftsEditor";
import { CycleNow, CycleWeeks, ProgramRules, RepMaxTable, WeeklyLayout } from "../components/program/ProgramSections";
import { PROGRAM_SECTIONS } from "../components/program/sections";
import { JumpList, useJumpToHash } from "../components/settings/JumpList";
import { useSettingsEditor } from "../components/settings/useSettingsEditor";
import { useTitle } from "../components/useTitle";
import { useData } from "../lib/store";

export function ProgramScreen() {
  const { today } = useData();
  const { settings, training, error, setProgram, setTraining, undoableProgram } = useSettingsEditor();
  const program = settings.program;
  const location = useLocation();
  useTitle("Program");

  useJumpToHash();

  // Back to the Train day the link was followed from, when it says so (state.from); else today's.
  const from = (location.state as { from?: unknown } | null)?.from;
  const back = typeof from === "string" && /^\/train(\/|$)/.test(from) ? from : "/train";

  return (
    <div>
      <header className="flex items-center gap-2 pt-2">
        <Link to={back} aria-label="Back to Train" className="tap -my-2 -ml-3 grid h-11 w-11 shrink-0 place-items-center text-mute">
          <ChevronLeft size={18} />
        </Link>
        {/* The program's name (edited under Now). */}
        <div className="label min-w-0 truncate text-fg-2" data-program-name="">
          {program.name}
        </div>
      </header>
      <h1 className="mt-6 text-[2.75rem] leading-none font-light tracking-tight">Program</h1>
      <p className="mt-3 text-sm text-mute">The plan Train follows. Change it and the sessions ahead recalculate.</p>
      <JumpList label="Program sections" items={PROGRAM_SECTIONS} />
      {error && (
        <p role="alert" className="mt-4 text-sm text-warn">
          {error}
        </p>
      )}

      <CycleNow id="now" program={program} setProgram={setProgram} undoable={undoableProgram} today={today} />
      <WeeklyLayout id="layout" program={program} setProgram={setProgram} />
      <CycleWeeks id="weeks" program={program} setProgram={setProgram} undoable={undoableProgram} />
      <ProgramRules id="rules" program={program} setProgram={setProgram} training={training} setTraining={setTraining} />
      <RepMaxTable id="rep-max" program={program} setProgram={setProgram} />
      <LiftsEditor id="library" />
    </div>
  );
}
