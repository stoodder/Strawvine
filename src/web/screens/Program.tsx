/**
 * Program (`/program`, reached from Train's header and from Settings): the training program —
 * where the cycle is now (and the next cycle, once one is set up), the weekly layout, the targets
 * and training days, the cycle's weeks, the rules, the rep-max table and the exercise library. It
 * edits the same settings document as Settings, through the same save path (`useSettingsEditor`).
 *
 * The weekly layout, targets and weeks are the plan's (SPEC §6.4). While a next cycle is set up, a
 * "This cycle / Next cycle" switch at the top of those sections picks the plan they edit (Next by
 * default): the next one changes nothing before it starts.
 */
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { currentPlan, nextPlan } from "../../shared/plans";
import { LiftsEditor } from "../components/program/LiftsEditor";
import {
  CycleNow,
  CycleWeeks,
  PlanSwitch,
  PlanTargetsSection,
  ProgramRules,
  RepMaxTable,
  WeeklyLayout,
  type PlanChoice,
  type PlanEdit,
} from "../components/program/ProgramSections";
import { useCycleChoice } from "../components/program/useCycleChoice";
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
  const { data, today } = useData();
  const { settings, training, error, setProgram, setTraining, undoableProgram, setPlan, undoablePlan } = useSettingsEditor();
  const program = settings.program;
  const location = useLocation();
  const choice = useCycleChoice();
  useTitle("Program");

  useJumpToHash();

  // This cycle's plan and, once one is set up, the next cycle's.
  const current = currentPlan(settings, today);
  const next = nextPlan(settings, today);
  const [picked, setPicked] = useState<PlanChoice>("next");
  // A next cycle set up (here or on another device) is what the plan sections show first.
  const nextId = next?.id ?? null;
  useEffect(() => {
    if (nextId) setPicked("next");
  }, [nextId]);
  const plan = next && picked === "next" ? next : current;
  const edit: Omit<PlanEdit, "id"> = {
    plan,
    setPlan: (p) => setPlan(plan.id, p),
    undoable: (p, u) => undoablePlan(plan.id, p, u),
    switcher: next ? <PlanSwitch value={next && picked === "next" ? "next" : "this"} onChange={setPicked} nextStart={next.start} /> : null,
  };

  return (
    <div>
      <ScreenHeader
        back={programBackTarget(location.state)}
        // The program's name (edited under Now).
        eyebrow={
          <span data-program-name="" className="block truncate">
            {current.name}
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

      <CycleNow
        id="now"
        program={program}
        current={current}
        next={next}
        setPlan={setPlan}
        undoable={undoableProgram}
        today={today}
        sessions={data.sessions}
        settingsForStart={settings}
        actions={choice}
      />
      <WeeklyLayout id="layout" {...edit} />
      <PlanTargetsSection id="targets" {...edit} />
      <CycleWeeks id="weeks" {...edit} />
      <ProgramRules id="rules" program={program} setProgram={setProgram} training={training} setTraining={setTraining} />
      <RepMaxTable id="rep-max" program={program} setProgram={setProgram} />
      <LiftsEditor id="library" />
    </div>
  );
}
