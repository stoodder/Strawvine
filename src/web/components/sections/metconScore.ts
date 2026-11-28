/** A metcon score against the benchmark's best so far: what the Metcon editor and its section say of it. */
import { isBetterScore, type ParsedScore } from "../../../shared/benchmarks";
import { fmt } from "../../lib/format";

const mss = (sec: number) => {
  const s = Math.round(Math.abs(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/** Today's score against the previous best: "New best" (gold), "Ties best", or how far off. */
export function compareScore(score: ParsedScore, best: ParsedScore): { text: string; tone: "gold" | "mute" } | null {
  if (isBetterScore(score, best)) return { text: "New best", tone: "gold" };
  if (score.kind !== best.kind) return null;
  if (score.value === best.value) return { text: "Ties best", tone: "mute" };
  const d = Math.abs(score.value - best.value);
  switch (score.kind) {
    case "time":
      return { text: `+${mss(d)} off best`, tone: "mute" };
    case "rounds": {
      const rounds = Math.floor(best.value / 1000) - Math.floor(score.value / 1000);
      const text = rounds > 0 ? `−${rounds} ${rounds === 1 ? "round" : "rounds"}` : `−${d} ${d === 1 ? "rep" : "reps"}`;
      return { text: `${text} off best`, tone: "mute" };
    }
    case "load":
      return { text: `−${fmt(d, d % 1 ? 1 : 0)} lb off best`, tone: "mute" };
    case "reps":
      return { text: `−${fmt(d, d % 1 ? 1 : 0)} ${d === 1 ? "rep" : "reps"} off best`, tone: "mute" };
  }
}
