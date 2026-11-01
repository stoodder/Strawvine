import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Minus, Plus, X } from "lucide-react";
import { parseNum } from "../lib/format";
import { tick } from "../lib/haptics";

export function Section({
  label,
  right,
  children,
  className,
}: {
  label: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("mt-10", className)}>
      <div className="mb-4 flex items-center gap-3">
        <h2 className="label shrink-0">{label}</h2>
        <div className="rule flex-1" />
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  unit,
  sub,
  tone = "fg",
  size = "md",
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  sub?: ReactNode;
  tone?: "fg" | "accent" | "gold" | "mute";
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div className="min-w-0">
      <div className="label mb-1.5">{label}</div>
      <div
        className={clsx(
          "num leading-none font-light tracking-tight",
          size === "lg" ? "text-5xl" : size === "md" ? "text-[28px]" : "text-xl",
          tone === "accent" && "text-accent glow",
          tone === "gold" && "text-gold glow-gold",
          tone === "mute" && "text-fg-2",
        )}
      >
        {value}
        {unit && <span className="ml-1 text-[0.45em] font-normal tracking-normal text-mute">{unit}</span>}
      </div>
      {sub && <div className="mt-1.5 text-xs text-mute">{sub}</div>}
    </div>
  );
}

export function CheckDot({
  done,
  onClick,
  size = 26,
  tone = "accent",
  label,
}: {
  done: boolean;
  onClick?: () => void;
  size?: number;
  tone?: "accent" | "gold";
  label?: string;
}) {
  const color = tone === "gold" ? "var(--color-gold)" : "var(--color-accent)";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={done}
      onClick={(e) => {
        e.stopPropagation();
        tick();
        onClick?.();
      }}
      className="tap relative grid shrink-0 place-items-center rounded-full"
      style={{ width: size, height: size }}
    >
      <motion.span
        className="absolute inset-0 rounded-full"
        initial={false}
        animate={{
          backgroundColor: done ? color : "rgba(255,255,255,0)",
          boxShadow: done ? `0 0 18px -2px ${color}` : "inset 0 0 0 1.5px rgba(255,255,255,0.16)",
          scale: done ? [1, 1.18, 1] : 1,
        }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      />
      <AnimatePresence>
        {done && (
          <motion.span
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 26 }}
            className="relative text-accent-ink"
          >
            <Check size={size * 0.55} strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

export function Bar({
  value,
  tone = "accent",
  className,
}: {
  value: number;
  tone?: "accent" | "gold" | "mute" | "warn";
  className?: string;
}) {
  const v = Math.max(0, Math.min(1, value || 0));
  const color = tone === "gold" ? "bg-gold" : tone === "mute" ? "bg-fg-2/50" : tone === "warn" ? "bg-warn" : "bg-accent";
  return (
    <div className={clsx("h-[3px] overflow-hidden rounded-full bg-white/[0.06]", className)}>
      <motion.div
        className={clsx("h-full rounded-full", color)}
        initial={false}
        animate={{ width: `${v * 100}%` }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        style={{ boxShadow: v > 0 && tone === "accent" ? "0 0 12px rgb(183 243 106 / 0.45)" : undefined }}
      />
    </div>
  );
}

export function Ring({
  value,
  size = 64,
  stroke = 4,
  tone = "accent",
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: "accent" | "gold";
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value || 0));
  const color = tone === "gold" ? "var(--color-gold)" : "var(--color-accent)";
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90 overflow-visible">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,255,255,0.07)" strokeWidth={stroke} fill="none" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - v) }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          style={{ filter: v > 0 ? `drop-shadow(0 0 6px ${color})` : undefined }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}

/**
 * An inline number that looks like text until edited. Commits on blur / enter.
 */
export function NumberInput({
  value,
  onCommit,
  placeholder = "—",
  decimals = 0,
  className,
  inputClassName,
  unit,
  ariaLabel,
  autoFocus,
  min,
  max,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  placeholder?: string;
  decimals?: number;
  className?: string;
  inputClassName?: string;
  unit?: ReactNode;
  ariaLabel: string;
  autoFocus?: boolean;
  min?: number;
  max?: number;
}) {
  const show = (v: number | null) => (v === null ? "" : decimals ? String(+v.toFixed(decimals)) : String(Math.round(v)));
  const [text, setText] = useState(show(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    let n = parseNum(text);
    if (n !== null) {
      if (min !== undefined) n = Math.max(min, n);
      if (max !== undefined) n = Math.min(max, n);
      if (!decimals) n = Math.round(n);
    }
    if (n !== value) onCommit(n);
    setText(show(n));
  };

  return (
    <label className={clsx("inline-flex items-baseline gap-1", className)}>
      <input
        aria-label={ariaLabel}
        inputMode={decimals ? "decimal" : "numeric"}
        enterKeyHint="done"
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        onFocus={(e) => {
          focused.current = true;
          e.currentTarget.select();
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        }}
        onChange={(e) => setText(e.target.value)}
        className={clsx("field num min-w-0", inputClassName)}
        size={Math.max(2, (text || placeholder).length)}
      />
      {unit && <span className="text-xs text-mute">{unit}</span>}
    </label>
  );
}

export function Stepper({
  value,
  onChange,
  step = 1,
  min = 0,
  max = 9999,
  format = (v: number) => String(v),
  size = "md",
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  format?: (v: number) => ReactNode;
  size?: "md" | "xl";
}) {
  const btn = clsx(
    "tap grid shrink-0 place-items-center rounded-full bg-white/[0.05] text-fg-2 active:bg-white/[0.1]",
    size === "xl" ? "h-14 w-14" : "h-9 w-9",
  );
  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        className={btn}
        aria-label="Decrease"
        onClick={() => (tick(), onChange(Math.max(min, +(value - step).toFixed(2))))}
      >
        <Minus size={size === "xl" ? 22 : 16} />
      </button>
      <div className={clsx("num min-w-[3ch] text-center font-light", size === "xl" ? "text-7xl" : "text-2xl")}>{format(value)}</div>
      <button
        type="button"
        className={btn}
        aria-label="Increase"
        onClick={() => (tick(), onChange(Math.min(max, +(value + step).toFixed(2))))}
      >
        <Plus size={size === "xl" ? 22 : 16} />
      </button>
    </div>
  );
}

/** 1–5 scale rendered as dots. */
export function DotScale({
  value,
  onChange,
  label,
  lowLabel,
  highLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  lowLabel?: string;
  highLabel?: string;
}) {
  return (
    <div>
      <div className="label mb-2">{label}</div>
      <div className="flex items-center gap-2" role="radiogroup" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => {
          const on = value !== null && n <= value;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={`${label} ${n}`}
              onClick={() => (tick(), onChange(value === n ? null : n))}
              className="tap grid h-8 w-8 place-items-center"
            >
              <motion.span
                className="block rounded-full"
                initial={false}
                animate={{
                  width: on ? 12 : 8,
                  height: on ? 12 : 8,
                  backgroundColor: on ? "var(--color-accent)" : "rgba(255,255,255,0.14)",
                }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              />
            </button>
          );
        })}
      </div>
      {(lowLabel || highLabel) && (
        <div className="mt-1 flex w-[200px] justify-between text-[10px] text-faint">
          <span>{lowLabel}</span>
          <span>{highLabel}</span>
        </div>
      )}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => (tick(), onChange(!on))}
      className={clsx("tap relative h-7 w-12 shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-white/[0.1]")}
    >
      <motion.span
        className={clsx("absolute top-1 left-1 h-5 w-5 rounded-full", on ? "bg-accent-ink" : "bg-fg-2")}
        initial={false}
        animate={{ x: on ? 20 : 0 }}
        transition={{ type: "spring", stiffness: 600, damping: 35 }}
      />
    </button>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode }) {
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? id : undefined}
            className="absolute inset-x-0 bottom-0 mx-auto max-h-[88dvh] max-w-lg overflow-y-auto rounded-t-[28px] bg-ink-850/95 px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] shadow-[0_-20px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 38 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 600) onClose();
            }}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/15" />
            {title && (
              <div className="mb-5 flex items-center justify-between">
                <h3 id={id} className="text-lg font-medium">
                  {title}
                </h3>
                <button type="button" onClick={onClose} aria-label="Close" className="tap -mr-2 p-2 text-mute">
                  <X size={18} />
                </button>
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm text-fg-2">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-faint">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A boxed numeric input for sheets & forms. */
export function BoxNumber(props: Parameters<typeof NumberInput>[0]) {
  return (
    <NumberInput
      {...props}
      className={clsx("rounded-xl bg-white/[0.05] px-3 py-2", props.className)}
      inputClassName={clsx("w-16 text-right text-base", props.inputClassName)}
    />
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-sm leading-relaxed text-mute">{children}</div>;
}
