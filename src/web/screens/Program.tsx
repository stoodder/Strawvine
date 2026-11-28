/**
 * Program (`/program`, reached from Train's header and from Settings): the training program —
 * where the cycle is now (and the next cycle, once one is set up), the weekly layout, the targets
 * and training days, the rehab blocks (behind the `rehab` flag), the cycle's weeks, the rules, the
 * rep-max table and the exercise library. It
 * edits the same settings document as Settings, through the same save path (`useSettingsEditor`).
 *
 * The weekly layout, targets and weeks are the plan's (SPEC §6.4). While a next cycle is set up, one
 * "This cycle / Next cycle" switch under Now picks the plan they edit, and their headings say which
 * one they show. It is on This cycle unless Program was opened to review the next one (router state
 * `plan: "next"`: from setting up a new plan, or a "Review" link): the next one changes nothing
 * before it starts.
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
import { RehabBlockSection } from "../components/program/RehabBlockSection";
import { PROGRAM_SECTIONS } from "../components/program/sections";
import { ScreenHeader } from "../components/ScreenHeader";
import { JumpList, useJumpToHash } from "../components/settings/JumpList";
import { useSettingsEditor } from "../components/settings/useSettingsEditor";
import { useTitle } from "../components/useTitle";
import { feature } from "../lib/features";
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

/**
 * The jump list's sections: Program's, with Rehab after Targets while the `rehab` flag is on for
 * this device (lib/features.ts) — without it, exactly as before.
 */
export function programJumps(rehab: boolean): ReadonlyArray<readonly [string, string]> {
  if (!rehab) return PROGRAM_SECTIONS;
  const at = PROGRAM_SECTIONS.findIndex(([id]) => id === "targets") + 1;
  return [...PROGRAM_SECTIONS.slice(0, at), ["rehab", "Rehab"], ...PROGRAM_SECTIONS.slice(at)];
}

export function ProgramScreen() {
  const { data, today } = useData();
  const { settings, training, error, setProgram, setTraining, undoableSettings, setPlan, undoablePlan } = useSettingsEditor();
  const program = settings.program;
  const location = useLocation();
  const choice = useCycleChoice();
  useTitle("Program");
  const rehab = feature("rehab");

  useJumpToHash();

  // This cycle's plan and, once one is set up, the next cycle's.
  const current = currentPlan(settings, today);
  const next = nextPlan(settings, today);
  // This cycle, unless Program was opened to review the next one (each such link is a new visit).
  const reviewNext = (location.state as { plan?: unknown } | null)?.plan === "next";
  const [picked, setPicked] = useState<PlanChoice>(reviewNext ? "next" : "this");
  useEffect(() => {
    if (reviewNext) setPicked("next");
  }, [location.key, reviewNext]);
  const onNext = !!next && picked === "next";
  const plan = next && onNext ? next : current;
  const edit: Omit<PlanEdit, "id"> = {
    plan,
    setPlan: (p) => setPlan(plan.id, p),
    undoable: (p, u) => undoablePlan(plan.id, p, u),
    caption: next ? (onNext ? "Next cycle" : "This cycle") : null,
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
      <JumpList label="Program sections" items={programJumps(rehab)} />
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
        undoableSettings={undoableSettings}
        today={today}
        sessions={data.sessions}
        settingsForStart={settings}
        actions={choice}
      />
      {next && <PlanSwitch value={onNext ? "next" : "this"} onChange={setPicked} nextStart={next.start} />}
      <WeeklyLayout id="layout" {...edit} />
      <PlanTargetsSection id="targets" {...edit} />
      {rehab && (
        <RehabBlockSection id="rehab" settings={settings} sessions={data.sessions} today={today} undoableSettings={undoableSettings} />
      )}
      <CycleWeeks id="weeks" {...edit} />
      <ProgramRules
        id="rules"
        program={program}
        setProgram={setProgram}
        training={training}
        setTraining={setTraining}
        acrossCycles={!!next}
      />
      <RepMaxTable id="rep-max" program={program} setProgram={setProgram} />
      <LiftsEditor id="library" />
    </div>
  );
}
