import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigationType, useSearchParams } from "react-router";
import { addDays } from "../../shared/dates";
import { displayPrefs } from "../../shared/defaults";
import { computeEnergySeries, energyBalanceSeries } from "../../shared/energy";
import { computeStepsSeries } from "../../shared/steps";
import type { Exercise } from "../../shared/schemas";
import { LineChart, type Series } from "../components/charts";
import { MaxSheet } from "../components/MaxSheet";
import { ScreenHeader } from "../components/ScreenHeader";
import { Section } from "../components/ui";
import { IntakeStrip } from "../components/progress/IntakeStrip";
import { RangeControl } from "../components/progress/RangeControl";
import { StrengthView } from "../components/progress/StrengthView";
import {
  PROGRESS_PANEL_ID,
  progressTabId,
  recallProgressView,
  rememberProgressView,
  viewFromParam,
  ViewTabs,
  type ProgressView,
} from "../components/progress/ViewTabs";
import { WeekView } from "../components/progress/WeekView";
import { useTitle } from "../components/useTitle";
import { fmt } from "../lib/format";
import { useData } from "../lib/store";

/**
 * Progress: five views behind one segmented control — Week (the check-in), Body, Fuel, Activity,
 * Strength. The view lives in the URL (`/progress?view=body`; Week is the bare path), so a reload,
 * Back from another screen and deep links land on it; the last one shown is remembered for the
 * session, so the tab bar's Progress comes back to it. Body, Fuel and Activity share one chart
 * range.
 */
export function ProgressScreen() {
  const { data, today, model } = useData();
  const [params, setParams] = useSearchParams();
  const param = params.get("view");
  // Coming back to Progress from another screen (the tab bar links to the bare path) opens the view
  // last shown this session rather than the week again. Decided once, when the screen mounts, and
  // only when it was reached by a link: an explicit `?view=` always wins, and a fresh load of the
  // bare path or Back / Forward to it (both "POP") show what that entry is — the week. Tapping
  // Progress while on Progress is no mount, so it goes to the week too.
  const arrivedBy = useNavigationType();
  const [restoring, setRestoring] = useState<ProgressView | null>(() => {
    if (param !== null || arrivedBy === "POP") return null;
    const last = recallProgressView();
    return last === "week" ? null : last;
  });
  // The restored view shows from the first render; the URL catches up in the effect below.
  const view = param === null && restoring ? restoring : viewFromParam(param);
  const setView = useCallback(
    (next: ProgressView) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === "week") p.delete("view");
          else p.set("view", next);
          return p;
        },
        // Views are facets of one screen, not steps: Back leaves Progress rather than replaying
        // taps, and the restore below leaves no bare entry behind. The control keeps its place on
        // the page (ViewTabs brings the new view's top up).
        { replace: true, preventScrollReset: true },
      ),
    [setParams],
  );
  useEffect(() => {
    // Put the restored view in the URL; once the URL names a view the restore is over (so a later
    // bare path — Progress tapped while on Progress — is the week).
    if (!restoring) return;
    if (param === null) setView(restoring);
    else setRestoring(null);
  }, [restoring, param, setView]);
  useEffect(() => rememberProgressView(view), [view]);
  const [range, setRange] = useState<number>(30);
  const [maxFor, setMaxFor] = useState<Exercise | null>(null);
  useTitle("Progress");

  const first = data.days.find((d) => d.weightLb !== null || d.calories !== null)?.date ?? today;
  const from = range ? addDays(today, -(range - 1)) : first < today ? first : addDays(today, -6);
  // The series are built here, above the views, so switching views never rebuilds them.
  const series = useMemo(
    () => computeEnergySeries(data.days, from, today, data.settings.nutrition.kcalPerLb),
    [data.days, data.settings.nutrition.kcalPerLb, from, today],
  );
  // Today's intake is still being logged: the energy lines end yesterday.
  const balance = useMemo(() => energyBalanceSeries(series, today), [series, today]);
  // Steps over the same range; today's count is in progress, so the trend ends yesterday.
  const steps = useMemo(() => computeStepsSeries(data.days, from, today, today), [data.days, from, today]);

  // Stable series for the charts, so hovering or opening a table never rebuilds years of points.
  const weightSeries = useMemo<Series[]>(
    () => [
      {
        key: "raw",
        label: "Scale",
        kind: "dots",
        color: "var(--color-fg-2)",
        points: series.map((d) => ({ x: d.date, y: d.weightLb })),
        format: (v) => v.toFixed(1),
        // Past ~a year, a dot per day is a smear: one per week (the trend line stays daily).
        weeklyOver: 400,
      },
      {
        key: "avg",
        label: "Trend",
        kind: "line",
        color: "var(--color-accent)",
        points: series.map((d) => ({ x: d.date, y: d.avgWeight })),
        format: (v) => v.toFixed(1),
      },
    ],
    [series],
  );
  const energySeries = useMemo<Series[]>(
    () => [
      {
        key: "intake",
        label: "Intake",
        kind: "line",
        color: "var(--color-fg-2)",
        points: balance.map((d) => ({ x: d.date, y: d.intake })),
        format: (v) => fmt(v),
      },
      {
        key: "tdee",
        label: "TDEE",
        kind: "line",
        color: "var(--color-accent)",
        points: balance.map((d) => ({ x: d.date, y: d.tdee })),
        format: (v) => fmt(v),
      },
    ],
    [balance],
  );

  const stepsSeries = useMemo<Series[]>(() => {
    // A single day is a dot, not a trend: wait for a couple (complete ones: today's is "so far").
    if (steps.filter((d) => d.steps !== null && !d.partial).length < 2) return [];
    return [
      {
        key: "steps",
        label: "Steps",
        kind: "dots",
        color: "var(--color-fg-2)",
        points: steps.map((d) => ({ x: d.date, y: d.steps })),
        format: (v) => fmt(v),
        weeklyOver: 400,
        // Today's count is still climbing: a hollow "so far" point, off the scale and the weekly means.
        partialAt: steps.find((d) => d.partial)?.date,
      },
      {
        key: "avg",
        label: "Trend",
        kind: "line",
        color: "var(--color-accent)",
        points: steps.map((d) => ({ x: d.date, y: d.avgSteps })),
        format: (v) => fmt(v),
      },
    ];
  }, [steps]);
  const stepTarget = data.settings.targets.steps;
  const stepRef = useMemo(() => (stepTarget > 0 ? { y: stepTarget, label: "Target", tone: "target" as const } : undefined), [stepTarget]);

  const goal = data.settings.weightGoal;
  const goalRef = useMemo(() => (goal ? { y: goal.targetLb, label: `goal ${goal.targetLb}` } : undefined), [goal]);
  const strong = displayPrefs(data.settings).highContrast;
  // One range for the three chart views, at the top of each.
  const rangeControl = <RangeControl range={range} onChange={setRange} />;

  return (
    <div>
      <ScreenHeader eyebrow="The trend" title="Progress" className="pb-5" />

      <ViewTabs view={view} onChange={setView} />

      {/* One panel, labelled by the selected tab; -mt-4 tucks the view's first heading up under the control. */}
      <div role="tabpanel" id={PROGRESS_PANEL_ID} aria-labelledby={progressTabId(view)} className="-mt-4">
        {view === "week" && (
          <WeekView data={data} today={today} checkin={model.checkin} loggedCount={model.todayEnergy?.loggedCount ?? 0} />
        )}

        {view === "body" && (
          <Section label="Bodyweight" right={rangeControl}>
            <LineChart
              series={weightSeries}
              refLine={goalRef}
              title="Bodyweight"
              strong={strong}
              emptyText="Weigh in a couple of mornings to see your trend."
            />
          </Section>
        )}

        {view === "fuel" && (
          <Section label="Energy balance" right={rangeControl}>
            <LineChart
              series={energySeries}
              emptyText="Two logged days and the burn estimate starts drawing."
              title="Energy balance"
              strong={strong}
            />
            <p className="mt-3 text-xs leading-relaxed text-mute">
              Weighted 7-day averages through yesterday; today is still being logged. The gap is the surplus or deficit your scale responds
              to.
            </p>
            <IntakeStrip data={data} series={model.series} today={today} />
          </Section>
        )}

        {view === "activity" && (
          <Section label="Steps" right={rangeControl}>
            <LineChart
              series={stepsSeries}
              refLine={stepRef}
              title="Steps"
              strong={strong}
              emptyText="Log steps a few days to see your trend."
            />
            {stepsSeries.length > 0 && (
              <p className="mt-3 text-xs leading-relaxed text-mute">
                The trend favours recent days, so it differs from the Week view&rsquo;s plain average. Today&rsquo;s hollow dot joins it
                tomorrow.
              </p>
            )}
          </Section>
        )}

        {view === "strength" && <StrengthView data={data} strong={strong} onOpen={setMaxFor} />}
      </div>

      <MaxSheet exercise={maxFor} open={!!maxFor} onClose={() => setMaxFor(null)} />
    </div>
  );
}
