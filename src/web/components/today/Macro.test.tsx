import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PROTEIN_OVER_TARGET_SCALE } from "../../../shared/nutrition";
import { Macro } from "../../screens/Today";
import { Bar, severityColor } from "../ui";

const fill = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-severity]")!;

describe("severityColor", () => {
  it("walks lime → caution → warn", () => {
    expect(severityColor(0)).toBe("var(--color-accent)");
    expect(severityColor(0.25)).toBe("color-mix(in oklch, var(--color-accent), var(--color-caution) 50%)");
    expect(severityColor(0.5)).toBe("var(--color-caution)");
    expect(severityColor(0.75)).toBe("color-mix(in oklch, var(--color-caution), var(--color-warn) 50%)");
    expect(severityColor(1)).toBe("var(--color-warn)");
    expect(severityColor(3)).toBe("var(--color-warn)");
  });
});

describe("Bar with a severity", () => {
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

  it("colours the note like the bar", () => {
    render(<Macro label="Fat" eaten={92} target={80} />); // 15% over
    expect(screen.getByText("+12g over").getAttribute("style")).toContain("color");
  });

  it("is lenient with protein", () => {
    expect(severityAt(240, 200, PROTEIN_OVER_TARGET_SCALE)).toEqual({ sev: 0, over: null });
    expect(severityAt(300, 200, PROTEIN_OVER_TARGET_SCALE).sev).toBe(0.5);
  });
});
