/**
 * Reads pasted nutrition totals ("2140 212 150 70", "2140, P212 C150 F70",
 * "kcal 2140 protein 212g carbs 150g fat 70g", or a multi-line export from a meal app) into
 * calories / protein / carbs / fat. Pure; the Fuel editor shows the result for one-tap confirm.
 *
 * How it reads:
 * 1. Noise is dropped: parentheses, percentages, dates and clock times; "2,140" becomes 2140.
 * 2. Words become labels (calories, protein, carbs, fat, or "other" for any other nutrient —
 *    "saturated fat", "sodium" — so their numbers are never mistaken for ours). Units and
 *    unknown words are ignored.
 * 3. Labels bind to numbers on the same line: a glued label ("P212", "212p") or one followed by a
 *    colon ("Protein: 212") binds to its own number; the rest bind either all forwards
 *    ("protein 212") or all backwards ("212g protein"), whichever explains more numbers.
 * 4. Numbers left without a label fill the missing fields in the order calories, protein, carbs,
 *    fat — but only when that is unambiguous (nothing labelled at all, or no more loose numbers
 *    than missing fields), so a stray date can never become a calorie count.
 */

export interface NutritionTotals {
  calories: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

type Field = keyof NutritionTotals;
/** `netCarbs` stands in for carbs only when no total carbs were given. */
type Label = Field | "netCarbs" | "other";

const ORDER: readonly Field[] = ["calories", "proteinG", "carbsG", "fatG"];

/** Same bounds as the day log schema. */
const RANGE: Record<Field, [number, number]> = {
  calories: [0, 20000],
  proteinG: [0, 2000],
  carbsG: [0, 2000],
  fatG: [0, 2000],
};

const WORDS: Record<string, Label> = {
  kcal: "calories",
  kcals: "calories",
  cal: "calories",
  cals: "calories",
  calorie: "calories",
  calories: "calories",
  energy: "calories",
  p: "proteinG",
  pro: "proteinG",
  prot: "proteinG",
  protein: "proteinG",
  proteins: "proteinG",
  c: "carbsG",
  carb: "carbsG",
  carbs: "carbsG",
  carbohydrate: "carbsG",
  carbohydrates: "carbsG",
  f: "fatG",
  fat: "fatG",
  fats: "fatG",
  lipids: "fatG",
};

/** Other nutrients: their numbers are bound and then ignored. */
const OTHER = new Set([
  "fiber",
  "fibre",
  "sugar",
  "sugars",
  "sodium",
  "salt",
  "potassium",
  "cholesterol",
  "calcium",
  "iron",
  "magnesium",
  "zinc",
  "vitamin",
  "alcohol",
  "water",
  "caffeine",
  "omega",
  "steps",
]);

/** Words that turn the following fat/carb label into a different nutrient. */
const QUALIFIERS = new Set(["saturated", "sat", "trans", "mono", "poly", "monounsaturated", "polyunsaturated", "added"]);

const MONTHS =
  "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";

type Tok =
  | { kind: "num"; value: number; line: number; start: number; end: number }
  | { kind: "label"; label: Label; line: number; start: number; end: number; colon: boolean };

function clean(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/\r\n?/g, "\n")
      // Asides such as "(630 kcal)" or "(35%)".
      .replace(/\([^()\n]*\)/g, " ")
      .replace(/\[[^[\]\n]*\]/g, " ")
      .replace(/\d+(?:\.\d+)?\s*%/g, " ")
      // Dates and times.
      .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
      .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/g, " ")
      .replace(new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, "g"), " ")
      .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\b(?:,?\\s+\\d{4})?`, "g"), " ")
      // Thousands separators ("2,140"), but not a comma-separated list ("2140,212,150,70").
      .replace(/(?<![\d.,])\d{1,3}(?:,\d{3})+(?![\d]|[.,]\d)/g, (m) => m.replace(/,/g, ""))
  );
}

function tokenize(text: string): Tok[] {
  const toks: Tok[] = [];
  const re = /(\d+(?:\.\d+)?)|([a-z]+)|(\n)/g;
  let line = 0;
  let lastWord: { label: Label | null; end: number; raw: string } | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[3]) {
      line++;
      lastWord = null;
      continue;
    }
    if (m[1]) {
      toks.push({ kind: "num", value: Number(m[1]), line, start, end });
      lastWord = null;
      continue;
    }
    const word = m[2]!;
    const prev = toks[toks.length - 1];
    // "saturated fat": the qualifier already made an "other" label; this word only extends it.
    const adjacent = lastWord !== null && /^[ \t-]*$/.test(text.slice(lastWord.end, start));
    if (adjacent && QUALIFIERS.has(lastWord!.raw) && prev?.kind === "label") {
      prev.end = end;
      lastWord = { label: prev.label, end, raw: word };
      continue;
    }
    if (adjacent && lastWord!.raw === "net" && (WORDS[word] === "carbsG" || word === "carb")) {
      toks.push({ kind: "label", label: "netCarbs", line, start, end, colon: false });
      lastWord = { label: "netCarbs", end, raw: word };
      continue;
    }
    const label: Label | null = QUALIFIERS.has(word) || OTHER.has(word) ? "other" : (WORDS[word] ?? null);
    // Single letters only count when glued to a number or punctuated ("P212", "212p", "P: 212"),
    // so a stray "c" or "f" in prose isn't read as a macro.
    if (label && word.length === 1) {
      const gluedBefore = prev?.kind === "num" && prev.end === start;
      const after = text.slice(end);
      if (!gluedBefore && !/^\s*[:=]?\s*\d/.test(after)) {
        lastWord = { label: null, end, raw: word };
        continue;
      }
    }
    if (label) toks.push({ kind: "label", label, line, start, end, colon: false });
    lastWord = { label, end, raw: word };
  }
  for (const t of toks) if (t.kind === "label") t.colon = /^\s*[:=]/.test(text.slice(t.end));
  return toks;
}

/** Returns null when nothing usable was found. Values are rounded to whole numbers. */
export function parseNutrition(input: string): NutritionTotals | null {
  if (!input || !input.trim()) return null;
  const text = clean(input);
  const toks = tokenize(text);
  const bound = new Map<number, Label>(); // number token index → label
  const used = new Set<number>(); // label token indexes already bound

  const isNum = (i: number, line: number) => toks[i]?.kind === "num" && toks[i]!.line === line && !bound.has(i);
  const bind = (num: number, lab: number) => {
    bound.set(num, (toks[lab] as Extract<Tok, { kind: "label" }>).label);
    used.add(lab);
  };

  // Fixed bindings: glued to a number, or followed by a colon.
  toks.forEach((t, i) => {
    if (t.kind !== "label") return;
    const next = toks[i + 1];
    const prev = toks[i - 1];
    if (next?.kind === "num" && next.start === t.end && isNum(i + 1, t.line)) bind(i + 1, i);
    else if (prev?.kind === "num" && prev.end === t.start && isNum(i - 1, t.line)) bind(i - 1, i);
    else if (t.colon && isNum(i + 1, t.line)) bind(i + 1, i);
  });

  // The rest all bind one way: whichever reads more numbers.
  const plan = (dir: 1 | -1) => {
    const out: Array<[number, number]> = [];
    toks.forEach((t, i) => {
      if (t.kind === "label" && !used.has(i) && isNum(i + dir, t.line)) out.push([i + dir, i]);
    });
    return out;
  };
  const fwd = plan(1);
  const back = plan(-1);
  const endsWithLabel = toks[toks.length - 1]?.kind === "label";
  const chosen = back.length > fwd.length || (back.length === fwd.length && endsWithLabel) ? back : fwd;
  for (const [n, l] of chosen) bind(n, l);

  const out: NutritionTotals = { calories: null, proteinG: null, carbsG: null, fatG: null };
  let net: number | null = null;
  let labelled = 0;
  const loose: number[] = [];
  toks.forEach((t, i) => {
    if (t.kind !== "num") return;
    const label = bound.get(i);
    if (label === undefined) loose.push(t.value);
    else if (label === "netCarbs") net ??= t.value;
    else if (label !== "other") {
      labelled++;
      out[label] ??= t.value;
    }
  });
  if (out.carbsG === null && net !== null) {
    out.carbsG = net;
    labelled++;
  }

  const missing = ORDER.filter((f) => out[f] === null);
  if (labelled === 0) loose.slice(0, ORDER.length).forEach((v, i) => (out[ORDER[i]!] = v));
  else if (loose.length <= missing.length) loose.forEach((v, i) => (out[missing[i]!] = v));

  for (const f of ORDER) {
    const v = out[f];
    if (v === null) continue;
    const [lo, hi] = RANGE[f];
    out[f] = v >= lo && v <= hi ? Math.round(v) : null;
  }
  return ORDER.some((f) => out[f] !== null) ? out : null;
}

/** How many fields a parse filled in. */
export function filledCount(t: NutritionTotals | null): number {
  return t ? ORDER.filter((f) => t[f] !== null).length : 0;
}
