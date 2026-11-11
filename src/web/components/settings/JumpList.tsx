/** A long page's sections as a jump list under the title (Settings, Program). */
import { useEffect } from "react";
import { useLocation } from "react-router";

/** Scroll a section (`<Section id>`) into view and continue from its heading. */
export function jumpToSection(id: string, opts: { smooth?: boolean } = {}): boolean {
  const section = document.getElementById(id);
  if (!section) return false;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  section.scrollIntoView?.({ behavior: opts.smooth && !reduce ? "smooth" : "auto", block: "start" });
  // Keyboard and screen-reader users continue from the section's heading.
  section.querySelector<HTMLElement>("[data-section-heading]")?.focus({ preventScroll: true });
  return true;
}

/**
 * Arriving at `/program#layout` (a link, a redirect, a reload): bring that section in. The router
 * and the browser look for the anchor before a screen that loads on demand has rendered, so the
 * screen does it itself. A link followed from inside a sheet waits until the sheet has let go of
 * the page — closing, it puts the scroll position and focus back where they were.
 */
export function useJumpToHash() {
  const { hash, key } = useLocation();
  useEffect(() => {
    if (hash.length < 2) return;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    const html = document.documentElement;
    const locked = () => "scrollLocked" in html.dataset;
    if (!locked()) {
      jumpToSection(id);
      return;
    }
    const unlocked = new MutationObserver(() => {
      if (locked()) return;
      unlocked.disconnect();
      jumpToSection(id);
    });
    unlocked.observe(html, { attributes: true, attributeFilter: ["data-scroll-locked"] });
    return () => unlocked.disconnect();
  }, [hash, key]);
}

export function JumpList({ label, items }: { label: string; items: ReadonlyArray<readonly [id: string, name: string]> }) {
  return (
    <nav aria-label={label} className="mt-4 -ml-1.5">
      {/* On a phone, three tidy columns (six sections: two rows) rather than a ragged wrap; one
          row when there's room, and a plain wrap when zoomed in so far that three don't fit. */}
      <ul className="flex flex-wrap items-center gap-x-3 min-[20rem]:max-[28rem]:grid min-[20rem]:max-[28rem]:grid-cols-3">
        {items.map(([id, name]) => (
          <li key={id}>
            <a
              href={`#${id}`}
              // Underlined (a hairline under the word), so the items read as links, not labels.
              className="label inline-flex min-h-11 items-center px-1.5 text-fg-2 underline decoration-white/25 decoration-1 underline-offset-[5px] hover:decoration-accent"
              onClick={(e) => {
                if (!jumpToSection(id, { smooth: true })) return;
                e.preventDefault();
                history.replaceState(history.state, "", `#${id}`);
              }}
            >
              {name}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
