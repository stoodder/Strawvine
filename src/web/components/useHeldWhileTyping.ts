/**
 * What a screen shows *around* its fields holds still while one of them is being typed in.
 *
 * A value is saved as its field is left — often for the next field, a phone's keyboard still up —
 * and what the app makes of the saved value (a signal, a line under a row, a progress bar) may
 * make the page a line taller or shorter. Above the field just tapped, that moves the field:
 * under a thumb, or out from over the keyboard. So what would change the page's *height* is held
 * at what it was when typing began, and catches up when no field has focus any more.
 *
 *   const still = useHeldWhileTyping({ insights, targets }, date);
 *   <Signals insights={still.insights} />          // holds while a field has focus
 *   <Editor day={day} />                            // the fields themselves stay live
 *
 * Hold as little as that takes: whether a line or a block is there, not what an existing line
 * says — a held "not done" beside a value that makes it done would be untrue. View state only:
 * nothing is saved later, batched or skipped for it.
 */
import { useEffect, useRef, useState } from "react";
import { isEditable } from "./ui";

/** Pickers, not typing: they raise no keyboard to keep a field clear of, and may keep focus long after the pick. */
const PICKED = new Set(["date", "time", "datetime-local", "month", "week"]);

/** A control that is typed into (a text-like input, a text area, contenteditable) — not a date or time picker. */
function isTyped(el: EventTarget | null): boolean {
  if (!(el instanceof Element) || !isEditable(el)) return false;
  return !(el instanceof HTMLInputElement && PICKED.has(el.type));
}

/**
 * Whether a field is being typed in: from the moment a typed control takes focus (or is pressed,
 * or — focus already there — typed into) until focus has left typed controls. Field to field
 * keeps it, from the moment the first field is left (its value is saved in that very event).
 *
 * It ends a task after focus left, and never while a pointer is down. A tap on a button may take
 * focus from the field, or just blur it, on its way to the click (browsers differ, and so may the
 * same browser with and without an on-screen keyboard); a display that caught up in between could
 * move the button out from under that tap. Where the tap leaves focus in the field, typing simply
 * goes on. Coming back to the foreground ends it too, whatever still has focus — nobody's finger
 * is on the page, and the screen must not be stale on return; the next press on a field, move to
 * another field or keystroke starts it again.
 */
export function useTyping(): boolean {
  const [typing, setTyping] = useState(() => typeof document !== "undefined" && isTyped(document.activeElement));
  const settleRef = useRef<() => void>(() => {});

  useEffect(() => {
    let pressed = false;
    let timer: number | undefined;
    /** End it once nothing typed has focus and no press is under way — checked a task from now. */
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!pressed && !isTyped(document.activeElement)) setTyping(false);
      }, 0);
    };
    settleRef.current = settle;
    const begin = () => {
      window.clearTimeout(timer);
      setTyping(true);
    };
    const onTyped = (e: Event) => {
      if (isTyped(e.target)) begin();
    };
    const onFocusOut = (e: FocusEvent) => {
      // Field to field: typing goes on — said here, before the field being left saves its value
      // (the focusin that follows would be too late for a save that reaches the screen at once).
      if (isTyped(e.relatedTarget)) begin();
      else settle();
    };
    const onDown = (e: Event) => {
      pressed = true;
      // A press on a field is on its way to it (the browser may not name it when the other field blurs).
      if (isTyped(e.target)) begin();
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
    document.addEventListener("focusin", onTyped, opts);
    document.addEventListener("beforeinput", onTyped, opts);
    document.addEventListener("focusout", onFocusOut, opts);
    document.addEventListener("pointerdown", onDown, opts);
    document.addEventListener("pointerup", onUp, opts);
    // A press the browser took over (a scroll) or whose pointerup never came still ends: on its cancel, or its click.
    document.addEventListener("pointercancel", onUp, opts);
    document.addEventListener("click", onUp, opts);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      settleRef.current = () => {};
      document.removeEventListener("focusin", onTyped, opts);
      document.removeEventListener("beforeinput", onTyped, opts);
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
      if (!isTyped(document.activeElement)) settleRef.current();
    });
    gone.observe(document.body, { childList: true, subtree: true });
    return () => gone.disconnect();
  }, [typing]);

  return typing;
}

/**
 * `value`, except that while `holding` it stays what it was when the hold began. `scope` is what
 * the value belongs to (the day shown): a different scope is never held back — it shows its own
 * value at once, and holds that.
 */
export function useHeldWhile<T>(value: T, holding: boolean, scope = ""): T {
  const held = useRef({ scope, value });
  if (!holding || held.current.scope !== scope) held.current = { scope, value };
  return held.current.value;
}

/** `value`, held while a field is being typed in (`useTyping`, `useHeldWhile`). */
export function useHeldWhileTyping<T>(value: T, scope: string): T {
  return useHeldWhile(value, useTyping(), scope);
}
