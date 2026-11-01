import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { addDays, formatShortDate, nextMonday, startOfWeek, weekdayName } from "../../shared/dates";
import { goalDirection } from "../../shared/nutrition";
import { mainLiftSets } from "../../shared/program";
import { useAddMax, useData, useSaveDay, useSaveSettings } from "../lib/store";
import { BoxNumber, Field } from "../components/ui";
import { PaceSlider } from "../components/PaceSlider";
import { Logo } from "../components/Logo";
import { fmt } from "../lib/format";
import { success } from "../lib/haptics";

export function Onboarding() {
  const { data, today } = useData();
  const saveSettings = useSaveSettings();
  const saveDay = useSaveDay();
  const addMax = useAddMax();
  const [step, setStep] = useState(0);
  const tracked = data.exercises.filter((e) => e.tracksMax && !e.archived);
  const [maxes, setMaxes] = useState<Record<number, number | null>>({});
  const [weight, setWeight] = useState<number | null>(null);
  const [goal, setGoal] = useState<number | null>(null);
  const [pace, setPace] = useState<number | null>(null);
  const [tdee, setTdee] = useState<number | null>(null);
  const thisMonday = startOfWeek(today);
  const upcoming = nextMonday(today);
  const [start, setStart] = useState(upcoming);
  const [busy, setBusy] = useState(false);

  const direction = weight && goal ? goalDirection(weight, goal) : "maintain";
  const limit = direction === "gain" ? data.settings.limits.maxGainPctPerWeek : data.settings.limits.maxLossPctPerWeek;
  const effectivePace = pace ?? limit;
  const benchId = data.settings.program.days["1"]?.primaryExerciseId;
  const previewMax = benchId != null ? maxes[benchId] : null;

  const finish = async () => {
    setBusy(true);
    try {
      for (const ex of tracked) {
        const v = maxes[ex.id];
        if (v) await addMax({ exerciseId: ex.id, valueLb: v, date: today, source: "initial" });
      }
      if (weight !== null) saveDay(today, { weightLb: weight });
      await saveSettings({
        ...data.settings,
        onboarded: true,
        nutrition: { ...data.settings.nutrition, initialTdee: tdee },
        weightGoal: goal ? { targetLb: goal, pacePctPerWeek: effectivePace, setOn: today } : null,
        program: { ...data.settings.program, cycleStartDate: start },
      });
      success();
    } catch {
      setBusy(false);
    }
  };

  const steps = [
    // 0 — welcome
    <div key="0">
      <Logo size={40} />
      <h1 className="mt-8 text-4xl leading-tight font-light tracking-tight">Let's calibrate.</h1>
      <p className="mt-4 max-w-sm leading-relaxed text-fg-2">
        Strawvine learns your real energy burn from your morning weight and daily calories, calculates every working set from your maxes,
        and keeps the whole picture — training, fuel, recovery — in one quiet place.
      </p>
      <ul className="mt-8 space-y-3 text-sm text-mute">
        <li>
          <span className="text-accent">01</span>&nbsp;&nbsp;Your current maxes
        </li>
        <li>
          <span className="text-accent">02</span>&nbsp;&nbsp;Bodyweight & goal
        </li>
        <li>
          <span className="text-accent">03</span>&nbsp;&nbsp;When the first cycle starts
        </li>
      </ul>
    </div>,

    // 1 — maxes
    <div key="1">
      <div className="label text-accent">01 · Maxes</div>
      <h2 className="mt-3 text-3xl font-light tracking-tight">Where are you starting?</h2>
      <p className="mt-2 text-sm text-mute">Your current 1-rep max for each lift. Change these any time.</p>
      <div className="mt-8 divide-y divide-white/[0.05]">
        {tracked.map((ex) => (
          <Field key={ex.id} label={ex.name}>
            <BoxNumber
              ariaLabel={`${ex.name} max`}
              value={maxes[ex.id] ?? null}
              onCommit={(v) => setMaxes((m) => ({ ...m, [ex.id]: v }))}
              unit="lb"
              decimals={1}
            />
          </Field>
        ))}
      </div>
      {previewMax ? (
        <p className="mt-6 text-xs leading-relaxed text-mute">
          Week 1 bench:{" "}
          {mainLiftSets(data.settings.program, previewMax, data.settings.program.weeks[0]!, { progressionDay: true })
            .map((s) => `${s.reps}${s.amrap ? "+" : ""} @ ${s.weightLb}`)
            .join(" · ")}
        </p>
      ) : null}
    </div>,

    // 2 — body
    <div key="2">
      <div className="label text-accent">02 · Body</div>
      <h2 className="mt-3 text-3xl font-light tracking-tight">Bodyweight & goal</h2>
      <p className="mt-2 text-sm text-mute">All optional — the app works with whatever you give it.</p>
      <div className="mt-8 divide-y divide-white/[0.05]">
        <Field label="Today's weight" hint="Morning, after the bathroom">
          <BoxNumber ariaLabel="Today's weight" value={weight} onCommit={setWeight} unit="lb" decimals={1} />
        </Field>
        <Field label="Goal weight">
          <BoxNumber ariaLabel="Goal weight" value={goal} onCommit={setGoal} unit="lb" decimals={1} />
        </Field>
        <Field label="Maintenance estimate" hint={`Used while your TDEE calibrates${weight ? ` · default ${fmt(weight * 15)}` : ""}`}>
          <BoxNumber
            ariaLabel="Maintenance calories estimate"
            value={tdee}
            onCommit={setTdee}
            unit="kcal"
            placeholder={weight ? fmt(weight * 15) : "—"}
          />
        </Field>
      </div>
      {direction !== "maintain" && (
        <div className="mt-6">
          <PaceSlider value={effectivePace} onChange={setPace} limit={limit} bodyweight={weight} direction={direction} />
        </div>
      )}
    </div>,

    // 3 — start
    <div key="3">
      <div className="label text-accent">03 · Cycle</div>
      <h2 className="mt-3 text-3xl font-light tracking-tight">Week 1 begins…</h2>
      <p className="mt-2 text-sm text-mute">
        {data.settings.program.weeks.length}-week cycle:{" "}
        {data.settings.program.weeks.map((w) => (w.deload ? "deload" : w.reps.join("/"))).join(" → ")}
      </p>
      <div className="mt-8 space-y-3">
        {[...new Set([upcoming, thisMonday, today === upcoming ? addDays(today, 7) : null].filter(Boolean) as string[])].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setStart(d)}
            className={`tap flex w-full items-center justify-between rounded-2xl px-5 py-4 text-left transition-colors ${start === d ? "bg-accent/10 text-fg ring-1 ring-accent/40" : "bg-white/[0.03] text-fg-2"}`}
          >
            <span>
              {weekdayName(d)}, {formatShortDate(d)}
            </span>
            <span className="label">{d === today ? "today" : d < today ? "this week" : d === upcoming ? "next" : ""}</span>
          </button>
        ))}
      </div>
    </div>,
  ];

  const last = step === steps.length - 1;

  return (
    <div className="pt-safe mx-auto flex min-h-dvh max-w-lg flex-col px-6 pb-10">
      <div className="mt-4 flex gap-1.5">
        {steps.map((_, i) => (
          <div
            key={i}
            className={`h-[3px] flex-1 rounded-full transition-colors duration-500 ${i <= step ? "bg-accent" : "bg-white/[0.08]"}`}
          />
        ))}
      </div>
      <div className="flex-1 pt-14">
        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            {steps[step]}
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="mt-10 flex items-center justify-between">
        {step > 0 ? (
          <button type="button" className="btn-ghost" onClick={() => setStep(step - 1)}>
            Back
          </button>
        ) : (
          <span />
        )}
        <button type="button" disabled={busy} className="btn-primary" onClick={() => (last ? void finish() : setStep(step + 1))}>
          {last ? "Begin" : "Continue"} <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}
