import { describe, expect, it } from "vitest";
import { stampModelClaims } from "./gemini.ts";
import { renderReport } from "./report.ts";

describe("stampModelClaims", () => {
  it("marca source model e a seção Modelo lista a alegação sem source na mão", () => {
    const [c] = stampModelClaims([{
      unit_ids: ["u001", "u002"],
      reason: "preroll",
      note: "falando com o operador",
    }]);
    expect(c!.source).toBe("model");
    expect(c!.restated_by).toBeNull();

    const md = renderReport({
      keepList: "u003-u005",
      model: "gemini-3.8-flash",
      verdicts: [{ accepted: true, claim: c! }],
      density: null,
    });
    const modelo = md.slice(md.indexOf("## Modelo"), md.indexOf("## Visual"));
    expect(modelo).toContain("falando com o operador");
    expect(modelo).toContain("u001");
    expect(modelo).not.toContain("Nada neste passe");
  });
});
