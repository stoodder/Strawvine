import clsx from "clsx";
import { Info, Sparkles, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import type { Insight } from "../../../shared/insights";

/**
 * The app's advice, right under Today's header: the most important signal on one line (insights
 * arrive warnings first, then notes, then good news), and a quiet "+N more" that opens the rest in
 * place. Renders nothing without signals — no empty section.
 */
export function Signals({ insights }: { insights: ReadonlyArray<Insight> }) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const listId = useId();
  if (insights.length === 0) return null;
  const more = insights.length - 1;
  const shown = open ? insights : insights.slice(0, 1);
  return (
    <section aria-labelledby={headingId} data-signals="" className="mt-7">
      {/* Named for screen readers and heading navigation; on screen the icons carry it. */}
      <h2 id={headingId} className="sr-only">
        Signals
      </h2>
      <ul id={listId} className="space-y-3">
        {shown.map((i) => (
          <li key={i.key} data-tone={i.tone} className="flex gap-3 text-sm leading-relaxed">
            <span className={clsx("mt-0.5 shrink-0", i.tone === "good" ? "text-accent" : i.tone === "warn" ? "text-warn" : "text-mute")}>
              {i.tone === "good" ? <Sparkles size={15} /> : i.tone === "warn" ? <TriangleAlert size={15} /> : <Info size={15} />}
            </span>
            <span className="min-w-0 text-fg-2">{trueMinus(i.text)}</span>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          // 44px tall without adding its height to the page; lines up with the text, past the icon column.
          className="label -my-2 ml-[27px] inline-flex min-h-11 items-center text-mute"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? (
            "Show less"
          ) : (
            <>
              +{more} more <span className="sr-only">{more === 1 ? "signal" : "signals"}</span>
            </>
          )}
        </button>
      )}
    </section>
  );
}

/** Typographic minus for negative numbers in copy ("-0.8 lb" → "−0.8 lb"), matching `signed()`. */
export function trueMinus(text: string): string {
  return text.replace(/(^|[\s(])-(?=\d)/g, "$1−");
}
