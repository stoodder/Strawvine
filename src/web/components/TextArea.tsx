import clsx from "clsx";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Auto-growing, auto-saving text area that reads like writing, not a form field.
 * Saves after a pause in typing, on blur, when the app is hidden and on unmount.
 */
export function JournalText({
  value,
  onSave,
  placeholder,
  className,
  ariaLabel,
  minRows = 3,
}: {
  value: string | null;
  onSave: (v: string | null) => void;
  placeholder?: string;
  className?: string;
  ariaLabel: string;
  minRows?: number;
}) {
  const [text, setText] = useState(value ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const focused = useRef(false);
  const lastSaved = useRef(value ?? "");
  // Latest text and save callback, for flushes that run outside a render (timer, unmount, page hide).
  const latest = useRef(value ?? "");
  const onSaveRef = useRef(onSave);
  useLayoutEffect(() => {
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    if (!focused.current) {
      setText(value ?? "");
      latest.current = value ?? "";
      lastSaved.current = value ?? "";
    }
  }, [value]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const v = latest.current;
    if (v === lastSaved.current) return;
    lastSaved.current = v;
    onSaveRef.current(v.trim() ? v : null);
  }, []);

  // A pending (debounced) save must survive leaving the screen or backgrounding the app.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  // Flush with the page — no box. A hairline underneath brightens on focus so it's clear where
  // typing goes.
  return (
    <div className="group relative">
      <textarea
        ref={ref}
        aria-label={ariaLabel}
        value={text}
        rows={minRows}
        placeholder={placeholder}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          flush();
        }}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          latest.current = v;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(flush, 900);
        }}
        className={clsx(
          "block w-full resize-none bg-transparent pb-2 leading-relaxed text-fg-2 outline-none placeholder:text-faint",
          className,
        )}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-white/[0.06] transition-colors duration-300 group-focus-within:bg-accent/50"
      />
    </div>
  );
}
