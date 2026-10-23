import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { editorUiFromEnv, withStudioShell, type EditorUi } from "./editor-ui.ts";

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

const META = '<meta name="decupa-editor-ui" content="studio">';
const HTML = '<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body><script>const a = 1;</script></body></html>';

it("withStudioShell injeta a meta e o link logo antes de </head>", () => {
  const out = withStudioShell(HTML, "/x/studio.css");
  const fim = HTML.indexOf("</head>");
  expect(out).toBe(`${HTML.slice(0, fim)}${META}<link rel="stylesheet" href="/x/studio.css">${HTML.slice(fim)}`);
});

it("withStudioShell é idempotente", () => {
  const uma = withStudioShell(HTML, "/studio.css");
  expect(withStudioShell(uma, "/studio.css")).toBe(uma);
});

it("withStudioShell não altera o que vem antes da injeção nem de </head> em diante", () => {
  const out = withStudioShell(HTML, "/studio.css");
  const fim = HTML.indexOf("</head>");
  expect(out.startsWith(HTML.slice(0, fim))).toBe(true);
  expect(out.endsWith(HTML.slice(fim))).toBe(true);
  expect(out.length).toBe(HTML.length + META.length + '<link rel="stylesheet" href="/studio.css">'.length);
});

it("withStudioShell recusa HTML com mais de um </head>, antes ou depois do real", () => {
  const noScript = HTML.replace("<script>", "<script>const s='</head>';");
  const noComentario = HTML.replace("<title>", "<!-- fim </head> -->ponto<title>");
  for (const html of [noScript, noComentario]) {
    expect(() => withStudioShell(html, "/studio.css")).toThrow(/mais de um <\/head>/);
  }
});

it("withStudioShell lança erro claro sem </head>", () => {
  expect(() => withStudioShell("<html><body>oi</body></html>", "/studio.css")).toThrow(/falta <\/head>/);
});

const REAIS: Array<[string, string, string]> = [
  ["settings.html", "../settings.html", "/settings/studio.css"],
  ["app/page.html", "../page.html", "/studio.css"],
  ["mark-web/page.html", "../../mark-web/page.html", "/studio.css"],
];

it.each(REAIS)("withStudioShell sobre %s: o <body> e o <script> inline saem idênticos e a repetição não muda nada", async (_nome, caminho, css) => {
  const legacy = await readFile(new URL(caminho, import.meta.url), "utf8");
  // Um </head> só: a injeção não pode cair num comentário ou num script.
  expect(legacy.split("</head>")).toHaveLength(2);
  const studio = withStudioShell(legacy, css);
  const corpo = (h: string) => h.slice(h.indexOf("<body"));
  const scripts = (h: string) => [...h.matchAll(/<script\b[\s\S]*?<\/script>/g)].map((m) => m[0]);
  expect(corpo(studio)).toBe(corpo(legacy));
  expect(scripts(studio)).toEqual(scripts(legacy));
  expect(scripts(legacy).length).toBeGreaterThan(0);
  expect(studio).toContain(META);
  expect(studio).toContain(`<link rel="stylesheet" href="${css}">`);
  expect(studio.indexOf(META)).toBeLessThan(studio.indexOf("</head>"));
  expect(withStudioShell(studio, css)).toBe(studio);
  expect(studio.replace(`${META}<link rel="stylesheet" href="${css}">`, "")).toBe(legacy);
});
