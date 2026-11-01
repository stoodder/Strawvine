/**
 * Setup for the jsdom (component) test project: unmount between tests and fill in the few
 * browser APIs jsdom lacks that the components touch.
 */
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  document.body.innerHTML = '<div id="root"></div>';
});

document.body.innerHTML = '<div id="root"></div>';

// jsdom reports no layout, so getClientRects() is empty and every element looks hidden. The
// Sheet's focus trap skips hidden elements; give connected elements one rect.
const rects = Element.prototype.getClientRects;
Element.prototype.getClientRects = function (this: Element) {
  const r = rects.call(this);
  if (r.length || !this.isConnected) return r;
  return [{ x: 0, y: 0, width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }] as unknown as DOMRectList;
};

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// `inert` is a reflected boolean attribute in browsers; jsdom may not implement the property.
if (!("inert" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "inert", {
    get(this: HTMLElement) {
      return this.hasAttribute("inert");
    },
    set(this: HTMLElement, v: boolean) {
      this.toggleAttribute("inert", !!v);
    },
    configurable: true,
  });
}
