/**
 * Inline text editing: an input that reads as plain text until it's focused, when a hairline
 * appears under it. Commits on blur / Enter (trimmed, only when changed), Escape reverts.
 * `required` keeps an empty value from being saved and says why; `maxLength` caps the length.
 *
 *   <InlineText ariaLabel="Program name" value={program.name} required maxLength={60}
 *     requiredMessage="Give the program a name." onCommit={(name) => setProgram({ name })} />
 */
import clsx from "clsx";
import { useEffect, useId, useRef, useState } from "react";
import { useFieldIds } from "./ui";

export function InlineText({
  value,
  onCommit,
  ariaLabel,
  required = false,
  requiredMessage = "This can't be empty.",
  maxLength,
  placeholder,
  className,
  inputClassName,
}: {
  value: string;
  /** Called with the trimmed text when it changed (and is valid). */
  onCommit: (v: string) => void;
  ariaLabel: string;
  required?: boolean;
  requiredMessage?: string;
  maxLength?: number;
  placeholder?: string;
  /** Classes for the wrapper (width / layout). */
  className?: string;
  /** Classes for the input (type size / colour). */
  inputClassName?: string;
}) {
  const field = useFieldIds();
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);
  const cancelled = useRef(false);
  // The last value saved from here: the `value` prop catches up a moment later (after the save),
  // and a blur in between must not save the same text twice.
  const saved = useRef(value);
  const errorId = useId();

  // Follow outside changes (another device, an undo) while not editing.
  useEffect(() => {
    saved.current = value;
    if (!focused.current) {
      setText(value);
      setError(null);
    }
  }, [value]);

  const validate = (t: string): string | null => {
    if (required && !t) return requiredMessage;
    if (maxLength !== undefined && t.length > maxLength) return `Up to ${maxLength} characters.`;
    return null;
  };

  const commit = () => {
    const t = text.trim();
    const e = validate(t);
    setError(e);
    if (e) return;
    setText(t);
    if (t !== saved.current) {
      saved.current = t;
      onCommit(t);
    }
  };

  const describedBy = [field?.describedBy, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={clsx("min-w-0", className)}>
      <input
        type="text"
        aria-label={field ? undefined : ariaLabel}
        aria-labelledby={field ? field.labelId : undefined}
        aria-invalid={!!error || field?.invalid || undefined}
        aria-describedby={describedBy}
        enterKeyHint="done"
        autoComplete="off"
        spellCheck={false}
        value={text}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(validate(e.target.value.trim()));
        }}
        onFocus={() => {
          focused.current = true;
          cancelled.current = false;
        }}
        onBlur={() => {
          focused.current = false;
          if (cancelled.current) {
            cancelled.current = false;
            return;
          }
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            // Blur commits; an invalid value stays focused with its message.
            const err = validate(text.trim());
            if (err) setError(err);
            else e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation(); // don't close an enclosing sheet
            cancelled.current = true;
            setText(saved.current);
            setError(null);
            e.currentTarget.blur();
          }
        }}
        className={clsx("inline-text", inputClassName)}
      />
      {error && (
        <div id={errorId} role="alert" className="mt-1.5 text-xs text-warn">
          {error}
        </div>
      )}
    </div>
  );
}
