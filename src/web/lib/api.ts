import { noteServerBuild } from "./build";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

/** True for failures a retry can fix: no response at all (offline, timeout), 5xx, 408, 429. */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  return e.status >= 500 || e.status === 408 || e.status === 429;
}

export interface ApiInit {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Extra request headers (e.g. `Idempotency-Key`). */
  headers?: Record<string, string>;
  /** Max wait for the response headers (default 8 s for reads, 15 s for writes). */
  timeoutMs?: number;
  /** Max wait for the whole body once headers arrived (default 60 s). */
  bodyTimeoutMs?: number;
  /** Called with the response headers as soon as they arrive (errors included). */
  onHeaders?: (headers: Headers) => void;
}

/** A readable message from the server's error body (`{ error, issues? }`). */
function errorMessage(status: number, data: unknown): string {
  const d = data as { error?: unknown; issues?: { path?: string; message?: string }[] } | null;
  const issue = d?.issues?.[0];
  if (issue?.message) return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
  if (typeof d?.error === "string" && d.error) return d.error;
  return `Request failed (${status})`;
}

export interface ConditionalResult<T> {
  /** 200 with a body, or 304 (`data` undefined: the copy whose ETag was sent is current). */
  status: 200 | 304;
  data?: T;
  etag: string | null;
}

/**
 * A GET that sends `If-None-Match: etag` and skips reading the body on 304, so revalidating a
 * large, unchanged resource costs one round trip and no parsing. Bypasses the HTTP cache (the
 * app keeps its own copy; health data shouldn't sit in the browser cache too).
 */
export async function apiConditional<T>(
  path: string,
  etag: string | null,
  init: Omit<ApiInit, "method" | "body"> = {},
): Promise<ConditionalResult<T>> {
  return send<ConditionalResult<T>>(path, { ...init, headers: { ...init.headers, ...(etag ? { "If-None-Match": etag } : {}) } }, true);
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  if (path === "/auth/login") await flushPendingLogout().catch(() => {});
  return send<T>(path, init, false);
}

async function send<T>(path: string, init: ApiInit, conditional: boolean): Promise<T> {
  const method = init.method ?? "GET";
  const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  let timer = window.setTimeout(
    () => ctrl.abort(new DOMException("Timed out", "TimeoutError")),
    init.timeoutMs ?? (method === "GET" ? 8_000 : 15_000),
  );
  try {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
      body,
      signal: ctrl.signal,
      ...(conditional ? { cache: "no-store" as const } : {}),
      // No `keepalive`: in testing, Chromium re-sent keepalive POSTs on a reused socket and
      // created rows twice. Writes survive page close via the persisted outbox instead.
    });
    noteServerBuild(res.headers.get("x-strawvine-build"));
    init.onHeaders?.(res.headers);
    if (conditional && res.status === 304) {
      void res.body?.cancel().catch(() => {});
      return { status: 304, etag: res.headers.get("etag") } as T;
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(() => ctrl.abort(new DOMException("Timed out", "TimeoutError")), init.bodyTimeoutMs ?? 60_000);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      // Not JSON (e.g. a proxy's error page): fine for errors, a bad response otherwise.
      if (res.ok) throw new ApiError(502, "Unexpected response from the server");
    }
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith("/auth/login")) window.dispatchEvent(new Event("strawvine:unauthorized"));
      throw new ApiError(res.status, errorMessage(res.status, data), data);
    }
    return (conditional ? { status: 200, data, etag: res.headers.get("etag") } : data) as T;
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}

// ---------------------------------------------------------------------------
// Server-side sign-out (retried until the server has heard it)
// ---------------------------------------------------------------------------

/** Set while a sign-out hasn't reached the server yet (the device is already signed out locally). */
const LOGOUT_PENDING_KEY = "strawvine:logout-pending";

function flag(key: string, on?: boolean): boolean {
  try {
    if (on === true) localStorage.setItem(key, "1");
    else if (on === false) localStorage.removeItem(key);
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

export const hasPendingLogout = () => flag(LOGOUT_PENDING_KEY);

/**
 * Tells the server to end the session (it also revokes the device's other sessions). When the
 * server can't be reached, remembers to retry (`flushPendingLogout`) and reports "offline".
 */
export async function serverLogout(): Promise<{ ok: boolean; reason?: "offline" | "error" }> {
  flag(LOGOUT_PENDING_KEY, true);
  try {
    await send("/auth/logout", { method: "POST", timeoutMs: 8_000 }, false);
    flag(LOGOUT_PENDING_KEY, false);
    return { ok: true };
  } catch (e) {
    if (isTransient(e)) return { ok: false, reason: "offline" };
    flag(LOGOUT_PENDING_KEY, false); // a 4xx won't change by retrying
    return { ok: false, reason: "error" };
  }
}

let flushing: Promise<void> | null = null;

/** Sends a sign-out that couldn't reach the server earlier (before anything else talks to it). */
export function flushPendingLogout(): Promise<void> {
  if (!hasPendingLogout()) return Promise.resolve();
  flushing ??= serverLogout()
    .then(() => undefined)
    .finally(() => (flushing = null));
  return flushing;
}

/** Whether the browser still holds a valid session cookie (no sign-out side effects on a 401). */
export async function probeSession(): Promise<boolean> {
  if (hasPendingLogout()) return false;
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(8000) });
    noteServerBuild(res.headers.get("x-strawvine-build"));
    return res.ok;
  } catch {
    return false;
  }
}
