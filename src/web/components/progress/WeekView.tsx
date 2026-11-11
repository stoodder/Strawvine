import clsx from "clsx";
import { Check, CircleCheck, CircleDashed, Share, TriangleAlert } from "lucide-react";
import { useId, type ReactNode } from "react";
import { addDays, formatShortDate } from "../../../shared/dates";
import { CALIBRATION_DAYS } from "../../../shared/energy";
import type { AppData } from "../../../shared/gamify";
import { weeklyVerdict, type WeeklyCheckin, type WeeklyVerdict } from "../../../shared/insights";
import { fmt, minutesToHM, signed } from "../../lib/format";
import { Calibration } from "../Calibration";
import { formatProjectedRange } from "../projection";
import { useToast } from "../Toast";
import { Bar, Section, Stat } from "../ui";
import { checkinText, shareText, vo2Change } from "./shareCheckin";

function firstLoggedOr(days: ReadonlyArray<{ date: string; weightLb: number | null; calories: number | null }>, fallback: string) {
  return days.find((d) => d.weightLb !== null && d.calories !== null)?.date ?? fallback;
}

const TILES = "grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-x-6 gap-y-7";

/** A named group of check-in tiles: the name is a quiet sentence-case line, apart from the tiles' own mono labels. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="mt-9">
      <h3 id={id} className="mb-4 text-[0.8125rem] font-medium text-fg-2">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** The week in one line: the icon and the words carry the tone, the colour only underlines it. */
function Verdict({ verdict }: { verdict: WeeklyVerdict }) {
  const Icon = verdict.tone === "good" ? CircleCheck : verdict.tone === "warn" ? TriangleAlert : CircleDashed;
  return (
    <div className="flex items-start gap-3" data-verdict={verdict.kind} data-tone={verdict.tone}>
      <Icon
        size={22}
        strokeWidth={1.75}
        aria-hidden
        className={clsx("mt-1.5 shrink-0", verdict.tone === "good" ? "text-accent" : verdict.tone === "warn" ? "text-warn" : "text-mute")}
      />
      <p className="min-w-0">
        <span className="block text-[1.75rem] leading-tight font-light tracking-tight">{verdict.title}</span>
        <span className="sr-only"> · </span>
        <span className="num mt-1 block text-sm leading-relaxed text-fg-2 first-letter:uppercase">{verdict.detail}</span>
      </p>
    </div>
  );
}

/**
 * Progress → Week: the last seven complete days. A headline verdict (the trend against the plan,
 * `weeklyVerdict`), then the check-in's tiles by what they are about — Body, Fuel, Activity,
 * Recovery — and next week's targets.
 */
export function WeekView({
  data,
  today,
  checkin: c,
  loggedCount,
}: {
  data: AppData;
  today: string;
  checkin: WeeklyCheckin;
  loggedCount: number;
}) {
  const toast = useToast();
  const goal = data.settings.weightGoal;
  const hasCheckin = !(c.daysLogged === 0 && c.tdee === null);
  const share = async () => {
    const outcome = await shareText(checkinText(c, { today, goalLb: goal?.targetLb ?? null }), "Weekly check-in");
    if (outcome === "copied") toast.show({ message: "Check-in copied", tone: "good" });
    else if (outcome === "failed") toast.show({ message: "Couldn't share or copy the check-in", tone: "warn" });
  };

  return (
    <Section
      label="Weekly check-in"
      right={
        <>
          <span className="label">
            {formatShortDate(c.from)} – {formatShortDate(c.to)}
          </span>
          {hasCheckin && (
            <button
              type="button"
              aria-label="Share check-in"
              onClick={() => void share()}
              className="tap -my-3.5 -mr-3 ml-1 grid h-11 w-11 place-items-center text-mute"
            >
              <Share size={15} aria-hidden />
            </button>
          )}
        </>
      }
    >
      {!hasCheckin ? (
        <p className="text-sm leading-relaxed text-mute">
          Your first check-in builds itself from a week of mornings and meals. Log weight and calories daily and it lands here on{" "}
          <span className="text-fg-2">{formatShortDate(addDays(firstLoggedOr(data.days, today), 7))}</span>.
        </p>
      ) : (
        <>
          <Verdict verdict={weeklyVerdict(c)} />

          <Group label="Body">
            <div className={TILES}>
              <Stat
                label="TDEE"
                value={fmt(c.tdee?.value)}
                unit="kcal"
                tone="accent"
                sub={
                  !c.tdee
                    ? "—"
                    : !c.tdee.provisional
                      ? "learned from your logs"
                      : c.tdee.confidence > 0
                        ? `still learning · ${Math.round(c.tdee.confidence * 100)}% from your logs`
                        : "starting estimate"
                }
              />
              <Stat
                label="Trend weight"
                value={fmt(c.trendWeight, 1)}
                unit="lb"
                sub={
                  c.weightChangeLb !== null ? (
                    <>
                      <span className="text-fg-2">{signed(c.weightChangeLb, 1)} lb</span> this week
                      {c.targetRateLbPerWeek ? <span> · plan {signed(c.targetRateLbPerWeek, 1)}</span> : null}
                    </>
                  ) : (
                    "needs a week of data"
                  )
                }
              />
            </div>
          </Group>

          <Group label="Fuel">
            <div className={TILES}>
              <Stat
                label="Avg intake"
                value={fmt(c.avgCalories)}
                unit="kcal"
                size="sm"
                sub={
                  c.calorieAdherence !== null
                    ? `${Math.round(c.calorieAdherence * 100)}% of days on target`
                    : `${c.daysLogged}/7 days logged`
                }
              />
              <Stat
                label="Avg protein"
                value={fmt(c.avgProtein)}
                unit="g"
                size="sm"
                sub={c.next ? `target ${fmt(c.next.macros.proteinG)} g` : undefined}
              />
            </div>
          </Group>

          <Group label="Activity">
            <Stat label="Avg steps" value={fmt(c.avgSteps)} size="sm" sub={`target ${fmt(data.settings.targets.steps)}`} />
            <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(5rem,1fr))] gap-5">
              {(
                [
                  ["Lifts", c.lifts],
                  ["Metcon", c.metcon],
                  ["Zone 2", c.zone2],
                ] as const
              ).map(([label, v]) => {
                // A routine week done is progress (lime); gold stays for PRs and goals.
                const met = v.planned > 0 && v.done >= v.planned;
                // Nothing planned and nothing done: a dash, not "0/0".
                const idle = v.planned === 0 && v.done === 0;
                return (
                  <div key={label}>
                    <div className="label mb-1.5">{label}</div>
                    <div className="num flex items-center gap-1.5 text-lg font-light">
                      {idle ? (
                        <span aria-hidden className="text-mute">
                          —
                        </span>
                      ) : (
                        <span>
                          {v.done}
                          <span className="text-sm text-mute">/{v.planned}</span>
                        </span>
                      )}
                      {/* Not colour alone: a met week also gets a check. */}
                      {met && (
                        <>
                          <Check size={14} strokeWidth={2.5} className="text-accent" aria-hidden />
                          <span className="sr-only">all done</span>
                        </>
                      )}
                    </div>
                    <Bar className="mt-2" value={v.planned ? v.done / v.planned : 0} />
                    {idle && <div className="mt-1.5 text-xs leading-snug text-mute">none planned</div>}
                    {/* The week's Zone 2 machine readings, once logged: a reading, not intake — said in
                        words, so it never reads as calories eaten. */}
                    {label === "Zone 2" && c.zone2Kcal !== null && (
                      <div className="mt-1.5 text-xs leading-snug text-mute">
                        <span className="num whitespace-nowrap">{fmt(c.zone2Kcal)} kcal</span> on the machine
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Group>

          <Group label="Recovery">
            <div className={TILES}>
              <Stat
                label="Sleep · HRV"
                value={c.avgSleepMinutes !== null ? minutesToHM(c.avgSleepMinutes) : "—"}
                size="sm"
                sub={c.avgHrv !== null ? `HRV ${fmt(c.avgHrv)} ms` : undefined}
              />
              {/* Optional recovery metrics: only once logged. */}
              {c.avgRestingHr != null && <Stat label="Resting HR" value={fmt(c.avgRestingHr)} unit="bpm" size="sm" sub="average" />}
              {c.vo2Max && <Stat label="VO2 max" value={fmt(c.vo2Max.value, 1)} unit="mL/kg/min" size="sm" sub={vo2Change(c.vo2Max)} />}
            </div>
          </Group>
        </>
      )}
      {c.next && c.daysLogged > 0 && (
        <div className="mt-9 rounded-3xl bg-gradient-to-br from-accent/[0.09] to-transparent p-5 ring-1 ring-accent/15">
          <div className="label text-accent">Next week</div>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
            <div className="num text-4xl font-light tracking-tight">
              {fmt(c.next.calories)}
              <span className="ml-1 text-sm text-mute">kcal/day</span>
            </div>
            <div className="num pb-1 text-right text-xs leading-relaxed text-fg-2">
              <span className="whitespace-nowrap">P {fmt(c.next.macros.proteinG)}</span> ·{" "}
              <span className="whitespace-nowrap">C {fmt(c.next.macros.carbsG)}</span> ·{" "}
              <span className="whitespace-nowrap">F {fmt(c.next.macros.fatG)}</span>
            </div>
          </div>
          {c.projection?.range && goal && (
            <p className="mt-3 text-xs text-mute">
              {goal.targetLb} lb projected <span className="text-fg-2">{formatProjectedRange(c.projection.range, today)}</span>
            </p>
          )}
        </div>
      )}
      {loggedCount < CALIBRATION_DAYS && (
        <div className="mt-8">
          <Calibration logged={loggedCount} />
        </div>
      )}
    </Section>
  );
}
