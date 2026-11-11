import clsx from "clsx";
import { isOnHold, type Recommendation } from "../../shared/nutrition";
import { fmt, signed } from "../lib/format";

type Floored = Pick<Recommendation, "floored" | "minCalories">;

/** "Held at your 1,500 kcal minimum." — the one wording, wherever a held target is shown or shared. */
export function floorNoteText(rec: Floored): string {
  return `Held at your ${fmt(rec.minCalories)} kcal minimum.`;
}

/**
 * The quiet line beside a calorie target while the minimum (Settings → Minimum calories) is
 * holding it up (SPEC §4.4). Reassurance in plain words, in the page's own muted text: never a
 * warning colour or an icon. Renders nothing while the target stands on its own.
 *
 * `pace` (Goals, under the pace slider) also says what that does to the pace: the slider keeps
 * showing the pace that was chosen, the target is built for less.
 */
export function FloorNote({
  rec,
  pace,
  className,
}: {
  rec: (Floored & Pick<Recommendation, "direction" | "rateLbPerWeek">) | null | undefined;
  pace?: boolean;
  className?: string;
}) {
  if (!rec?.floored) return null;
  return (
    <p data-floor-note="" className={clsx("text-xs leading-relaxed text-mute", className)}>
      {pace ? (
        <>
          Your calorie target is held at your <span className="num">{fmt(rec.minCalories)}</span> kcal minimum
          {rec.direction !== "lose" ? (
            "."
          ) : isOnHold(rec) ? (
            ", so the cut is on hold for now."
          ) : (
            <>
              , so it is built for <span className="num whitespace-nowrap">{signed(rec.rateLbPerWeek, 1)} lb/wk</span> for now.
            </>
          )}
        </>
      ) : (
        floorNoteText(rec)
      )}
    </p>
  );
}
