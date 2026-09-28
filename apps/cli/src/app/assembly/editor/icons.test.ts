import { expect, it } from "vitest";
import { ICON } from "./icons.js";

it("todo ícone é SVG decorativo: o texto ou o aria-label do controle carrega o sentido", () => {
  for (const [name, svg] of Object.entries(ICON)) {
    expect(svg, name).toMatch(/^<svg /);
    expect(svg, name).toContain('aria-hidden="true"');
    expect(svg, name).toMatch(/<\/svg>$/);
  }
});

it("cobre os ícones que as telas usam", () => {
  expect(Object.keys(ICON).sort()).toEqual([
    "alert", "check", "circle", "file", "image", "importMedia", "lock", "more",
    "ok", "play", "plus", "send", "spinner", "undo", "unlock",
  ]);
});
