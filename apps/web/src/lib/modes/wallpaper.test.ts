import { afterEach, describe, expect, it, vi } from "vitest";
import { novaZones } from "./wallpaper.ts";

type Fake = {
  rect: [number, number, number, number];
  style?: Partial<
    Record<"display" | "visibility" | "opacity" | "pointerEvents", string>
  >;
  is?: string[];
  inside?: string[];
};

function element(fake: Fake, body: object) {
  return {
    parentElement: body,
    style: fake.style ?? {},
    getBoundingClientRect: () => {
      const [left, top, width, height] = fake.rect;
      return { left, top, width, height } as DOMRect;
    },
    matches: (selector: string) =>
      (fake.is ?? []).some((tag) => selector.includes(tag)),
    closest: (selector: string) =>
      (fake.inside ?? []).some((tag) => selector.includes(tag)) ? body : null,
  };
}

/** A page with a quiet-wallpaper sphere, a visible panel page, a button and a text field. */
function page(fakes: Record<string, Fake[]>, core?: Fake) {
  const body = {};
  const built = Object.fromEntries(
    Object.entries(fakes).map(([key, list]) => [
      key,
      list.map((fake) => element(fake, body)),
    ]),
  );
  const coreElement = core ? element(core, body) : null;
  vi.stubGlobal("document", {
    body,
    querySelector: () => null,
    getElementById: (id: string) => (id === "core" ? coreElement : null),
    querySelectorAll: (selector: string) =>
      Object.entries(built)
        .filter(([key]) => selector.startsWith(key))
        .flatMap(([, list]) => list),
  });
  vi.stubGlobal(
    "getComputedStyle",
    (el: { style: Record<string, string> }) => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
      ...el.style,
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("novaZones", () => {
  it("reports controls, fields and the visible panel page, rounded, with the typing flag", () => {
    page({
      dialog: [],
      ".col": [{ rect: [20, 70.4, 288, 300.6] }],
      button: [
        { rect: [100, 40, 100, 20] },
        { rect: [600.5, 900, 400, 40], is: ["input"] },
      ],
    });
    expect(novaZones()).toBe(
      "20,70,288,301,0;100,40,100,20,0;601,900,400,40,1",
    );
  });

  it("leaves hidden things and a hidden sphere to the desktop", () => {
    page(
      {
        dialog: [],
        ".col": [],
        button: [
          { rect: [100, 40, 100, 20], style: { visibility: "hidden" } },
          { rect: [1, 1, 1, 1] },
        ],
      },
      { rect: [700, 300, 500, 500], style: { pointerEvents: "none" } },
    );
    expect(novaZones()).toBe("");
  });

  it("an open window takes its whole rectangle for typing, its own controls are inside it", () => {
    page(
      {
        dialog: [{ rect: [400, 200, 800, 600] }],
        ".col": [],
        button: [{ rect: [500, 300, 80, 30], inside: ["dialog"] }],
      },
      { rect: [700, 300, 500, 500] },
    );
    expect(novaZones()).toBe("400,200,800,600,1;700,300,500,500,0");
  });
});
