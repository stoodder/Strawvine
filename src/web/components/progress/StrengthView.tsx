import { ChevronRight, Trophy } from "lucide-react";
import { Link } from "react-router";
import type { AppData } from "../../../shared/gamify";
import { currentMax } from "../../../shared/program";
import type { Exercise } from "../../../shared/schemas";
import { targetProgress } from "../../../shared/targets";
import { fmt, signed } from "../../lib/format";
import { Sparkline } from "../charts";
import { Bar, Empty, Section } from "../ui";

const fmtLb = (v: number) => fmt(v, v % 1 ? 1 : 0);

/**
 * Progress → Strength: every lift that tracks a max — its history as a sparkline, the current max
 * and, when the lift has strength targets, how far along each is. A row opens the lift's max
 * sheet; targets are read-only here and edited on Goals.
 */
export function StrengthView({ data, strong, onOpen }: { data: AppData; strong: boolean; onOpen: (exercise: Exercise) => void }) {
  const tracked = data.exercises.filter((e) => e.tracksMax && !e.archived);
  const anyTarget = data.settings.strengthTargets.length > 0;
  return (
    <Section label="Maxes">
      {tracked.length === 0 && (
        <Empty>
          No lift tracks a max yet. Turn on &ldquo;tracks a max&rdquo; for an exercise in{" "}
          {/* The exercise library lives in Program (it left Settings); `hit` gives the inline link a taller target. */}
          <Link to="/program#library" className="hit text-accent underline underline-offset-2">
            Program&rsquo;s exercise library
          </Link>
          .
        </Empty>
      )}
      <div className="-mx-1">
        {tracked.map((ex) => {
          const entries = data.maxEntries
            .filter((e) => e.exerciseId === ex.id)
            .sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? -1 : 1) : a.date < b.date ? -1 : 1));
          const cur = currentMax(data.maxEntries, ex.id);
          const start = entries[0]?.valueLb;
          const targets = data.settings.strengthTargets.filter((t) => t.exerciseId === ex.id).sort((a, b) => a.targetLb - b.targetLb);
          return (
            <button key={ex.id} type="button" onClick={() => onOpen(ex)} className="tap block w-full rounded-2xl px-1 py-3.5 text-left">
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-[0.9375rem] text-fg-2 wrap-anywhere">{ex.name}</div>
                  <div className="mt-0.5 text-xs text-mute">
                    {cur && start !== undefined && cur.valueLb !== start ? (
                      <>
                        <span className="text-accent">{signed(cur.valueLb - start, 0)} lb</span> since start
                      </>
                    ) : cur ? (
                      "no change yet"
                    ) : (
                      "no max yet"
                    )}
                  </div>
                </div>
                {/* Dropped when there's no room for it beside the name (200 % zoom). */}
                <span className="max-[16rem]:hidden">
                  <Sparkline points={entries.map((e) => e.valueLb)} width={72} height={24} strong={strong} />
                </span>
                <div className="num w-16 text-right text-2xl font-light">{cur ? fmtLb(cur.valueLb) : "—"}</div>
              </div>
              {targets.map((t) => {
                const p = targetProgress(t.targetLb, cur?.valueLb);
                return (
                  <div key={t.id} className="mt-3" data-target={t.id}>
                    <div className="flex items-baseline justify-between gap-3 text-xs">
                      <span className="text-mute">
                        Target <span className="num text-fg-2">{fmtLb(t.targetLb)}</span>
                      </span>
                      {/* Gold for a goal reached, and said in words. */}
                      {p.reached ? (
                        <span className="flex items-center gap-1.5 text-gold">
                          <Trophy size={12} aria-hidden />
                          reached
                        </span>
                      ) : (
                        <span className="num text-mute">{p.currentLb > 0 ? `${fmtLb(p.toGoLb)} lb to go` : "no max yet"}</span>
                      )}
                    </div>
                    <Bar className="mt-2" value={p.fraction} tone={p.reached ? "gold" : "accent"} />
                  </div>
                );
              })}
            </button>
          );
        })}
      </div>
      <Link to="/goals" className="tap -mx-1 mt-4 inline-flex min-h-11 items-center gap-1 rounded-full px-1 text-sm text-fg-2">
        {anyTarget ? "Edit targets in Goals" : "Set strength targets in Goals"}
        <ChevronRight size={15} aria-hidden className="text-mute" />
      </Link>
    </Section>
  );
}
