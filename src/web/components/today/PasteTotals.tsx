import { useEffect, useId, useRef } from "react";
import type { DayLogPatch } from "../../../shared/schemas";
import { fmt } from "../../lib/format";
import { tick } from "../../lib/haptics";
import { parseNutrition, type NutritionTotals } from "./parseNutrition";

export type PasteState = { text: string; manual: boolean };

/** Reads the clipboard where the browser allows it; null when it can't (or there's nothing there). */
export async function readClipboard(): Promise<string | null> {
  try {
    const text = await navigator.clipboard?.readText?.();
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** The fields a parse should write: only what it read, so a partial paste never blanks the rest. */
export function totalsPatch(t: NutritionTotals): DayLogPatch {
  const p: DayLogPatch = {};
  if (t.calories !== null) p.calories = t.calories;
  if (t.proteinG !== null) p.proteinG = t.proteinG;
  if (t.carbsG !== null) p.carbsG = t.carbsG;
  if (t.fatG !== null) p.fatG = t.fatG;
  return p;
}

/**
 * The paste confirmation: what was read, laid out like the day's numbers, and one tap to use it.
 * In manual mode (the clipboard couldn't be read) a small text area takes the paste and the
 * readout follows as you type.
 */
export function PasteTotals({
  state,
  onText,
  onUse,
  onClose,
}: {
  state: PasteState;
  onText: (text: string) => void;
  onUse: (p: DayLogPatch) => void;
  onClose: () => void;
}) {
  const parsed = parseNutrition(state.text);
  const useBtn = useRef<HTMLButtonElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const readoutId = useId();

  useEffect(() => {
    if (state.manual) areaRef.current?.focus();
    else useBtn.current?.focus({ preventScroll: true });
    // Only when the panel opens or switches mode.
  }, [state.manual]);

  const cell = (label: string, v: number | null, unit?: string) => (
    <div className="min-w-0">
      <div className="label mb-1">{label}</div>
      <div className="num text-lg font-light">
        {v !== null ? fmt(v) : <span className="text-mute">—</span>}
        {v !== null && unit && <span className="text-xs text-mute"> {unit}</span>}
      </div>
    </div>
  );

  return (
    <div
      className="rounded-2xl bg-gradient-to-br from-accent/[0.08] to-transparent p-4"
      role="group"
      aria-label="Pasted totals"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="label text-accent">{state.manual ? "Paste totals" : "From clipboard"}</div>
      {state.manual && (
        <textarea
          ref={areaRef}
          data-paste-area
          aria-label="Paste nutrition totals"
          aria-describedby={readoutId}
          rows={2}
          value={state.text}
          onChange={(e) => onText(e.target.value)}
          placeholder="2140 212 150 70  ·  or a meal-app export"
          className="field mt-3 block w-full resize-none rounded-xl bg-white/[0.05] px-3 py-2 text-base"
        />
      )}
      <div id={readoutId} aria-live="polite" className="mt-3">
        {parsed ? (
          <div className="grid grid-cols-4 gap-3">
            {cell("kcal", parsed.calories)}
            {cell("P", parsed.proteinG, "g")}
            {cell("C", parsed.carbsG, "g")}
            {cell("F", parsed.fatG, "g")}
          </div>
        ) : (
          <p className="text-xs text-mute">
            {state.text.trim() ? "Can't read totals from that yet." : "Calories, protein, carbs, fat — in that order, or labelled."}
          </p>
        )}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          ref={useBtn}
          type="button"
          disabled={!parsed}
          className="btn-primary px-4 py-2"
          onClick={() => {
            if (!parsed) return;
            tick();
            onUse(totalsPatch(parsed));
          }}
        >
          Use these
        </button>
        <button type="button" className="btn-ghost px-4 py-2" onClick={onClose}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
