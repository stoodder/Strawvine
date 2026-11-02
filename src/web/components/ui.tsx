import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, Minus, Plus, X } from "lucide-react";
import { parseNum } from "../lib/format";
import { tick } from "../lib/haptics";

export function Section({
  label,
  right,
  children,
  className,
  id,
}: {
  label: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Makes the section a jump target (`#id`): it scrolls in with room above it (and the safe
   * area), and its heading can take focus (`[data-section-heading]`, tabIndex −1).
   */
  id?: string;
}) {
  return (
    <section id={id} className={clsx("mt-10", id && "scroll-mt-[calc(env(safe-area-inset-top)+1.25rem)]", className)}>
      {/* When the row runs out of room (narrow screens, zoom), `right` wraps under the label, right-aligned. */}
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="label shrink-0" tabIndex={id ? -1 : undefined} data-section-heading={id ? "" : undefined}>
          {label}
        </h2>
        <div className="rule min-w-4 flex-1" />
        {right && <div className="ml-auto flex shrink-0 items-center">{right}</div>}
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
          size === "lg" ? "text-5xl" : size === "md" ? "text-[1.75rem]" : "text-xl",
          tone === "accent" && "text-accent glow",
          tone === "gold" && "text-gold glow-gold",
          tone === "mute" && "text-fg-2",
        )}
      >
        {value}
        {/* The unit may drop to its own line when there's no room (zoom), instead of overflowing. */}
        {unit && <wbr />}
        {unit && <span className="ml-1 text-[max(0.45em,0.6875rem)] font-normal tracking-normal text-mute">{unit}</span>}
      </div>
      {sub && <div className="mt-1.5 text-xs text-mute">{sub}</div>}
    </div>
  );
}

/** An invisible extension of a small control's hit area to at least `min` px square. */
function HitArea({ size, min = 44 }: { size: number; min?: number }) {
  const pad = Math.max(0, (min - size) / 2);
  if (!pad) return null;
  return <span aria-hidden className="absolute" style={{ inset: -pad }} />;
}

/** A round check. Looks 26px; the tap target is 44px (it extends invisibly past the dot). */
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
      // hc-edge: in high contrast the open dot gets a visible edge (its own ring is only 0.35 white).
      className="tap hc-edge relative grid shrink-0 place-items-center rounded-full"
      style={{ width: size, height: size }}
    >
      <HitArea size={size} />
      <motion.span
        className="absolute inset-0 rounded-full"
        initial={false}
        animate={{
          backgroundColor: done ? color : "rgba(255,255,255,0)",
          boxShadow: done ? `0 0 18px -2px ${color}` : "inset 0 0 0 1.5px rgba(255,255,255,0.35)",
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

/**
 * The over-target colour for a 0…1 severity (`overTargetSeverity`): lime at 0, caution yellow at
 * 0.5, warn red at 1, mixed in OKLCH in between so the hue walks lime → yellow → coral without a
 * muddy midpoint. Never gold: that stays for PRs and goals. A CSS colour, usable as a fill or as
 * text (every step is ≥ 8:1 on ink-950).
 */
export function severityColor(severity: number): string {
  const s = Math.max(0, Math.min(1, severity || 0));
  if (s === 0) return "var(--color-accent)";
  if (s === 1) return "var(--color-warn)";
  if (s === 0.5) return "var(--color-caution)";
  const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;
  return s <= 0.5
    ? `color-mix(in oklch, var(--color-accent), var(--color-caution) ${pct(s * 2)})`
    : `color-mix(in oklch, var(--color-caution), var(--color-warn) ${pct((s - 0.5) * 2)})`;
}

export function Bar({
  value,
  tone = "accent",
  severity,
  className,
}: {
  value: number;
  tone?: "accent" | "gold" | "mute" | "warn";
  /**
   * How far over its target the bar is (0…1, from `overTargetSeverity`). When given it decides the
   * colour (`severityColor`) instead of `tone`: lime at 0, through caution yellow to warn red.
   */
  severity?: number;
  className?: string;
}) {
  const v = Math.max(0, Math.min(1, value || 0));
  const sev = severity === undefined ? null : Math.max(0, Math.min(1, severity || 0));
  const accent = sev === null ? tone === "accent" : sev === 0;
  const color =
    sev !== null ? null : tone === "gold" ? "bg-gold" : tone === "mute" ? "bg-fg-2/50" : tone === "warn" ? "bg-warn" : "bg-accent";
  return (
    <div className={clsx("h-[3px] overflow-hidden rounded-full bg-[var(--track)]", className)}>
      <motion.div
        className={clsx("h-full rounded-full transition-colors duration-500 motion-reduce:transition-none", color)}
        data-severity={sev !== null ? Math.round(sev * 100) / 100 : undefined}
        initial={false}
        animate={{ width: `${v * 100}%` }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        style={{
          backgroundColor: sev !== null ? severityColor(sev) : undefined,
          // The lime glow belongs to lime only: an over-target bar is flat.
          boxShadow: v > 0 && accent ? "0 0 12px rgb(183 243 106 / 0.45)" : undefined,
        }}
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
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--track-ring)" strokeWidth={stroke} fill="none" />
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

// ---------------------------------------------------------------------------
// Class merging: a caller's width / alignment / size / padding beats a primitive's default.
// ---------------------------------------------------------------------------

const SIZE = /^text-(xs|sm|base|lg|[2-9]?xl|\[[^\]]*(px|rem|em)\])$/;
const ALIGN = /^text-(left|right|center|justify|start|end)$/;

/** Does a later class `b` override an earlier class `a`? (width, alignment, font size, padding) */
function overrides(b: string, a: string): boolean {
  const pre = (t: string) => t.replace(/^!/, "").match(/^(min-w|max-w|w|px|py|pl|pr|pt|pb|p)-/)?.[1];
  const pa = pre(a);
  const pb = pre(b);
  if (pa && pb) {
    if (pa === pb) return true;
    if (pb === "p") return pa.startsWith("p");
    if (pb === "px") return pa === "pl" || pa === "pr";
    if (pb === "py") return pa === "pt" || pa === "pb";
    return false;
  }
  return (ALIGN.test(a) && ALIGN.test(b)) || (SIZE.test(a) && SIZE.test(b));
}

/** clsx + a tiny conflict merge: a caller's width / alignment / font size / padding beats the default. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  const tokens = clsx(...parts)
    .split(/\s+/)
    .filter(Boolean);
  return tokens.filter((t, i) => !tokens.slice(i + 1).some((u) => overrides(u, t))).join(" ");
}

// ---------------------------------------------------------------------------
// Field wiring: a Field hands its label / hint / error ids to the control inside it.
// ---------------------------------------------------------------------------

export interface FieldIds {
  labelId: string;
  hintId?: string;
  errorId?: string;
  /** Space-separated ids for aria-describedby (hint and error), if any. */
  describedBy?: string;
  invalid: boolean;
}

const FieldContext = createContext<FieldIds | null>(null);

/** The ids of the enclosing `<Field>`, for custom controls. */
export function useFieldIds(): FieldIds | null {
  return useContext(FieldContext);
}

/**
 * An inline number that looks like text until edited. Commits on blur / enter.
 * Sizes itself to its content (field-sizing, with a ch-width fallback) unless the caller sets a width.
 */
export function NumberInput({
  value,
  onCommit,
  placeholder = "—",
  decimals = 0,
  className,
  inputClassName,
  unit,
  unitClassName,
  ariaLabel,
  autoFocus,
  min,
  max,
  width,
  align,
  onDraft,
  grouping = false,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  /** Called on every keystroke with the parsed (unclamped) number, before commit — e.g. to enable a Save button. */
  onDraft?: (v: number | null) => void;
  /** Show thousands separators ("15,000"). Typing with or without commas both work. */
  grouping?: boolean;
  placeholder?: string;
  decimals?: number;
  className?: string;
  inputClassName?: string;
  unit?: ReactNode;
  /** Unit text classes (default text-mute; boxed fields use text-fg-2 to keep 4.5:1 on their tint). */
  unitClassName?: string;
  ariaLabel: string;
  autoFocus?: boolean;
  min?: number;
  max?: number;
  /** CSS width of the input (e.g. "100%", "4ch"). Default: fit the content. */
  width?: string;
  align?: "left" | "right" | "center";
}) {
  const field = useFieldIds();
  const show = (v: number | null) => {
    if (v === null) return "";
    const n = decimals ? +v.toFixed(decimals) : Math.round(v);
    return grouping ? n.toLocaleString("en-US", { maximumFractionDigits: decimals }) : String(n);
  };
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

  const classes = cx("field num min-w-0", align && `text-${align}`, inputClassName);
  const callerSized = !!width || /(^|\s)!?w-/.test(classes);
  const chars = Math.max(1, (text || placeholder).length);
  const style: CSSProperties | undefined = width ? { width } : callerSized ? undefined : { width: `calc(${chars}ch + 2px)` };

  return (
    <label className={clsx("inline-flex items-baseline gap-1", className)}>
      <input
        aria-label={ariaLabel}
        aria-labelledby={field ? field.labelId : undefined}
        aria-describedby={field?.describedBy}
        aria-invalid={field?.invalid || undefined}
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
        onChange={(e) => {
          setText(e.target.value);
          onDraft?.(parseNum(e.target.value));
        }}
        className={clsx(classes, !callerSized && "size-to-content")}
        style={style}
      />
      {unit && <span className={clsx("text-xs", unitClassName ?? "text-mute")}>{unit}</span>}
    </label>
  );
}

/** A boxed numeric input for sheets & forms. Callers' width / alignment / size classes win. */
export function BoxNumber(props: Parameters<typeof NumberInput>[0]) {
  return (
    <NumberInput
      {...props}
      className={cx("box-field rounded-xl bg-white/[0.05] px-3 py-2", props.className)}
      inputClassName={cx("text-right text-base", props.inputClassName)}
      unitClassName={props.unitClassName ?? "text-fg-2"}
    />
  );
}

/**
 * − value + . With `editable`, tapping the value turns it into a numeric input
 * (commits on blur / enter, Escape cancels, clamped to min/max).
 */
export function Stepper({
  value,
  onChange,
  step = 1,
  min = 0,
  max = 9999,
  format = (v: number) => String(v),
  size = "md",
  editable = false,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  format?: (v: number) => ReactNode;
  size?: "md" | "xl";
  /** Tap the value to type a number. */
  editable?: boolean;
  /** Names the group and its buttons ("Decrease {label}" / "Increase {label}"). */
  label?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const valueBtnRef = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  const xl = size === "xl";
  const decimalStep = !Number.isInteger(step) || !Number.isInteger(value);

  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const btn = clsx(
    "tap hc-edge relative grid shrink-0 place-items-center rounded-full bg-white/[0.05] text-fg-2 active:bg-white/[0.1]",
    // md looks 36px but takes a 44px tap; xl is 56px already.
    // At 200% zoom (a ~195 px viewport) the xl stepper steps down so it fits a sheet.
    xl ? "h-14 w-14 max-[259px]:h-11 max-[259px]:w-11" : "h-9 w-9 after:absolute after:-inset-1 after:content-['']",
  );
  const valueCls = clsx("num min-w-[3ch] text-center font-light", xl ? "text-7xl max-[259px]:min-w-[2ch] max-[259px]:text-4xl" : "text-2xl");

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startEdit = () => {
    cancelled.current = false;
    setText(String(value));
    setEditing(true);
  };
  const finishEdit = () => {
    setEditing(false);
    if (cancelled.current) return;
    const n = parseNum(text);
    if (n !== null) {
      const next = clamp(+n.toFixed(2));
      if (next !== value) onChange(next);
    }
  };

  return (
    <div className={clsx("flex items-center gap-4", xl && "max-[259px]:gap-2")} role="group" aria-label={label}>
      <button
        type="button"
        className={btn}
        aria-label={label ? `Decrease ${label}` : "Decrease"}
        onClick={() => (tick(), onChange(clamp(+(value - step).toFixed(2))))}
      >
        <Minus size={xl ? 22 : 16} />
      </button>
      {editing ? (
        <input
          ref={inputRef}
          aria-label={label ?? "Value"}
          inputMode={decimalStep ? "decimal" : "numeric"}
          enterKeyHint="done"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            finishEdit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
              requestAnimationFrame(() => valueBtnRef.current?.focus());
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation(); // don't close an enclosing sheet
              cancelled.current = true;
              e.currentTarget.blur();
              requestAnimationFrame(() => valueBtnRef.current?.focus());
            }
          }}
          className={clsx("field", valueCls)}
          style={{ width: `${Math.max(3, text.length + 1)}ch` }}
        />
      ) : editable ? (
        <button
          ref={valueBtnRef}
          type="button"
          onClick={startEdit}
          aria-label={`${label ?? "Value"} ${value}, edit`}
          className={clsx("tap rounded-lg px-1", valueCls)}
        >
          <output aria-live="polite">{format(value)}</output>
        </button>
      ) : (
        <output aria-live="polite" aria-label={label ? `${label} ${value}` : undefined} className={valueCls}>
          {format(value)}
        </output>
      )}
      <button
        type="button"
        className={btn}
        aria-label={label ? `Increase ${label}` : "Increase"}
        onClick={() => (tick(), onChange(clamp(+(value + step).toFixed(2))))}
      >
        <Plus size={xl ? 22 : 16} />
      </button>
    </div>
  );
}

/**
 * 1–5 scale rendered as dots. A radio group: arrow keys move (roving tabindex), Escape / Delete
 * clears, tapping the selected dot again clears it — and the clear is announced.
 */
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
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [announce, setAnnounce] = useState("");
  const labelId = useId();
  const set = (n: number | null) => {
    tick();
    onChange(n);
    setAnnounce(n === null ? `${label} cleared` : "");
  };
  const onKey = (e: ReactKeyboardEvent, n: number) => {
    const move = (to: number) => {
      e.preventDefault();
      const t = Math.min(5, Math.max(1, to));
      refs.current[t - 1]?.focus();
      set(t);
    };
    if (e.key === "ArrowRight" || e.key === "ArrowUp") move(n + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") move(n - 1);
    else if (e.key === "Home") move(1);
    else if (e.key === "End") move(5);
    else if ((e.key === "Escape" || e.key === "Delete" || e.key === "Backspace") && value !== null) {
      e.preventDefault();
      e.stopPropagation();
      set(null);
    }
  };
  const focusable = value ?? 1;
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <div id={labelId} className="label">
          {label}
        </div>
        {value !== null && (
          <button type="button" className="label hit text-mute hover:text-fg-2" onClick={() => set(null)} aria-label={`Clear ${label}`}>
            · clear
          </button>
        )}
      </div>
      <div className="-my-1.5 flex items-center" role="radiogroup" aria-labelledby={labelId}>
        {[1, 2, 3, 4, 5].map((n) => {
          const on = value !== null && n <= value;
          return (
            <button
              key={n}
              ref={(el) => {
                refs.current[n - 1] = el;
              }}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={`${label} ${n} of 5`}
              tabIndex={n === focusable ? 0 : -1}
              onClick={() => set(value === n ? null : n)}
              onKeyDown={(e) => onKey(e, n)}
              className="tap grid h-11 w-10 place-items-center"
            >
              <motion.span
                className="block rounded-full"
                initial={false}
                animate={{
                  width: on ? 12 : 8,
                  height: on ? 12 : 8,
                  backgroundColor: on ? "var(--color-accent)" : "rgba(255,255,255,0.35)",
                }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
              />
            </button>
          );
        })}
      </div>
      {(lowLabel || highLabel) && (
        <div className="mt-1 flex w-[200px] justify-between text-2xs text-mute">
          <span>{lowLabel}</span>
          <span>{highLabel}</span>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}

/** A switch. Looks 28×48; the tap target is 44px tall. */
export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  const field = useFieldIds();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={field ? undefined : label}
      aria-labelledby={field ? field.labelId : undefined}
      aria-describedby={field?.describedBy}
      onClick={() => (tick(), onChange(!on))}
      className={clsx(
        "tap relative h-7 w-12 shrink-0 rounded-full transition-colors after:absolute after:-inset-x-1 after:-inset-y-2 after:content-['']",
        on ? "bg-accent" : "hc-edge bg-white/20",
      )}
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

// ---------------------------------------------------------------------------
// Sheet: a modal bottom sheet with focus management.
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[inert]") && el.getClientRects().length > 0);
}

/** Sheets open at once; #root stays inert while any is open. */
let openSheets = 0;
let rootWasInert = false;
const sheetListeners = new Set<() => void>();
function setOpenSheets(n: number) {
  const was = openSheets > 0;
  openSheets = n;
  if (was !== openSheets > 0) sheetListeners.forEach((l) => l());
}
/** Whether any Sheet is open (for useSyncExternalStore; e.g. the dock hides behind sheets). */
export const anySheetOpen = () => openSheets > 0;
export function subscribeSheets(l: () => void) {
  sheetListeners.add(l);
  return () => void sheetListeners.delete(l);
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  className,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Extra classes for the panel. */
  className?: string;
  /** Accessible name when there is no visible title. */
  ariaLabel?: string;
}) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const viaKeyboard = !!trigger?.matches(":focus-visible");

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Make the app behind the sheet inert (the sheet is portaled to <body>, outside #root).
    const root = document.getElementById("root");
    if (root) {
      if (openSheets === 0) rootWasInert = root.inert;
      root.inert = true;
    }
    setOpenSheets(openSheets + 1);

    // Move focus in: keep an autofocused control; keyboard users land on the first control;
    // touch users get the panel itself (no surprise keyboard).
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const first = viaKeyboard ? focusables(panel)[0] : undefined;
      (first ?? panel).focus({ preventScroll: true });
    }

    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      setOpenSheets(Math.max(0, openSheets - 1));
      if (root && openSheets === 0) root.inert = rootWasInert;
      try {
        if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
      } catch {
        /* trigger went away; leave focus where it is */
      }
    };
  }, [open]);

  const onPanelKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const els = focusables(panel);
    if (!els.length) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = els[0]!;
    const last = els[els.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? id : undefined}
            aria-label={!title ? ariaLabel : undefined}
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            className={clsx(
              "absolute inset-x-0 bottom-0 mx-auto max-h-[88dvh] max-w-lg overflow-y-auto rounded-t-[28px] bg-ink-850/95 px-5 pt-3 pb-[calc(env(safe-area-inset-bottom)+1.5rem)] shadow-[0_-20px_60px_-20px_rgba(0,0,0,0.8)] outline-none backdrop-blur-xl",
              className,
            )}
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
                <h3 id={id} className="min-w-0 text-lg font-medium wrap-anywhere">
                  {title}
                </h3>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="tap -my-2.5 -mr-3 grid h-11 w-11 shrink-0 place-items-center text-mute"
                >
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

/**
 * A labelled row: label (+ hint, + error) on the left, the control on the right.
 * The label and hint are wired to the control: a native element child gets aria-labelledby /
 * aria-describedby / aria-invalid directly; ui primitives (BoxNumber, NumberInput, Toggle) pick
 * them up from context; or pass a render function `(ids) => <Control .../>`.
 */
export function Field({
  label,
  children,
  hint,
  error,
}: {
  label: ReactNode;
  children: ReactNode | ((ids: FieldIds) => ReactNode);
  hint?: ReactNode;
  /** Inline validation message (announced). */
  error?: ReactNode;
}) {
  const base = useId();
  const ids: FieldIds = {
    labelId: `${base}-label`,
    hintId: hint ? `${base}-hint` : undefined,
    errorId: error ? `${base}-error` : undefined,
    describedBy: [hint && `${base}-hint`, error && `${base}-error`].filter(Boolean).join(" ") || undefined,
    invalid: !!error,
  };
  let control: ReactNode = typeof children === "function" ? children(ids) : children;
  if (typeof children !== "function" && isValidElement(children) && typeof children.type === "string") {
    const el = children as ReactElement<Record<string, unknown>>;
    control = cloneElement(el, {
      "aria-labelledby": el.props["aria-labelledby"] ?? ids.labelId,
      "aria-describedby": [el.props["aria-describedby"], ids.describedBy].filter(Boolean).join(" ") || undefined,
      "aria-invalid": el.props["aria-invalid"] ?? (ids.invalid || undefined),
    });
  }
  return (
    <div className="py-3">
      {/* The control wraps under the label (right-aligned) when both don't fit — e.g. at 200% zoom. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-[1_1_6rem]">
          <div id={ids.labelId} className="text-sm text-fg-2">
            {label}
          </div>
          {hint && (
            <div id={ids.hintId} className="mt-0.5 text-xs text-mute">
              {hint}
            </div>
          )}
        </div>
        <div className="ml-auto max-w-full shrink-0">
          <FieldContext.Provider value={ids}>{control}</FieldContext.Provider>
        </div>
      </div>
      {error && (
        <div id={ids.errorId} role="alert" className="mt-1.5 text-right text-xs text-warn">
          {error}
        </div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-6 text-sm leading-relaxed text-mute">{children}</div>;
}
