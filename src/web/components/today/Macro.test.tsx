import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PROTEIN_OVER_TARGET_SCALE } from "../../../shared/nutrition";
import { Macro } from "../../screens/Today";
import { Bar, severityClass, severityColor, severityMix } from "../ui";

const fill = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-severity]")!;

describe("severityColor", () => {
  it("walks lime → caution → warn, leaving lime as soon as it's over", () => {
    expect(severityColor(0)).toBe("var(--color-accent)");
    // Just past the tolerance (6 % over a calorie target): already halfway to caution, not lime.
    expect(severityColor(0.05)).toBe("color-mix(in oklch, var(--color-accent), var(--color-caution) 55%)");
    expect(severityColor(0.25)).toBe("color-mix(in oklch, var(--color-accent), var(--color-caution) 75%)");
    expect(severityColor(0.5)).toBe("var(--color-caution)");
    expect(severityColor(0.75)).toBe("color-mix(in oklch, var(--color-caution), var(--color-warn) 50%)");
    expect(severityColor(1)).toBe("var(--color-warn)");
    expect(severityColor(3)).toBe("var(--color-warn)");
    expect(severityColor(-1)).toBe("var(--color-accent)");
    expect(severityColor(Number.NaN)).toBe("var(--color-accent)");
  });

  it("is monotonic: each step is at or past the one before along lime → caution → warn", () => {
    const pos = (s: number) => {
      const { from, t } = severityMix(s);
      return from === "accent" ? t : 1 + t; // 0…1 on the first leg, 1…2 on the second
    };
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const p = pos(i / 100);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
    expect(pos(0)).toBe(0);
    expect(pos(0.001)).toBeGreaterThanOrEqual(0.5); // a jump off lime
    expect(pos(1)).toBe(2);
  });

  it("falls back to the nearest token class (never lime once over) where color-mix is unsupported", () => {
    expect(severityClass(0, "bg")).toBe("bg-accent");
    expect(severityClass(0.05, "bg")).toBe("bg-caution");
    expect(severityClass(0.5, "bg")).toBe("bg-caution");
    expect(severityClass(0.74, "bg")).toBe("bg-caution");
    expect(severityClass(0.75, "bg")).toBe("bg-warn");
    expect(severityClass(1, "text")).toBe("text-warn");
    expect(severityClass(0.2, "text")).toBe("text-caution");
    expect(severityClass(0, "text")).toBe("text-accent");
  });
});

describe("Bar with a severity", () => {
  it("paints the mapped colour inline over the nearest-token class", () => {
    for (const sev of [0, 0.05, 0.3, 0.5, 0.8, 1]) {
      const { container, unmount } = render(<Bar value={1} severity={sev} />);
      const el = fill(container);
      expect(el.getAttribute("style")).toContain(`background-color: ${severityColor(sev)}`);
      expect(el.classList.contains(severityClass(sev, "bg"))).toBe(true);
      unmount();
    }
  });

  it("glows lime only at 0", () => {
    const { container, rerender } = render(<Bar value={1} severity={0} />);
    expect(fill(container).style.boxShadow).not.toBe("");
    rerender(<Bar value={1} severity={0.4} />);
    expect(fill(container).dataset.severity).toBe("0.4");
    expect(fill(container).style.boxShadow).toBe("");
  });

  it("keeps the tone API when no severity is given", () => {
    const { container } = render(<Bar value={0.5} tone="gold" />);
    expect(container.querySelector(".bg-gold")).not.toBeNull();
    expect(container.querySelector("[data-severity]")).toBeNull();
  });
});

describe("Macro", () => {
  const severityAt = (eaten: number, target = 200, scale?: typeof PROTEIN_OVER_TARGET_SCALE) => {
    const { container, unmount } = render(<Macro label="Carbs" eaten={eaten} target={target} scale={scale} />);
    const sev = Number(fill(container).dataset.severity);
    const over = screen.queryByText(/g over$/)?.textContent ?? null;
    unmount();
    return { sev, over };
  };

  it("stays lime with no 'over' note up to 5% over", () => {
    expect(severityAt(180)).toEqual({ sev: 0, over: null });
    expect(severityAt(210)).toEqual({ sev: 0, over: null });
  });

  it("turns yellow, then warn red, the further over it gets — and says so in words", () => {
    expect(severityAt(220)).toEqual({ sev: 0.25, over: "+20g over" }); // 10%
    expect(severityAt(230)).toEqual({ sev: 0.5, over: "+30g over" }); // 15%: caution yellow
    expect(severityAt(250)).toEqual({ sev: 1, over: "+50g over" }); // 25%: red
    expect(severityAt(320).sev).toBe(1);
  });

  it("colours the bar and the note by the severity's mapping", () => {
    const { container } = render(<Macro label="Fat" eaten={86} target={80} />); // 7.5% over → 0.125
    const sev = Number(fill(container).dataset.severity);
    expect(sev).toBeCloseTo(0.13, 2);
    const mapped = severityColor(0.125);
    expect(mapped).toBe("color-mix(in oklch, var(--color-accent), var(--color-caution) 62.5%)");
    expect(fill(container).getAttribute("style")).toContain(`background-color: ${mapped}`);
    const note = screen.getByText("+6g over");
    expect(note.getAttribute("style")).toContain(`color: ${mapped}`);
    expect(note.classList.contains("text-caution")).toBe(true);
    expect(fill(container).classList.contains("bg-caution")).toBe(true);
  });

  it("shows no note and no tint for a sub-gram overage on a tiny target", () => {
    expect(severityAt(4.3, 4)).toEqual({ sev: 0, over: null }); // 7.5 % over, but "+0g"
    expect(severityAt(4.6, 4)).toEqual({ sev: 0.5, over: "+1g over" });
  });

  it("is lenient with protein", () => {
    expect(severityAt(240, 200, PROTEIN_OVER_TARGET_SCALE)).toEqual({ sev: 0, over: null });
    expect(severityAt(300, 200, PROTEIN_OVER_TARGET_SCALE).sev).toBe(0.5);
  });
});
