/**
 * Zod configuration, imported first by the app's entry point (before any schema is used).
 *
 * `jitless`: Zod otherwise probes whether it may compile parsers with `new Function` the first
 * time an object schema parses. The app's Content-Security-Policy forbids eval, so the probe
 * fails (harmlessly, it falls back) — but the browser reports a CSP violation on every load.
 */
import { z } from "zod";

z.config({ jitless: true });
