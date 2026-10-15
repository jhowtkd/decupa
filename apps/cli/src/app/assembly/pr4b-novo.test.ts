import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { startApp } from "../server.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "pr4b-novo-"));
  const clip = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), clip);
  const app = await startApp({
    projectDir: dir,
    port: 0,
    selectFn: async () => ({ paths: [clip] }),
  });
  stop = app.close;
  return { base: `http://127.0.0.1:${app.port}` };
}

function escapado(dir: string): string {
  return dir.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

it("o modo legado não abre uma porta efêmera para Novo projeto", async () => {
  const { base } = await boot();
  const res = await fetch(`${base}/project/new`, { method: "POST" });
  expect(res.status).toBe(404);
});

it("withProjectDir escapa a pasta na meta da página", async () => {
  const { withProjectDir } = await import("../server.ts");
  const page = '<meta name="decupa-project-dir" content="">';
  expect(withProjectDir(page, `/tmp/a&b"c`)).toBe(
    '<meta name="decupa-project-dir" content="/tmp/a&#38;b&#34;c">',
  );
});

it.each(["$&", "$`", "$'", "$$", "/tmp/Meu $& $` $' $$ <>\"'& projeto"])(
  "withProjectDir mantém a pasta %s literal na meta, sem corromper a página",
  async (nome) => {
    const { withProjectDir } = await import("../server.ts");
    const dir = nome.startsWith("/") ? nome : `/tmp/${nome}/proj`;
    const page = '<head><meta name="decupa-project-dir" content=""></head><body>RESTO</body>';
    const html = withProjectDir(page, dir);
    expect(html).toBe(
      `<head><meta name="decupa-project-dir" content="${escapado(dir)}"></head><body>RESTO</body>`,
    );
  },
);

it("projectUrl monta URLs emitidas com o prefixo do Projeto", async () => {
  const { projectUrl } = await import("../server.ts");
  expect(projectUrl("jobs/j1/download/otio")).toBe("/jobs/j1/download/otio");
  expect(projectUrl("jobs/j1/download/otio", "/projects/projeto-a")).toBe("/projects/projeto-a/jobs/j1/download/otio");
});
