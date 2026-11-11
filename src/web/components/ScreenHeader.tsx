/**
 * The top of a screen that isn't a day (Program, Settings, Goals, Progress): an eyebrow row —
 * with a back control when the screen is reached from another one — then the title, then an
 * optional tagline. One rhythm for all of them, and the same as Today's and Train's, whose top
 * row holds the day controls instead: an 11-unit row, the title 6 units under it, in the type
 * size that shrinks on a narrow phone and at 200% zoom.
 */
import clsx from "clsx";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ChevronLeft } from "lucide-react";

export function ScreenHeader({
  eyebrow,
  title,
  tagline,
  back,
  className,
}: {
  /** The small line above the title. */
  eyebrow: ReactNode;
  title: ReactNode;
  /** One muted sentence under the title. */
  tagline?: ReactNode;
  /** Where the screen was reached from; `label` is the control's accessible name ("Back to Train"). */
  back?: { to: string; label: string };
  className?: string;
}) {
  return (
    <header className={clsx("pt-2", className)}>
      <div className="flex min-h-11 items-center gap-2">
        {back && (
          <Link to={back.to} aria-label={back.label} className="tap -ml-3 grid h-11 w-11 shrink-0 place-items-center text-mute">
            <ChevronLeft size={18} aria-hidden />
          </Link>
        )}
        <div className="label min-w-0 truncate text-fg-2">{eyebrow}</div>
      </div>
      {/* The one h1 size of the app (Today and Train use the same). */}
      <h1 className="mt-6 text-[clamp(1.75rem,11vw,2.75rem)] leading-none font-light tracking-tight">{title}</h1>
      {tagline && <p className="mt-3 text-sm text-mute">{tagline}</p>}
    </header>
  );
}
