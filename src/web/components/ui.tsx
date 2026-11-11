import clsx from "clsx";
import { animate, AnimatePresence, motion, useMotionValue, type MotionValue } from "motion/react";
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
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
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

type SeverityToken = "accent" | "caution" | "warn";

/**
 * Where a 0…1 severity (`overTargetSeverity`) sits on the over-target scale: the two tokens it
 * mixes and how far (0…1) toward the second. Monotonic, in two legs (SPEC §3.1):
 *
 * - 0: pure accent lime (on target).
 * - (0, 0.5]: accent → caution, starting **halfway** (0.5 + s): anything past the tolerance is
 *   already visibly off-lime (OKLCH hue ≈ 117° against lime's 129°), reaching caution yellow
 *   (≈ 105°) at 0.5. A plain 2·s mix would be lime to the eye just past the tolerance.
 * - (0.5, 1]: caution → warn, linear (2·(s − 0.5)), warn red at 1.
 */
export function severityMix(severity: number): { from: SeverityToken; to: SeverityToken; t: number } {
  const s = Math.max(0, Math.min(1, severity || 0));
  if (s === 0) return { from: "accent", to: "accent", t: 0 };
  if (s <= 0.5) return { from: "accent", to: "caution", t: 0.5 + s };
  return { from: "caution", to: "warn", t: (s - 0.5) * 2 };
}

/**
 * The over-target colour for a 0…1 severity (`severityMix`): lime at 0, caution yellow at 0.5,
 * warn red at 1, mixed in OKLCH in between so the hue walks lime → yellow → coral without a
 * muddy midpoint. Never gold: that stays for PRs and goals. A CSS colour, usable as a fill or as
 * text (every step is ≥ 8:1 on ink-950). Pair it with `severityClass`, which paints the nearest
 * token where `color-mix()` isn't supported (Safari < 16.2).
 */
export function severityColor(severity: number): string {
  const { from, to, t } = severityMix(severity);
  if (t === 0) return `var(--color-${from})`;
  if (t === 1) return `var(--color-${to})`;
  return `color-mix(in oklch, var(--color-${from}), var(--color-${to}) ${Math.round(t * 1000) / 10}%)`;
}

// Spelled out so Tailwind generates them.
const SEVERITY_CLASS = {
  bg: { accent: "bg-accent", caution: "bg-caution", warn: "bg-warn" },
  text: { accent: "text-accent", caution: "text-caution", warn: "text-warn" },
} as const;

/**
 * The token nearest a severity's colour, as a class: the fallback under `severityColor`'s inline
 * mix (an unsupported inline `color-mix()` is dropped, so the class shows through). Never lime
 * once over: caution up to 0.75, warn from there.
 */
export function severityClass(severity: number, kind: "bg" | "text"): string {
  const { from, to, t } = severityMix(severity);
  return SEVERITY_CLASS[kind][t === 0 ? from : from === "accent" ? to : t < 0.5 ? from : to];
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
    sev !== null
      ? severityClass(sev, "bg")
      : tone === "gold"
        ? "bg-gold"
        : tone === "mute"
          ? "bg-fg-2/50"
          : tone === "warn"
            ? "bg-warn"
            : "bg-accent";
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
 * An inline number that looks like text until edited. Commits on blur / enter, rounded to
 * `decimals` (what is saved is what is shown). Out of `min`–`max` it clamps — or, with
 * `outOfRange="reject"`, keeps the previous value and says the range under the field.
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
  outOfRange = "clamp",
  rangeHint,
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
  /**
   * "clamp" (default): a value past `min` / `max` saves as the limit. "reject": nothing is saved,
   * the field keeps its previous value, is marked invalid and shows `rangeHint` under it (announced
   * politely) until the next accepted entry — for readings where the limit would look believable.
   */
  outOfRange?: "clamp" | "reject";
  /** The range shown when a value is rejected. Default: "min–max" and the unit, when it's text ("20–220 bpm"). */
  rangeHint?: string;
}) {
  const field = useFieldIds();
  const hintId = useId();
  const [rejected, setRejected] = useState(false);
  const round = (v: number) => (decimals ? +v.toFixed(decimals) : Math.round(v));
  const show = (v: number | null) => {
    if (v === null) return "";
    const n = round(v);
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
      n = round(n);
      if (outOfRange === "reject" && ((min !== undefined && n < min) || (max !== undefined && n > max))) {
        setRejected(true);
        setText(show(value));
        return;
      }
      if (min !== undefined) n = Math.max(min, n);
      if (max !== undefined) n = Math.min(max, n);
    }
    setRejected(false);
    if (n !== value) onCommit(n);
    setText(show(n));
  };

  const classes = cx("field num min-w-0", align && `text-${align}`, inputClassName);
  const callerSized = !!width || /(^|\s)!?w-/.test(classes);
  const chars = Math.max(1, (text || placeholder).length);
  const style: CSSProperties | undefined = width ? { width } : callerSized ? undefined : { width: `calc(${chars}ch + 2px)` };

  const describedBy = [field?.describedBy, rejected && hintId].filter(Boolean).join(" ") || undefined;
  const input = (
    <label className={clsx("inline-flex items-baseline gap-1", className)}>
      <input
        aria-label={ariaLabel}
        aria-labelledby={field ? field.labelId : undefined}
        aria-describedby={describedBy}
        aria-invalid={field?.invalid || rejected || undefined}
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
  if (outOfRange !== "reject") return input;
  const range = rangeHint ?? `${min ?? ""}–${max ?? ""}${typeof unit === "string" ? ` ${unit}` : ""}`;
  // The live region is always there (empty until a rejection), so the hint is announced when it appears.
  return (
    <div>
      {input}
      <div id={hintId} aria-live="polite" className={clsx(rejected && "mt-1.5 text-xs text-warn")}>
        {rejected && (
          <>
            <span className="sr-only">{ariaLabel} not saved: use </span>
            {range}
          </>
        )}
      </div>
    </div>
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
 * 1–5 scale rendered as numbered discs. A radio group: arrow keys move (roving tabindex), Escape /
 * Delete clears, tapping the selected disc again clears it — and the clear is announced.
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
      {/* Five numbered buttons (44px targets, 32px discs), filled up to the chosen one: the scale reads as
          tappable before anything is chosen, and the choice is the solid disc with its number. */}
      <div className="-mx-1.5 -my-1.5 flex w-[220px] max-w-[calc(100%+0.75rem)] items-center" role="radiogroup" aria-labelledby={labelId}>
        {[1, 2, 3, 4, 5].map((n) => {
          const state = value === null || n > value ? "off" : n === value ? "chosen" : "under";
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
              className="tap grid h-11 min-w-0 flex-1 place-items-center"
            >
              <span
                aria-hidden
                data-state={state}
                className={clsx(
                  "num grid h-8 w-8 place-items-center rounded-full text-sm transition-colors duration-200",
                  state === "chosen" && "bg-accent font-semibold text-accent-ink shadow-[0_0_14px_-2px_rgb(183_243_106/0.55)]",
                  state === "under" && "bg-accent/25 text-fg",
                  state === "off" && "bg-white/[0.08] text-fg-2",
                )}
              >
                {n}
              </span>
            </button>
          );
        })}
      </div>
      {(lowLabel || highLabel) && (
        <div className="mt-2 flex w-[208px] max-w-full justify-between text-xs text-mute">
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
/**
 * The page behind open sheets doesn't scroll. `overflow: hidden` on <body> can't do it: html
 * clips sideways overflow (styles.css), so body's overflow is no longer propagated to the
 * viewport, and iOS chains touch scrolling past it anyway. Instead body is pinned where it is —
 * `position: fixed`, offset by the scroll position — so the viewport has nothing to scroll (wheel,
 * touch, keys or `scrollTo`), and the position is put back on unlock. A classic scrollbar keeps
 * its track (html overflow-y: scroll) so the layout doesn't shift sideways. Every property set is
 * restored to its previous inline value.
 */
const LOCK_STYLES = ["position", "top", "left", "right", "overflow"] as const;
let pageLock: { y: number; body: string[]; htmlOverflowY: string } | null = null;
function lockPage() {
  if (pageLock) return;
  const { body, documentElement: html } = document;
  const y = window.scrollY;
  const hasScrollbar = window.innerWidth - html.clientWidth > 0;
  pageLock = { y, body: LOCK_STYLES.map((p) => body.style[p]), htmlOverflowY: html.style.overflowY };
  Object.assign(body.style, { position: "fixed", top: `${-y}px`, left: "0", right: "0", overflow: "hidden" });
  if (hasScrollbar) html.style.overflowY = "scroll";
  html.dataset.scrollLocked = "";
}
function unlockPage() {
  if (!pageLock) return;
  const { body, documentElement: html } = document;
  const { y } = pageLock;
  LOCK_STYLES.forEach((p, i) => (body.style[p] = pageLock!.body[i]!));
  html.style.overflowY = pageLock.htmlOverflowY;
  delete html.dataset.scrollLocked;
  pageLock = null;
  if (window.scrollY !== y) window.scrollTo(window.scrollX, y);
}

/** A control that raises a phone's keyboard: a text-like input, a textarea, contenteditable. */
const NOT_TYPED = new Set(["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image", "hidden"]);
export function isEditable(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return !NOT_TYPED.has(el.type) && !el.readOnly && !el.disabled;
  return el.isContentEditable;
}

/**
 * Keeps an open sheet's panel inside what is actually visible: above an on-screen keyboard and
 * inside any pan the browser makes to show a focused field. iOS Safari (and Chrome on Android, by
 * default) don't shrink the layout viewport — where `position: fixed` lives — for the keyboard:
 * it covers the bottom of the window, and the visual viewport shrinks above it and may be panned
 * down (`offsetTop`) to reveal the field. While a keyboard is up for a field in this sheet, the
 * overlay carries where the visible area is: `--sheet-bottom` (keyboard height, less any pan)
 * lifts the panel's bottom to the keyboard's top, `--sheet-room` caps its height to the visible
 * height (a little short of it), and `--sheet-safe: 0px` drops the home-indicator inset the
 * keyboard already covers.
 *
 * Only then: "a keyboard is up" means the visual viewport is shorter than the overlay (a pan left
 * over after the keyboard went down, with the full height visible, isn't one), and it has to be
 * for a field in this sheet (re-checked when one takes focus; focus leaving it waits for the keyboard to go) — a sheet that opens while
 * another sheet's keyboard is still going down stays on the window's bottom. Without that none
 * are set and the panel sits on the window's bottom as before. Pinch zoom is left alone (the
 * visible area is then a magnified part of the page). When the visible area just got shorter,
 * the focused field — if it was in view in the panel — is kept in view inside the now shorter
 * panel; otherwise the panel's scroll is the person's. Returns the cleanup.
 */
function followVisualViewport(overlay: HTMLElement): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const vars = ["--sheet-bottom", "--sheet-room", "--sheet-safe"] as const;
  /** The visible height at the last update (none yet: the first one with a keyboard counts as a shrink). */
  let lastHeight = Infinity;
  const update = (focused: Element | null = document.activeElement) => {
    const shrank = vv.height < lastHeight - 0.5;
    lastHeight = vv.height;
    const box = overlay.getBoundingClientRect();
    const field = isEditable(focused) && overlay.contains(focused) ? focused : null;
    const keyboard = box.height - vv.height >= 1;
    if (Math.abs(vv.scale - 1) > 0.01 || !keyboard || !field) {
      vars.forEach((v) => overlay.style.removeProperty(v));
      return;
    }
    const top = Math.max(0, vv.offsetTop - box.top);
    const bottom = Math.max(0, box.height - top - vv.height);
    // Whether the field was in view in the panel before it gets shorter (the person may have
    // scrolled it away on purpose).
    const panel = overlay.querySelector<HTMLElement>('[role="dialog"]');
    const inView = (() => {
      if (!panel || !shrank || !panel.contains(field)) return false;
      const p = panel.getBoundingClientRect();
      const f = field.getBoundingClientRect();
      return f.bottom > p.top && f.top < p.bottom;
    })();
    overlay.style.setProperty("--sheet-bottom", `${bottom}px`);
    overlay.style.setProperty("--sheet-room", `${Math.max(0, vv.height - 16)}px`);
    overlay.style.setProperty("--sheet-safe", "0px");
    if (panel && inView) {
      const p = panel.getBoundingClientRect();
      const f = field.getBoundingClientRect();
      if (f.bottom > p.bottom) panel.scrollTop += f.bottom - p.bottom + 16;
      else if (f.top < p.top) panel.scrollTop -= p.top - f.top + 16;
    }
  };
  const onViewport = () => update();
  // A field taking focus may lift the panel at once (a keyboard already up). Focus leaving one
  // doesn't drop it: the keyboard going down (a viewport resize) does. Dropping it on the
  // focusout would move the panel between a press and its release on a button (Android and
  // desktop focus a pressed button), and the press would miss.
  const onFocusIn = (e: FocusEvent) => {
    if (isEditable(e.target as Element | null)) update();
  };
  update();
  vv.addEventListener("resize", onViewport);
  vv.addEventListener("scroll", onViewport);
  overlay.addEventListener("focusin", onFocusIn);
  return () => {
    vv.removeEventListener("resize", onViewport);
    vv.removeEventListener("scroll", onViewport);
    overlay.removeEventListener("focusin", onFocusIn);
  };
}

/** A swipe down that far (px), or this fast at the end (px/s), closes a sheet. */
export const SWIPE_CLOSE_PX = 120;
export const SWIPE_CLOSE_SPEED = 600;

/** Whether `el` (up to and including `panel`) is scrolled away from its top. */
function scrolledDown(el: Element | null, panel: HTMLElement): boolean {
  for (let n = el; n; n = n.parentElement) {
    if (n.scrollTop > 0) return true;
    if (n === panel) break;
  }
  return false;
}

/**
 * Swipe down to close, without taking the panel's own scrolling away. Motion's `drag="y"` on the
 * panel set `touch-action: pan-x` on it, so a finger could never scroll a sheet's content (a
 * swipe down dragged it closed, a swipe up was clamped): only the wheel scrolled. Instead the
 * panel keeps native touch scrolling (with momentum), and the panel's `y` follows the finger:
 * - from the grab area (handle and title row, `touch-action: none`) always — pointer events, so
 *   a mouse can drag it too; a press on a button there stays a press;
 * - from the content only for a swipe that starts downward while the content is at its top
 *   (nothing under the finger scrolled down): that touch is the sheet's (its moves are
 *   prevented, so no rubber band); any other touch is a scroll, which stops at the top and never
 *   closes. Two fingers and range inputs (sliders) are left alone.
 * Let go past SWIPE_CLOSE_PX, or faster than SWIPE_CLOSE_SPEED, and it closes; otherwise it
 * springs back. Returns the cleanup.
 */
function swipeToClose(panel: HTMLElement, grab: HTMLElement | null, y: MotionValue<number | string>, close: () => void): () => void {
  /** Where the drag started, and its recent positions (for the speed at the end: the last 100 ms). */
  let drag: { y0: number; samples: { y: number; t: number }[]; pointer?: number } | null = null;
  const begin = (clientY: number, pointer?: number) => {
    drag = { y0: clientY, samples: [{ y: clientY, t: performance.now() }], pointer };
  };
  const follow = (clientY: number) => {
    if (!drag) return;
    const t = performance.now();
    drag.samples = [...drag.samples.filter((s) => t - s.t <= 100), { y: clientY, t }];
    y.set(Math.max(0, clientY - drag.y0));
  };
  const release = (cancelled = false) => {
    const d = drag;
    drag = null;
    if (!d) return;
    const first = d.samples[0]!;
    const last = d.samples[d.samples.length - 1]!;
    const offset = last.y - d.y0;
    // At least a frame's time, so two events in the same instant don't read as a flick.
    const speed = ((last.y - first.y) / Math.max(16, last.t - first.t)) * 1000;
    if (!cancelled && (offset > SWIPE_CLOSE_PX || (offset > 0 && speed > SWIPE_CLOSE_SPEED))) close();
    else animate(y, 0, { type: "spring", stiffness: 500, damping: 40 });
  };

  // The grab area: pointer events (touch-action none there, so the browser leaves them to us).
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || drag || (e.target instanceof Element && e.target.closest("button, a, input, select, textarea"))) return;
    begin(e.clientY, e.pointerId);
    try {
      grab?.setPointerCapture?.(e.pointerId);
    } catch {
      /* not capturable (synthetic event) */
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (drag && drag.pointer === e.pointerId) follow(e.clientY);
  };
  const onPointerEnd = (e: PointerEvent) => {
    if (drag && drag.pointer === e.pointerId) release(e.type === "pointercancel");
  };

  // The content: touch events, so a scroll stays the browser's.
  let touch: { x: number; y: number; mode: "pending" | "drag" | "scroll" } | null = null;
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    const target = e.target instanceof Element ? e.target : null;
    if (!t || e.touches.length > 1 || (target && grab?.contains(target)) || target?.closest('input[type="range"]')) {
      if (touch?.mode === "drag") release(true);
      touch = null;
      return;
    }
    touch = { x: t.clientX, y: t.clientY, mode: scrolledDown(target, panel) ? "scroll" : "pending" };
  };
  const onTouchMove = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!touch || !t || touch.mode === "scroll") return;
    if (touch.mode === "pending") {
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      if (dx === 0 && dy === 0) return;
      // Down (more than sideways) from the top: the sheet's. Anything else: a scroll.
      if (dy > 0 && dy >= Math.abs(dx) && panel.scrollTop <= 0) {
        touch.mode = "drag";
        begin(touch.y);
      } else {
        touch.mode = "scroll";
        return;
      }
    }
    if (e.cancelable) e.preventDefault();
    follow(t.clientY);
  };
  const onTouchEnd = (e: TouchEvent) => {
    if (touch?.mode === "drag") release(e.type === "touchcancel");
    touch = null;
  };

  grab?.addEventListener("pointerdown", onPointerDown);
  grab?.addEventListener("pointermove", onPointerMove);
  grab?.addEventListener("pointerup", onPointerEnd);
  grab?.addEventListener("pointercancel", onPointerEnd);
  panel.addEventListener("touchstart", onTouchStart, { passive: true });
  panel.addEventListener("touchmove", onTouchMove, { passive: false });
  panel.addEventListener("touchend", onTouchEnd);
  panel.addEventListener("touchcancel", onTouchEnd);
  return () => {
    grab?.removeEventListener("pointerdown", onPointerDown);
    grab?.removeEventListener("pointermove", onPointerMove);
    grab?.removeEventListener("pointerup", onPointerEnd);
    grab?.removeEventListener("pointercancel", onPointerEnd);
    panel.removeEventListener("touchstart", onTouchStart);
    panel.removeEventListener("touchmove", onTouchMove);
    panel.removeEventListener("touchend", onTouchEnd);
    panel.removeEventListener("touchcancel", onTouchEnd);
  };
}

/** Whether any Sheet is open (for useSyncExternalStore; e.g. the dock hides behind sheets). */
export const anySheetOpen = () => openSheets > 0;
export function subscribeSheets(l: () => void) {
  sheetListeners.add(l);
  return () => void sheetListeners.delete(l);
}

/**
 * The sheet's panel, mounted per open, with its own `y` (handed to the Sheet through `yRef` for
 * swipeToClose). The value starts where the entrance does (`initial.y`): a value that started at
 * 0 would jump to it as the panel mounts, and that jump's speed would carry into the entrance
 * spring (the panel dipped ~10 px below its start before rising). No `drag`: see swipeToClose.
 */
function SheetPanel({
  yRef,
  initial,
  ...props
}: ComponentProps<typeof motion.div> & { yRef: RefObject<MotionValue<number | string> | null>; initial: { y: number | string; opacity?: number } }) {
  const y = useMotionValue<number | string>(initial.y);
  yRef.current = y;
  return <motion.div {...props} initial={initial} style={{ ...(props.style as object), y }} />;
}

/**
 * A modal bottom sheet. Sizing classes passed in `className` can use the visible room above an
 * on-screen keyboard: `min-h-[min(80dvh,var(--sheet-room,80dvh))]` (see followVisualViewport).
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  className,
  ariaLabel,
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Extra classes for the panel. */
  className?: string;
  /** Accessible name when there is no visible title. */
  ariaLabel?: string;
  /**
   * The control to focus when the sheet opens, for touch and keyboard users alike — a sheet
   * that opens into a search field, say (a phone's keyboard comes up). Use this, not `autoFocus`,
   * for anything inside a sheet. The panel then comes in where it will stay (a short rise and
   * fade instead of the slide up from below) and the control is focused within the opening tap
   * (iOS only raises the keyboard for a focus in a user gesture) with `preventScroll`. A field
   * focused off screen mid-slide makes iOS scroll the page to reveal it above the keyboard; the
   * panel then slides on to its place, and the field ends up above the top of the screen.
   */
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const id = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const grabRef = useRef<HTMLDivElement>(null);
  /** The open panel's offset (SheetPanel): its entrance and exit, and a swipe down (swipeToClose). */
  const yRef = useRef<MotionValue<number | string> | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRef = useRef(initialFocus);
  initialFocusRef.current = initialFocus;

  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const viaKeyboard = !!trigger?.matches(":focus-visible");

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    if (openSheets === 0) lockPage();

    // Make the app behind the sheet inert (the sheet is portaled to <body>, outside #root).
    const root = document.getElementById("root");
    if (root) {
      if (openSheets === 0) rootWasInert = root.inert;
      root.inert = true;
    }
    setOpenSheets(openSheets + 1);

    // Move focus in: the sheet's initialFocus; else keyboard users land on the first control and
    // touch users get the panel itself (no surprise keyboard). Never scroll for it: the panel is
    // where it will be (initialFocus) or still coming in.
    const panel = panelRef.current;
    const wanted = initialFocusRef.current?.current;
    if (panel && wanted && panel.contains(wanted)) wanted.focus({ preventScroll: true });
    else if (panel && !panel.contains(document.activeElement)) {
      const first = viaKeyboard ? focusables(panel)[0] : undefined;
      (first ?? panel).focus({ preventScroll: true });
    }
    // After focus is in: a keyboard already up for the initialFocus field lifts the panel at once.
    const overlay = overlayRef.current;
    const stopFollowing = overlay ? followVisualViewport(overlay) : () => {};
    const y = yRef.current;
    const stopSwipe = panel && y ? swipeToClose(panel, grabRef.current, y, () => onCloseRef.current()) : () => {};

    return () => {
      stopFollowing();
      stopSwipe();
      window.removeEventListener("keydown", onKey);
      setOpenSheets(Math.max(0, openSheets - 1));
      if (root && openSheets === 0) root.inert = rootWasInert;
      // Scroll back before focus returns to the trigger (focus doesn't scroll: it's where it was).
      if (openSheets === 0) unlockPage();
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
        <motion.div ref={overlayRef} className="fixed inset-0 z-50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <SheetPanel
            ref={panelRef}
            yRef={yRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? id : undefined}
            aria-label={!title ? ariaLabel : undefined}
            tabIndex={-1}
            onKeyDown={onPanelKeyDown}
            className={clsx(
              "absolute inset-x-0 bottom-[var(--sheet-bottom,0px)] mx-auto max-h-[min(88dvh,var(--sheet-room,88dvh))] max-w-lg overflow-y-auto overscroll-contain rounded-t-[28px] bg-ink-850/95 px-5 pt-3 pb-[calc(var(--sheet-safe,env(safe-area-inset-bottom))+1.5rem)] shadow-[0_-20px_60px_-20px_rgba(0,0,0,0.8)] outline-none backdrop-blur-xl",
              className,
            )}
            // Opening into a field: in place (see initialFocus), else up from below.
            initial={initialFocus ? { y: 24, opacity: 0 } : { y: "100%" }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 38, opacity: { duration: 0.18 } }}
          >
            {/* The grab area (handle + title row): a swipe down here always drags the sheet. */}
            <div ref={grabRef} data-sheet-grab="" className="-mx-5 -mt-3 touch-none px-5 pt-3 select-none">
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
            </div>
            {children}
          </SheetPanel>
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

/**
 * A pressed/unpressed chip (aria-pressed): one choice of a ChipGroup, or a toggle of its own. A
 * pressed chip fills lime with a check — a choice made.
 */
export function ChoiceChip({
  on,
  onClick,
  disabled,
  children,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: string;
}) {
  // Locked chips stay focusable (aria-disabled, not disabled): Tab reaches them, and with them the
  // group's note saying why they're locked. Activating one does nothing.
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      className={clsx(
        "chip gap-1",
        on ? "bg-accent text-accent-ink" : "bg-white/[0.05] text-fg-2",
        disabled && !on && "opacity-40",
      )}
    >
      {on && <Check size={12} strokeWidth={3} aria-hidden />}
      {children}
    </button>
  );
}
