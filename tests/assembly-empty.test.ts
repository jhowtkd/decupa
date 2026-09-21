import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startApp } from "../apps/cli/src/app/server.ts";
import type { Executor } from "../apps/cli/src/app/pipeline.ts";
import { FIXTURES } from "./fixtures/global-setup.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

const fakeExecutor: Executor = {
  async run() {
    return { code: 0, stdout: "", stderr: "" };
  },
};

it("página servida contém o guia vazio em 3 passos com CTA", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-empty-"));
  const app = await startApp({ projectDir: dir, port: 0, executor: fakeExecutor });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const empty = await (await fetch(`${base}/project`)).json() as {
    project: { assembly: { sources: unknown[] } };
  };
  expect(empty.project.assembly.sources).toHaveLength(0);

  const page = await (await fetch(`${base}/`)).text();
  // Guia sai do HTML estático: o shell entrega os mounts e o mountTexto
  // renderiza o guia (emptyGuideHtml, testado em texto.test.ts).
  expect(page).toContain('id="texto"');
  expect(page).toContain('id="dropzone"');
  expect(page).toContain('accept="video/*,audio/*"');
  const testo = await (await fetch(`${base}/editor/texto.js`)).text();
  expect(testo).toContain("data-empty-guide");
  expect(testo).toContain("emptyGuideHtml");
  expect(testo).toContain('document.getElementById("filePicker")?.click()');
});

it("com mídia presente, o cliente servido troca o guia pelo conteúdo normal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-empty-media-"));
  const speech = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), speech);
  const app = await startApp({
    projectDir: dir,
    inputs: [speech],
    port: 0,
    executor: fakeExecutor,
  });
  stop = app.close;
  const base = `http://127.0.0.1:${app.port}`;

  const opened = await (await fetch(`${base}/project`)).json() as {
    project: { assembly: { sources: unknown[] } };
  };
  expect(opened.project.assembly.sources).toHaveLength(1);

  // O render condicional servido só mostra o guia sem fontes; com mídia,
  // o ramo normal (transcrição/prosa) substitui o #texto.
  const testo = await (await fetch(`${base}/editor/texto.js`)).text();
  expect(testo).toContain("needsEmptyGuide(p)");
  expect(testo).toContain("emptyGuideHtml(accept)");
});
