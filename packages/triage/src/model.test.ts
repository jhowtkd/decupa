import { describe, expect, it } from "vitest";
import { FakeTriageModel } from "./model.ts";

describe("FakeTriageModel.inspect", () => {
  it("grava a chamada e devolve o veredito roteirizado", async () => {
    const model = new FakeTriageModel([], [], [
      { unitId: "u020", decision: "drop", note: "olhou para o operador" },
    ]);
    const out = await model.inspect({ unitId: "u020", frames: ["/tmp/a.jpg"] });
    expect(out.decision).toBe("drop");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.kind).toBe("inspect");
  });

  it("sem roteiro devolve unsure", async () => {
    const model = new FakeTriageModel();
    const out = await model.inspect({ unitId: "u009", frames: [] });
    expect(out).toEqual({
      unitId: "u009",
      decision: "unsure",
      note: "fake: sem veredito roteirizado",
    });
  });
});
