import clsx from "clsx";
import { useEffect, useId, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { ChevronRight, Download, LogOut, RefreshCw, UserX } from "lucide-react";
import { displayPrefs, minCalories } from "../../shared/defaults";
import { programPathForSettingsHash } from "../components/program/sections";
import { ScreenHeader } from "../components/ScreenHeader";
import { DayPicker, NumSetting } from "../components/settings/fields";
import { JumpList, useJumpToHash } from "../components/settings/JumpList";
import { useSettingsEditor } from "../components/settings/useSettingsEditor";
import { useToast } from "../components/Toast";
import { useFocusAfter } from "../components/useFocusAfter";
import { Field, Section, Toggle } from "../components/ui";
import { useTitle } from "../components/useTitle";
import { forgetDevice, signOut, useSyncInfo } from "../lib/store";
import { noteOfflineSignOut } from "./Login";

/** The page's sections, as a jump list under the title. */
const JUMPS = [
  ["targets", "Targets"],
  ["schedule", "Schedule"],
  ["nutrition", "Nutrition"],
  ["display", "Display"],
  ["sync", "Sync"],
  ["data", "Data"],
] as const;

/**
 * Settings (`/settings`): preferences — targets, schedule, nutrition, display, sync, data. The
 * training program lives on Program; an old link to a section that moved there (`/settings#program`,
 * `#training`) goes to it.
 */
export function SettingsScreen() {
  const { hash } = useLocation();
  const moved = programPathForSettingsHash(hash);
  return moved ? <Navigate to={moved} replace /> : <SettingsBody />;
}

function SettingsBody() {
  const { settings: s, error, save } = useSettingsEditor();
  const display = displayPrefs(s);
  useTitle("Settings");
  useJumpToHash();

  return (
    <div>
      {/* "Preferences": the rules of the training itself live on Program (› Rules). */}
      <ScreenHeader
        back={{ to: "/", label: "Back to Today" }}
        eyebrow="Preferences"
        title="Settings"
        tagline="Nothing here is set in stone. Change it and everything recalculates."
      />
      <JumpList label="Settings sections" items={JUMPS} />
      {error && (
        <p role="alert" className="mt-4 text-sm text-warn">
          {error}
        </p>
      )}

      <Section label="Daily targets" id="targets">
        <div className="divide-y divide-white/[0.04]">
          <NumSetting
            label="Steps"
            value={s.targets.steps}
            min={0}
            max={100_000}
            integer
            grouping
            onSave={(v) => v !== null && save({ ...s, targets: { ...s.targets, steps: v } })}
          />
          <NumSetting
            label="Zone 2"
            hint="Default duration when you check it off"
            value={s.targets.zone2Minutes}
            unit="min"
            min={0}
            max={600}
            unitInMessage=" min"
            onSave={(v) => v !== null && save({ ...s, targets: { ...s.targets, zone2Minutes: v } })}
          />
        </div>
      </Section>

      <Section label="Schedule" id="schedule">
        <DayPicker label="Metcon" value={s.schedule.metcon} onChange={(metcon) => save({ ...s, schedule: { ...s.schedule, metcon } })} />
        <div className="h-6" />
        <DayPicker label="Zone 2" value={s.schedule.zone2} onChange={(zone2) => save({ ...s, schedule: { ...s.schedule, zone2 } })} />
        {/* The lifting days, the cycle and its rules are the program, not a preference: they live on
            Program, whose back control returns here (state.from: this section). */}
        <Link
          to="/program"
          state={{ from: "/settings#schedule" }}
          className="tap mt-6 flex min-h-11 items-center gap-3 py-2"
          data-program-link=""
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-fg-2">Training program</span>
            <span className="mt-0.5 block text-xs text-mute">Lifting days, cycle, rules, rest timers and the exercise library</span>
          </span>
          <span className="label shrink-0" aria-hidden>
            Program
          </span>
          <ChevronRight size={14} className="shrink-0 text-mute" aria-hidden />
        </Link>
      </Section>

      <Section label="Nutrition" id="nutrition">
        <div className="divide-y divide-white/[0.04]">
          <NumSetting
            label="Protein"
            hint="Grams per lb of trend bodyweight"
            value={s.nutrition.proteinGPerLb}
            decimals={2}
            unit="g/lb"
            min={0}
            max={3}
            unitInMessage=" g"
            onSave={(v) => v !== null && save({ ...s, nutrition: { ...s.nutrition, proteinGPerLb: v } })}
          />
          <NumSetting
            label="Fat"
            hint="Grams per lb; carbs fill the rest"
            value={s.nutrition.fatGPerLb}
            decimals={2}
            unit="g/lb"
            min={0}
            max={2}
            unitInMessage=" g"
            onSave={(v) => v !== null && save({ ...s, nutrition: { ...s.nutrition, fatGPerLb: v } })}
          />
          <NumSetting
            label="Maintenance estimate"
            hint="Blended in while the TDEE calibrates. Leave empty for auto."
            value={s.nutrition.initialTdee}
            unit="kcal"
            placeholder="auto"
            optional
            grouping
            min={800}
            max={10_000}
            onSave={(v) => save({ ...s, nutrition: { ...s.nutrition, initialTdee: v } })}
          />
          <NumSetting
            label="Calories per lb"
            hint="Energy in a pound of bodyweight change"
            value={s.nutrition.kcalPerLb}
            unit="kcal"
            grouping
            min={1000}
            max={6000}
            onSave={(v) => v !== null && save({ ...s, nutrition: { ...s.nutrition, kcalPerLb: v } })}
          />
          <NumSetting
            label="Max loss"
            hint="% bodyweight per week"
            value={s.limits.maxLossPctPerWeek}
            decimals={2}
            unit="%"
            min={0}
            max={3}
            unitInMessage="%"
            onSave={(v) => v !== null && save({ ...s, limits: { ...s.limits, maxLossPctPerWeek: v } })}
          />
          <NumSetting
            label="Max gain"
            hint="% bodyweight per week"
            value={s.limits.maxGainPctPerWeek}
            decimals={2}
            unit="%"
            min={0}
            max={3}
            unitInMessage="%"
            onSave={(v) => v !== null && save({ ...s, limits: { ...s.limits, maxGainPctPerWeek: v } })}
          />
          <NumSetting
            label="Minimum calories"
            hint="Your daily target never goes below this, whatever the pace or the scale says"
            value={minCalories(s)}
            unit="kcal"
            integer
            grouping
            min={800}
            max={5000}
            onSave={(v) => v !== null && save({ ...s, limits: { ...s.limits, minCalories: v } })}
          />
        </div>
      </Section>

      <Section label="Display" id="display">
        <Field label="High contrast" hint="Brighter text and stronger edges for gym glare and sunlight">
          <Toggle
            label="High contrast"
            on={display.highContrast}
            onChange={(v) => save({ ...s, display: { ...display, highContrast: v } })}
          />
        </Field>
      </Section>

      <SyncSection />

      <Section label="Data" id="data">
        <div className="flex flex-wrap gap-3">
          <a href="/api/export" className="btn-ghost" download>
            <Download size={16} /> Export JSON
          </a>
          <SignOut />
        </div>
        <ForgetDevice />
      </Section>
      {/* decor: a sign-off, not information (aria-hidden; mute so it still clears 4.5:1 for anyone reading it) */}
      <p aria-hidden className="mt-12 text-center text-[0.6875rem] text-mute">
        Strawvine · built for pushing boundaries
      </p>
    </div>
  );
}

/**
 * Sign out. Edits that haven't reached the server yet are the one thing a sign-out can lose, so
 * with any pending it first asks whether to keep them on this device (they sync after the next
 * sign-in) or discard them. Offline, the device signs out at once and the server side is
 * finished on the next contact — the sign-in screen says so (see `noteOfflineSignOut`).
 */
function SignOut() {
  const info = useSyncInfo();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const focusAfter = useFocusAfter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstChoiceRef = useRef<HTMLButtonElement>(null);
  const questionId = useId();

  const run = async (keepUnsynced: boolean) => {
    setBusy(true);
    setFailed(false);
    // signOut switches the app to the sign-in screen at once (the server call finishes after);
    // land on Today when signing back in, not here.
    const pending = signOut({ keepUnsynced });
    navigate("/", { replace: true });
    let r: Awaited<ReturnType<typeof signOut>>;
    try {
      r = await pending;
    } catch {
      setBusy(false);
      setFailed(true);
      return;
    }
    // Offline, this device is signed out and the server side finishes on the next contact.
    if (!r.ok && r.reason === "offline") noteOfflineSignOut();
  };

  // Count rejected-but-unsaved edits too: discarding them at sign-out loses them just the same.
  const unsynced = info.unsynced ?? info.pending;
  if (asking && unsynced > 0)
    return (
      <div role="group" aria-labelledby={questionId} className="w-full rounded-2xl bg-white/[0.03] p-4">
        <p id={questionId} className="text-sm text-fg-2">
          {unsynced} {unsynced === 1 ? "change hasn't" : "changes haven't"} synced.
        </p>
        <p className="mt-1 text-xs text-mute">Keep them on this device to sync after you sign back in, or discard them.</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <button ref={firstChoiceRef} type="button" className="btn-ghost" disabled={busy} onClick={() => void run(true)}>
            Keep on this device
          </button>
          <button type="button" className="btn-ghost text-warn" disabled={busy} onClick={() => void run(false)}>
            Discard
          </button>
          <button
            type="button"
            className="btn text-mute"
            disabled={busy}
            onClick={() => {
              setAsking(false);
              focusAfter(() => triggerRef.current);
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn-ghost"
        disabled={busy}
        onClick={() => {
          if (unsynced > 0) {
            setAsking(true);
            focusAfter(() => firstChoiceRef.current);
          } else void run(false);
        }}
      >
        <LogOut size={16} /> {busy ? "Signing out…" : "Sign out"}
      </button>
      {failed && (
        <p role="alert" className="w-full text-xs text-warn">
          Couldn't sign out. Try again.
        </p>
      )}
    </>
  );
}

/** "just now" / "2 min ago" / "3 h ago" / a date — for "synced …". */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Sync status, what's waiting to reach the server, and what the server rejected. */
function SyncSection() {
  const info = useSyncInfo();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => setNow(Date.now()), [info.lastSyncedAt]);

  const synced = info.lastSyncedAt !== null ? `synced ${ago(info.lastSyncedAt, now)}` : "not synced yet";
  const parts: string[] = [];
  if (info.pending) parts.push(`${info.pending} pending`);
  if (info.failed) parts.push(`${info.failed} not saved`);
  if (!info.online) parts.push("offline");
  const status = parts.length ? parts.join(" · ") : `All changes saved · ${synced}`;
  const tone = info.failed ? "text-warn" : "text-fg-2";

  return (
    <Section label="Sync" id="sync">
      <p className={clsx("flex items-center gap-2 text-sm", tone)} role="status" aria-live="polite">
        <span
          aria-hidden
          className={clsx(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            info.failed ? "bg-warn" : !info.online ? "bg-faint" : info.pending ? "animate-pulse bg-accent" : "bg-accent",
          )}
        />
        {status}
      </p>
      {parts.length > 0 && <p className="mt-1 pl-3.5 text-xs text-mute">Last {synced}.</p>}
      {info.items.length > 0 && (
        <ul className="mt-4 divide-y divide-white/[0.04]" aria-label="Unsynced changes">
          {info.items.map((it) => (
            <li key={it.id} className="flex items-baseline justify-between gap-3 py-2.5">
              <span className="min-w-0 text-sm text-fg-2">
                {it.label}
                {it.failed && it.error && <span className="mt-0.5 block text-xs text-mute">{it.error}</span>}
              </span>
              <span className={clsx("label shrink-0", it.failed && "text-warn")}>{it.failed ? "not saved" : "pending"}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          className="btn-ghost"
          disabled={!info.online || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await info.syncNow();
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={16} className={clsx(busy && "motion-safe:animate-spin")} aria-hidden /> {busy ? "Syncing…" : "Sync now"}
        </button>
        {info.failed > 0 && (
          <>
            <button type="button" className="btn-ghost text-accent" onClick={info.retryFailed}>
              Retry failed
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                if (window.confirm(`Discard ${info.failed} change${info.failed === 1 ? "" : "s"} the server rejected?`))
                  info.discardFailed();
              }}
            >
              Discard failed
            </button>
          </>
        )}
      </div>
      {!info.online && <p className="mt-2 text-xs text-mute">Changes are kept on this device and sync when you're back online.</p>}
      <RefusedEdits now={now} />
    </Section>
  );
}

/**
 * Edits this device refused before queuing them (they would have been rejected by the server,
 * e.g. a value out of range from an old screen): what, why and when — the toast that said so is
 * long gone. Clear empties the list.
 */
function RefusedEdits({ now }: { now: number }) {
  const info = useSyncInfo();
  const focusAfter = useFocusAfter();
  const refused = info.refused;
  if (!refused.length) return null;
  return (
    <div className="mt-8" role="group" aria-labelledby="refused-heading" data-refused="">
      <div className="flex items-center justify-between gap-3">
        <h3 id="refused-heading" className="text-sm text-warn">
          Couldn't save
        </h3>
        <button
          type="button"
          className="label -my-3 -mr-2 inline-flex min-h-11 items-center px-2 text-mute"
          onClick={() => {
            info.clearRefused();
            // The list (and this button) go away: continue from the Sync section's heading.
            focusAfter(() => document.querySelector<HTMLElement>("#sync [data-section-heading]"));
          }}
        >
          Clear
        </button>
      </div>
      <p className="mt-1 text-xs text-mute">
        These edits weren't saved: the values weren't allowed. Enter them again if you still need them.
      </p>
      <ul className="mt-3 divide-y divide-white/[0.04]" aria-label="Edits that couldn't be saved">
        {[...refused].reverse().map((r) => (
          <li key={r.id} className="flex items-baseline justify-between gap-3 py-2.5">
            <span className="min-w-0 text-sm text-fg-2">
              {r.label}
              <span className="mt-0.5 block text-xs text-mute">{r.reason}</span>
            </span>
            <span className="label shrink-0">{ago(r.at, now)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Forget this device": the server signs this browser out and drops its known-device mark, so
 * the next sign-in is treated like a new device's; this device's copy (and anything not yet
 * synced) is wiped. Asks first, inline, saying how many unsynced edits would be lost. On
 * success the app is at the sign-in screen (landing on Today afterwards); offline or refused,
 * nothing changes and it says so.
 */
function ForgetDevice() {
  const info = useSyncInfo();
  const navigate = useNavigate();
  const [asking, setAsking] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  /** While forgetting: changes still being sent first (null until the first count). */
  const [sending, setSending] = useState<number | null>(null);
  const toast = useToast();
  const focusAfter = useFocusAfter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const questionId = useId();
  const unsynced = info.unsynced ?? info.pending;

  if (asking)
    return (
      <div ref={groupRef} role="group" aria-labelledby={questionId} className="mt-4 w-full rounded-2xl bg-white/[0.03] p-4">
        <p id={questionId} className="text-sm text-fg-2">
          Forget this device?
        </p>
        <p className="mt-1 text-xs leading-relaxed text-mute">
          This signs this device out and removes its copy of your data. It will be treated as a new device at the next sign-in. Everything
          stays on the server, and your other devices stay signed in.
        </p>
        {unsynced > 0 && (
          <p className="mt-2 text-xs text-warn">
            {unsynced} {unsynced === 1 ? "change hasn't synced and will be discarded" : "changes haven't synced and will be discarded"}{" "}
            (unless {unsynced === 1 ? "it goes" : "they go"} through first).
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-ghost text-warn"
            disabled={state === "busy"}
            onClick={async () => {
              setState("busy");
              setSending(null);
              let dropped = 0;
              try {
                // Sends what it can first (as long as changes get through), counting down here.
                ({ pendingDropped: dropped } = await forgetDevice({ onProgress: setSending }));
              } catch {
                setState("failed");
                setSending(null);
                return;
              }
              // The toast outlives this screen (it shows over the sign-in screen).
              if (dropped > 0)
                toast.show({
                  message: `${dropped} unsynced ${dropped === 1 ? "change was" : "changes were"} discarded`,
                  tone: "warn",
                  duration: 10_000,
                });
              // Signed out: land on Today after the next sign-in, not here.
              navigate("/", { replace: true });
            }}
          >
            {state === "busy" ? "Forgetting…" : "Forget"}
          </button>
          <button
            ref={cancelRef}
            type="button"
            className="btn text-mute"
            disabled={state === "busy"}
            onClick={() => {
              setAsking(false);
              setState("idle");
              focusAfter(() => triggerRef.current);
            }}
          >
            Cancel
          </button>
        </div>
        <p role="status" className="mt-3 text-xs text-mute empty:hidden">
          {state === "busy" && sending ? `Sending ${sending} ${sending === 1 ? "change" : "changes"} first…` : ""}
        </p>
        {state === "failed" && (
          <p role="alert" className="mt-3 text-xs text-warn">
            Couldn't reach Strawvine — try again when online. Nothing changed.
          </p>
        )}
      </div>
    );

  return (
    <div className="mt-4">
      <button
        ref={triggerRef}
        type="button"
        className="btn-ghost"
        onClick={() => {
          setAsking(true);
          setState("idle");
          // The question opens at the very bottom of the page, under the nav and dock: bring it to
          // the middle of the screen, then focus Cancel (the safe answer), never Forget.
          focusAfter(() => {
            groupRef.current?.scrollIntoView({ block: "center" });
            return cancelRef.current;
          });
        }}
      >
        <UserX size={16} aria-hidden /> Forget this device
      </button>
    </div>
  );
}
