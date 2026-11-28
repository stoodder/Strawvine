/**
 * The day's rail (design A.2 / A.11): one node per section of the day, in the day's order, on a
 * line that lights up in lime as the day goes. Pure: it shows what its props say.
 *
 * - Each node is a link to its section (`#id`): it scrolls there and focus goes on to the
 *   section's heading. It never toggles anything.
 * - A node names its section and its state in words ("Strength, in progress, 5 of 16 sets"); the
 *   ring, the hatch and the dash never carry the meaning alone.
 * - The line between two neighbours is lit when the left one is settled (done or not today) and
 *   the right one has begun (done, not today or in progress), so it reads in any order the day was
 *   done in. A segment lighting up eases in (--fill-ms); `sweep` plays one pass of light along the
 *   whole line (the day just became complete). With reduced motion neither moves.
 * - Its height never depends on its state: every node has a dot, a name and a status line.
 * - With fewer than two sections there is no rail.
 */
import clsx from "clsx";
import { useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import { Check } from "lucide-react";
import { jumpToSection } from "../settings/JumpList";

export type RailState = "done" | "active" | "todo" | "skipped" | "missed" | "planned";

export interface RailNode {
  /** The section's anchor id ("strength"): the node links to `#id`. */
  id: string;
  /** The section's name ("Strength"). */
  name: string;
  state: RailState;
  /** Logged / planned sets (or rounds…): an in-progress ring fills with done ÷ total, and shows "5/16". */
  count?: { done: number; total: number; unit?: string };
  /** The short status under the name in place of the state's word ("35 min", "14 sets"). */
  status?: string;
  /** How `status` is read out, if not as written ("14 sets planned"). */
  spoken?: string;
  /** The section the day is at (in progress, or next to do): its name reads brighter. */
  current?: boolean;
}

/** How each state is shown under a node's name, and said. */
export const RAIL_WORDS: Record<RailState, { shown: string; said: string }> = {
  done: { shown: "Done", said: "done" },
  active: { shown: "In progress", said: "in progress" },
  todo: { shown: "To do", said: "to do" },
  skipped: { shown: "Not today", said: "not today" },
  missed: { shown: "Not done", said: "not done" },
  planned: { shown: "Planned", said: "planned" },
};

const fraction = (c: RailNode["count"]) => (c && c.total > 0 ? Math.max(0, Math.min(1, c.done / c.total)) : 0);

/** What shows under a node's name. */
export function railStatus(node: RailNode): string {
  if (node.status) return node.status;
  if (node.state === "active" && node.count) return `${node.count.done}/${node.count.total}`;
  return RAIL_WORDS[node.state].shown;
}

/** A node's accessible name: "Strength, in progress, 5 of 16 sets". */
export function railNodeName(node: RailNode): string {
  const parts = [node.name, RAIL_WORDS[node.state].said];
  if (node.status) parts.push(node.spoken ?? node.status);
  else if (node.count && (node.state === "active" || node.state === "todo"))
    parts.push(`${node.count.done} of ${node.count.total} ${node.count.unit ?? "sets"}`);
  return parts.join(", ");
}

const settled = (s: RailState) => s === "done" || s === "skipped";
const begun = (s: RailState) => settled(s) || s === "active";

/** Which segments of the line are lit (segment i joins node i and node i + 1). */
export function litSegments(states: readonly RailState[]): boolean[] {
  return states.slice(1).map((s, i) => settled(states[i]!) && begun(s));
}

export function DayRail({
  nodes,
  label = "The day's sections",
  sweep = false,
  className,
}: {
  nodes: readonly RailNode[];
  /** The navigation landmark's name. */
  label?: string;
  /** Play one pass of light along the line (pass true at the moment the day completes). */
  sweep?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  const n = nodes.length;
  if (n < 2) return null;
  const lit = litSegments(nodes.map((x) => x.state));
  // Five or more cells (two rehab blocks at once) are ~56px at 320: closer tracking, no padding.
  const tight = n >= 5;
  // The line runs from the first node's centre to the last one's.
  const track: CSSProperties = { left: `${50 / n}%`, right: `${50 / n}%` };
  return (
    <nav aria-label={label} className={clsx("relative", className)}>
      <div aria-hidden className="pointer-events-none absolute top-[11px] h-0.5 rounded-full bg-(--track)" style={track}>
        {lit.map((on, i) => (
          <span
            key={i}
            data-segment={on ? "lit" : "off"}
            className="glow-line progress-fill absolute inset-y-0 rounded-full"
            style={
              {
                left: `${(i / (n - 1)) * 100}%`,
                width: `${100 / (n - 1)}%`,
                "--progress": on ? 1 : 0,
                // One gradient along the whole line, whichever segments are lit.
                backgroundSize: `${(n - 1) * 100}% 100%`,
                backgroundPosition: n > 2 ? `${(i / (n - 2)) * 100}% 0` : "0 0",
              } as CSSProperties
            }
          />
        ))}
      </div>
      {sweep && !reduce && (
        <div
          aria-hidden
          data-sweep=""
          className="sweep pointer-events-none absolute top-[9px] h-1.5 overflow-hidden rounded-full"
          style={track}
        />
      )}
      <ol className="relative grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {nodes.map((node) => (
          <li key={node.id} className="flex min-w-0 justify-center">
            <a
              href={`#${node.id}`}
              aria-label={railNodeName(node)}
              aria-current={node.current ? "step" : undefined}
              data-state={node.state}
              className={clsx("tap flex min-h-11 max-w-full min-w-11 flex-col items-center pb-1 text-center", !tight && "px-1")}
              onClick={(e) => {
                if (!jumpToSection(node.id, { smooth: true })) return;
                e.preventDefault();
                history.replaceState(history.state, "", `#${node.id}`);
              }}
            >
              <RailDot node={node} />
              <span
                aria-hidden
                className={clsx(
                  "rail-label mt-2 max-w-full truncate",
                  tight && "tracking-[0.04em]",
                  node.current ? "text-fg" : node.state === "done" ? "text-fg-2" : "text-mute",
                )}
              >
                {node.name}
              </span>
              <span aria-hidden className={clsx("num mt-0.5 max-w-full truncate text-xs", node.current ? "text-fg-2" : "text-mute")}>
                {railStatus(node)}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** A node's 24px dot, one look per state (the rings sit on ink so the line doesn't show through). */
function RailDot({ node }: { node: RailNode }) {
  const base = "relative grid h-6 w-6 shrink-0 place-items-center rounded-full";
  const ink = "bg-ink-950";
  switch (node.state) {
    case "done":
      return (
        <span className={clsx(base, "bg-accent text-accent-ink shadow-(--glow-accent)")}>
          <Check size={12} strokeWidth={3.5} aria-hidden />
        </span>
      );
    case "active":
      return (
        <span
          data-ring=""
          className={clsx(base, "progress-ring shadow-[0_0_16px_-4px_rgb(183_243_106/0.6)]")}
          style={{ "--progress": fraction(node.count) } as CSSProperties}
        >
          <span className="absolute inset-[3px] rounded-full bg-ink-950" />
          <span className="relative h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
      );
    case "skipped":
      return (
        <span className={clsx(base, ink, "shadow-[inset_0_0_0_1.5px_var(--ring-quiet)]")}>
          <span className="hatch absolute inset-1 rounded-full" />
        </span>
      );
    case "missed":
      return (
        <span className={clsx(base, ink, "shadow-[inset_0_0_0_1.5px_var(--ring-quiet)]")}>
          <span className="h-[1.5px] w-2 rounded-full bg-mute" />
        </span>
      );
    case "planned":
      return (
        <span className={clsx(base, ink, "shadow-[inset_0_0_0_1.5px_var(--ring-open)]")}>
          <span className="absolute -inset-1 rounded-full border border-dashed border-(--ring-quiet)" />
        </span>
      );
    default:
      return <span className={clsx(base, ink, "shadow-[inset_0_0_0_1.5px_var(--ring-open)]")} />;
  }
}
