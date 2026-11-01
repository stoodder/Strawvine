import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

/**
 * Auto-growing, auto-saving text area that reads like writing, not a form field.
 * Saves after a pause in typing and on blur.
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

  useEffect(() => {
    if (!focused.current) {
      setText(value ?? "");
      lastSaved.current = value ?? "";
    }
  }, [value]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  const flush = (v: string) => {
    window.clearTimeout(timer.current);
    if (v === lastSaved.current) return;
    lastSaved.current = v;
    onSave(v.trim() ? v : null);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <textarea
      ref={ref}
      aria-label={ariaLabel}
      value={text}
      rows={minRows}
      placeholder={placeholder}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        flush(text);
      }}
      onChange={(e) => {
        const v = e.target.value;
        setText(v);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => flush(v), 900);
      }}
      className={clsx("field resize-none leading-relaxed text-fg-2 placeholder:text-faint", className)}
    />
  );
}
