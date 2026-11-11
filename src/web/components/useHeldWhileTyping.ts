/**
 * What a screen shows *around* its fields holds still while one of them is being typed in.
 *
 * A value is saved as its field is left — often for the next field, a phone's keyboard still up —
 * and what the app makes of the saved value (a signal, a row's summary, a progress bar) may be a
 * line taller or shorter than before. Above the field just tapped, that moves the field: under a
 * thumb, or out from over the keyboard. So the display is held at what it showed when typing
 * began, and catches up when no field has focus any more.
 *
 *   const still = useHeldWhileTyping({ insights, items, day }, date);
 *   <Signals insights={still.insights} />          // holds while a field has focus
 *   <Editor day={day} />                            // the fields themselves stay live
 *
 * View state only: nothing is saved later, batched or skipped for it — the data is as live as ever,
 * only what is shown of it waits.
 */
import { useEffect, useRef, useState } from "react";
import { isEditable } from "./ui";

/**
 * Whether a field is being typed in: from the moment an editable control takes focus (or, focus
 * already there, is typed into) until focus has left editable controls — field to field keeps it.
 *
 * It ends a task after focus left, and never while a pointer is down: a tap on a button moves
 * focus off the field on its way to the click (Android, desktop; iOS leaves focus in the field),
 * and a display that caught up in between would move the button out from under that tap. Coming
 * back to the foreground ends it too, whatever still has focus (the keyboard is down; the next
 * keystroke starts it again), so the screen is never stale on return.
 */
export function useTyping(): boolean {
  const [typing, setTyping] = useState(() => typeof document !== "undefined" && isEditable(document.activeElement));
  const settleRef = useRef<() => void>(() => {});

  useEffect(() => {
    let pressed = false;
    let timer: number | undefined;
    /** End it once nothing editable has focus and no press is under way — checked a task from now. */
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!pressed && !isEditable(document.activeElement)) setTyping(false);
      }, 0);
    };
    settleRef.current = settle;
    const begin = (e: Event) => {
      if (!isEditable(e.target as Element | null)) return;
      window.clearTimeout(timer);
      setTyping(true);
    };
    const onFocusOut = (e: FocusEvent) => {
      // Field to field: still typing (the focusin that follows says so too).
      if (!isEditable(e.relatedTarget as Element | null)) settle();
    };
    const onDown = () => {
      pressed = true;
    };
    const onUp = () => {
      pressed = false;
      settle();
    };
    const onVisibility = () => {
      pressed = false;
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      setTyping(false);
    };
    const opts = { capture: true } as const;
    document.addEventListener("focusin", begin, opts);
    document.addEventListener("beforeinput", begin, opts);
    document.addEventListener("focusout", onFocusOut, opts);
    document.addEventListener("pointerdown", onDown, opts);
    document.addEventListener("pointerup", onUp, opts);
    document.addEventListener("pointercancel", onUp, opts);
    // The end of a press, should its pointerup have gone missing.
    document.addEventListener("click", onUp, opts);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      settleRef.current = () => {};
      document.removeEventListener("focusin", begin, opts);
      document.removeEventListener("beforeinput", begin, opts);
      document.removeEventListener("focusout", onFocusOut, opts);
      document.removeEventListener("pointerdown", onDown, opts);
      document.removeEventListener("pointerup", onUp, opts);
      document.removeEventListener("pointercancel", onUp, opts);
      document.removeEventListener("click", onUp, opts);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // The focused field can also go without any event: an element removed from the page (its editor
  // closed, after its exit animation) fires no focusout. While typing, look again whenever nodes go.
  useEffect(() => {
    if (!typing || typeof MutationObserver === "undefined") return;
    const gone = new MutationObserver(() => {
      if (!isEditable(document.activeElement)) settleRef.current();
    });
    gone.observe(document.body, { childList: true, subtree: true });
    return () => gone.disconnect();
  }, [typing]);

  return typing;
}

/**
 * `value`, except that while a field is being typed in (`useTyping`) it stays what it was when
 * typing began. `scope` is what the value belongs to (the day shown): a different scope is never
 * held back — it shows its own value at once, and holds that.
 */
export function useHeldWhileTyping<T>(value: T, scope: string): T {
  const typing = useTyping();
  const held = useRef({ scope, value });
  if (!typing || held.current.scope !== scope) held.current = { scope, value };
  return held.current.value;
}
