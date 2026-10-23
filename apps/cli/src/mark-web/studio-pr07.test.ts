// Marcação manual no studio (PR 7): a legacy segue byte a byte, o studio é o
// mesmo HTML com a meta e a CSS, e a medição continua às cegas.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURES } from "../../../../tests/fixtures/global-setup.ts";
import { withStudioShell } from "../app/assembly/editor-ui.ts";
import { runMarkWeb, type MarkWebResult } from "./server.ts";

const ler = (arquivo: string) => readFile(new URL(arquivo, import.meta.url), "utf8");
const PROIBIDOS = ["transcript", "predi", "sugest", "melhor posição"];

async function comMarcador(env: Record<string, string>, fn: (base: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mark-pr07-"));
  let saved!: Promise<MarkWebResult>;
  const port = await new Promise<number>((resolvePort) => {
    saved = runMarkWeb({
      input: join(FIXTURES, "tone-gap.wav"), outPath: join(dir, "truth.json"), cacheDir: join(dir, "proxy"),
      port: 0, env, onListen: resolvePort,
    });
  });
  const base = `http://127.0.0.1:${port}`;
  try { await fn(base); }
  finally {
    try {
      await fetch(`${base}/truth`, {
        method: "POST", headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ boundariesMs: [1] }), signal: AbortSignal.timeout(5_000),
      });
      await Promise.race([saved, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    } catch { /* já encerrou */ }
    await rm(dir, { recursive: true, force: true });
  }
}

it("legacy: / é o page.html byte a byte e /studio.css não existe", async () => {
  await comMarcador({}, async (base) => {
    expect(await (await fetch(`${base}/`)).text()).toBe(await ler("page.html"));
    expect((await fetch(`${base}/studio.css`)).status).not.toBe(200);
  });
});

it("legacy: valor desconhecido da variável também serve o page.html de hoje", async () => {
  const antes = console.error;
  console.error = () => {};
  try {
    await comMarcador({ DECUPA_EDITOR_UI: "novo" }, async (base) => {
      expect(await (await fetch(`${base}/`)).text()).toBe(await ler("page.html"));
      expect((await fetch(`${base}/studio.css`)).status).not.toBe(200);
    });
  } finally { console.error = antes; }
});

it("studio: / é exatamente o derivado por withStudioShell e /studio.css dá 200 com o arquivo", async () => {
  await comMarcador({ DECUPA_EDITOR_UI: "studio" }, async (base) => {
    expect(await (await fetch(`${base}/`)).text()).toBe(withStudioShell(await ler("page.html"), "/studio.css"));
    const css = await fetch(`${base}/studio.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe(await ler("studio.css"));
  });
});

it("studio: não abre rota nova além de /studio.css", async () => {
  await comMarcador({ DECUPA_EDITOR_UI: "studio" }, async (base) => {
    for (const rota of ["/mark-studio.css", "/page.css", "/studio.html", "/studio.js", "/settings/studio.css", "/hub/studio.css"]) {
      // (/login/studio.css fica de fora: vem do runtime de auth, que a marcação já usava.)
      expect((await fetch(`${base}${rota}`)).status, rota).not.toBe(200);
    }
  });
});

it("studio: segue às cegas — nem o HTML servido nem a CSS falam de transcrição, previsão ou sugestão", async () => {
  await comMarcador({ DECUPA_EDITOR_UI: "studio" }, async (base) => {
    const html = (await (await fetch(`${base}/`)).text()).toLowerCase();
    const css = (await ler("studio.css")).toLowerCase();
    for (const proibido of PROIBIDOS) {
      expect(html, proibido).not.toContain(proibido);
      expect(css, proibido).not.toContain(proibido);
    }
    expect(html).toContain("medição às cegas");
    expect(html).toContain('<meta name="decupa-editor-ui" content="studio">');
  });
});
