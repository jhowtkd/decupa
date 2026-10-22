import { expect, it, vi } from "vitest";
import { editorUiFromEnv, type EditorUi } from "./editor-ui.ts";

it.each<[string, Record<string, string | undefined>, EditorUi]>([
  ["ausente", {}, "legacy"],
  ["undefined explícito", { DECUPA_EDITOR_UI: undefined }, "legacy"],
  ["vazia", { DECUPA_EDITOR_UI: "" }, "legacy"],
  ["só espaços", { DECUPA_EDITOR_UI: "   " }, "legacy"],
  ["legacy", { DECUPA_EDITOR_UI: "legacy" }, "legacy"],
  ["legacy com espaços", { DECUPA_EDITOR_UI: " legacy " }, "legacy"],
  ["studio", { DECUPA_EDITOR_UI: "studio" }, "studio"],
  ["studio com espaços", { DECUPA_EDITOR_UI: "  studio\n" }, "studio"],
])("%s escolhe %s sem avisar", (_nome, env, esperado) => {
  const warn = vi.fn();
  expect(editorUiFromEnv(env, warn)).toBe(esperado);
  expect(warn).not.toHaveBeenCalled();
});

it.each(["Studio", "STUDIO", "novo", "true", "1", "studio2"])(
  "valor desconhecido %j cai na legacy com um único aviso que cita o valor",
  (valor) => {
    const warn = vi.fn();
    expect(editorUiFromEnv({ DECUPA_EDITOR_UI: valor }, warn)).toBe("legacy");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(JSON.stringify(valor));
  },
);

it("sem warn injetado o aviso vai para o stderr uma vez", () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(editorUiFromEnv({ DECUPA_EDITOR_UI: "novo" })).toBe("legacy");
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
  }
});
