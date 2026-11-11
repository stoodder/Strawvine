import { describe, expect, it } from "vitest";
import { fmt, signed } from "./format";

describe("signed", () => {
  it("puts a plus or a real minus sign on a number", () => {
    expect(signed(1.26)).toBe("+1.3");
    expect(signed(-1.26)).toBe("−1.3");
    expect(signed(-1500, 0)).toBe("−1,500");
    expect(signed(25, 0)).toBe("+25");
  });

  it("puts no sign on what prints as zero: never '−0.0' or '+0.0'", () => {
    for (const n of [0, -0, 0.04, -0.04, 0.049, -0.049, -1e-9]) expect(signed(n), String(n)).toBe("0.0");
    for (const n of [0.4, -0.4, -0.49]) expect(signed(n, 0), String(n)).toBe("0");
    expect(signed(-0.004, 2)).toBe("0.00");
  });

  it("signs the first value that prints", () => {
    expect(signed(-0.05)).toBe("−0.1");
    expect(signed(0.05)).toBe("+0.1");
    expect(signed(-0.5, 0)).toBe("−1");
    expect(signed(-0.006, 2)).toBe("−0.01");
  });

  it("says when there is nothing to print", () => {
    for (const n of [null, undefined, Number.NaN]) expect(signed(n)).toBe("—");
    expect(fmt(null)).toBe("—");
  });
});
