/** Types for contrast.mjs. */
import type { Page } from "@playwright/test";

export interface ContrastResult {
  /** tag.classes[aria-label] of the element */
  what: string;
  /** dialog / nav / dock / section "heading" it sits in */
  where: string;
  text: string;
  /** 10th-percentile contrast over the pixels behind the text; null when nothing could be sampled */
  ratio: number | null;
  min?: number;
  required: number;
  /** sRGB 0–255 + alpha (opacity included) */
  fg: number[];
  bg: string | null;
  fontSize: number;
  large: boolean;
}

export function measureTextContrast(page: Page, opts?: { targets?: string[]; within?: string; highContrast?: boolean }): Promise<ContrastResult[]>;
export function formatContrast(r: ContrastResult): string;
