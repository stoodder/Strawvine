/** The Program screen's sections: ids are jump targets (`/program#layout`), names the jump list's words. */
export const PROGRAM_SECTIONS = [
  ["now", "Now"],
  ["layout", "Layout"],
  ["weeks", "Weeks"],
  ["rules", "Rules"],
  ["rep-max", "Rep-max"],
  ["library", "Library"],
] as const;
export type ProgramSectionId = (typeof PROGRAM_SECTIONS)[number][0];

/**
 * Where an old Settings anchor lives now: the sections that moved to Program (`/settings#program`,
 * `/settings#training`), and Program's own ids should anyone reach for them under Settings. Null
 * for anything that is still on Settings.
 */
export function programPathForSettingsHash(hash: string): string | null {
  const id = hash.replace(/^#/, "");
  if (id === "program") return "/program";
  if (id === "training") return "/program#rules";
  return PROGRAM_SECTIONS.some(([section]) => section === id) ? `/program#${id}` : null;
}
