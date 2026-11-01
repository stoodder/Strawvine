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
  /** Max wait for the response headers (default 8 s for reads, 15 s for writes). */
  timeoutMs?: number;
  /** Max wait for the whole body once headers arrived (default 60 s). */
  bodyTimeoutMs?: number;
}

/** A readable message from the server's error body (`{ error, issues? }`). */
function errorMessage(status: number, data: unknown): string {
  const d = data as { error?: unknown; issues?: { path?: string; message?: string }[] } | null;
  const issue = d?.issues?.[0];
  if (issue?.message) return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
  if (typeof d?.error === "string" && d.error) return d.error;
  return `Request failed (${status})`;
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
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
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body,
      signal: ctrl.signal,
      // No `keepalive`: in testing, Chromium re-sent keepalive POSTs on a reused socket and
      // created rows twice. Writes survive page close via the persisted outbox instead.
    });
    noteServerBuild(res.headers.get("x-strawvine-build"));
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
    return data as T;
  } finally {
    window.clearTimeout(timer);
    init.signal?.removeEventListener("abort", abort);
  }
}
