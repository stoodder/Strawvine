/**
 * Idempotent creates. The client sends an `Idempotency-Key` (generated once per queued create
 * and persisted with it) on POSTs that create rows; if the response is lost and the request is
 * retried, the stored response is returned instead of creating the row twice.
 *
 * The key is claimed with `insert … on conflict do nothing` in the same transaction as the
 * create: a concurrent retry blocks on the uncommitted key row and then reads the committed
 * response; if the first attempt rolls back, the retry claims the key itself. Only successful
 * (2xx) responses are stored. Keys expire after IDEMPOTENCY_TTL_MS.
 */
import { eq, lt } from "drizzle-orm";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Db } from "./db/client";
import { idempotencyKeys } from "./db/schema";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60_000;
/** Opaque client token: UUIDs and similar. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,80}$/;

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface CreateResult {
  status: ContentfulStatusCode;
  body: unknown;
}

class Rollback extends Error {
  constructor(public result: CreateResult) {
    super("rollback");
  }
}

/** Deletes keys older than the TTL; returns how many were removed. */
export async function pruneIdempotencyKeys(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .delete(idempotencyKeys)
    .where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_TTL_MS)))
    .returning({ key: idempotencyKeys.key });
  return rows.length;
}

const PRUNE_EVERY_MS = 60 * 60_000;

/**
 * Returns a runner for idempotent creates bound to `db`. `create` runs in a transaction and
 * must use the transaction it is given; a non-2xx result is rolled back and not stored.
 */
export function idempotency(db: Db, onError: (err: unknown) => void = () => {}) {
  let lastPrune = 0;

  const prune = () => {
    const now = Date.now();
    if (now - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = now;
    void pruneIdempotencyKeys(db).catch(onError);
  };

  return async function run(c: Context, create: (tx: Tx) => Promise<CreateResult>): Promise<Response> {
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (key === undefined) {
      const r = await db.transaction(create);
      return c.json(r.body as object, r.status);
    }
    if (!KEY_PATTERN.test(key)) return c.json({ error: `Invalid ${IDEMPOTENCY_HEADER}` }, 400);
    const method = c.req.method;
    const path = c.req.path;

    let outcome: { fresh: CreateResult } | { replay: typeof idempotencyKeys.$inferSelect | undefined };
    try {
      outcome = await db.transaction(async (tx) => {
        const claimed = await tx
          .insert(idempotencyKeys)
          .values({ key, method, path, status: 0, body: null })
          .onConflictDoNothing()
          .returning({ key: idempotencyKeys.key });
        if (!claimed.length) {
          const [row] = await tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
          return { replay: row };
        }
        const r = await create(tx);
        if (r.status < 200 || r.status >= 300) throw new Rollback(r);
        await tx.update(idempotencyKeys).set({ status: r.status, body: r.body }).where(eq(idempotencyKeys.key, key));
        return { fresh: r };
      });
    } catch (err) {
      if (err instanceof Rollback) return c.json(err.result.body as object, err.result.status);
      throw err;
    }
    prune();

    if ("fresh" in outcome) return c.json(outcome.fresh.body as object, outcome.fresh.status);
    const row = outcome.replay;
    if (!row || row.status === 0) return c.json({ error: "A request with this key is still in progress" }, 409);
    if (row.method !== method || row.path !== path)
      return c.json({ error: `${IDEMPOTENCY_HEADER} was already used for a different request` }, 422);
    c.header("Idempotent-Replayed", "true");
    return c.json(row.body as object, row.status as ContentfulStatusCode);
  };
}
