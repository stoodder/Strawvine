import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(url: string) {
  const local = /@(localhost|127\.0\.0\.1|db)(:|\/)/.test(url);
  // Heroku Postgres requires TLS but presents a certificate that isn't publicly chained.
  const sql = postgres(url, { ssl: local ? false : { rejectUnauthorized: false }, max: 5, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
}
