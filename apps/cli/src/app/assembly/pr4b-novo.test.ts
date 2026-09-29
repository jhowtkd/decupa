import { access, copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

it("POST /project/new devolve a pasta criada, registra no log e na meta da página", async () => {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  try {
    const { base } = await boot();
    const res = await fetch(`${base}/project/new`, { method: "POST" });
    expect(res.status).toBe(201);
    const body = await res.json() as { url?: string; dir?: string };
    let existe = false;
    if (body.dir) existe = await access(body.dir).then(() => true, () => false);
    const html = body.url ? await (await fetch(body.url)).text() : "";
    expect({
      log: logs.some((linha) => new RegExp(`novo projeto em ${body.dir ?? "\\S+"}`).test(linha)),
      dirExiste: existe,
      meta: body.dir ? html.includes(`name="decupa-project-dir" content="${escapado(body.dir)}"`) : false,
    }).toEqual({ log: true, dirExiste: true, meta: true });
  } finally {
    spy.mockRestore();
  }
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
