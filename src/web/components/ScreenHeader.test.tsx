/**
 * ScreenHeader: the one header of the screens that aren't a day — eyebrow row (with an optional
 * back control named after where it goes), the title in the shared h1 size, an optional tagline.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ScreenHeader } from "./ScreenHeader";

const classes = (el: Element) => el.className.split(/\s+/);

describe("ScreenHeader", () => {
  it("is a header: eyebrow row, then the h1, in the app's one title size and rhythm", () => {
    render(<ScreenHeader eyebrow="The why" title="Goals" />);
    const header = screen.getByRole("banner");
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(header.contains(h1)).toBe(true);
    expect(h1.textContent).toBe("Goals");
    // The eyebrow row is the title's previous sibling, and holds nothing but the eyebrow.
    const row = h1.previousElementSibling!;
    expect(row.textContent).toBe("The why");
    expect(header.firstElementChild).toBe(row);
    expect(header.lastElementChild).toBe(h1);
    expect(screen.queryByRole("link")).toBeNull();
    // Today's and Train's title size (shrinks on a narrow phone), 6 units under an 11-unit row, 2 from the top.
    expect(classes(h1)).toEqual(expect.arrayContaining(["text-[clamp(1.75rem,11vw,2.75rem)]", "mt-6", "leading-none"]));
    expect(classes(row)).toContain("min-h-11");
    expect(classes(header)).toContain("pt-2");
  });

  it("shows the tagline under the title", () => {
    render(<ScreenHeader eyebrow="Preferences" title="Settings" tagline="Nothing here is set in stone." />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.nextElementSibling!.tagName).toBe("P");
    expect(h1.nextElementSibling!.textContent).toBe("Nothing here is set in stone.");
  });

  it("the back control comes first, leads where it says, and is named after it", () => {
    render(
      <MemoryRouter>
        <ScreenHeader
          eyebrow={<span data-program-name="">Linear cycle</span>}
          title="Program"
          back={{ to: "/train/2026-10-19", label: "Back to Train" }}
        />
      </MemoryRouter>,
    );
    const back = screen.getByRole("link", { name: "Back to Train" });
    expect(back.getAttribute("href")).toBe("/train/2026-10-19");
    const row = screen.getByRole("heading", { level: 1 }).previousElementSibling!;
    expect(row.firstElementChild).toBe(back);
    // A full 44px target; the eyebrow may be any node, and truncates rather than pushing the row wide.
    expect(classes(back)).toEqual(expect.arrayContaining(["h-11", "w-11"]));
    const eyebrow = document.querySelector("[data-program-name]")!.parentElement!;
    expect(classes(eyebrow)).toEqual(expect.arrayContaining(["truncate", "min-w-0"]));
  });

  it("takes extra classes on the header (Progress pads under it)", () => {
    render(<ScreenHeader eyebrow="The trend" title="Progress" className="pb-5" />);
    expect(classes(screen.getByRole("banner"))).toEqual(expect.arrayContaining(["pt-2", "pb-5"]));
  });
});
