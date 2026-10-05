import { copyFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Arquivo separado: o mock não pode vazar para routes.test.ts.
const hashes = vi.hoisted(() => ({ n: 0 }));
vi.mock("@decupa/media", async () => {
  const real = await vi.importActual<typeof import("@decupa/media")>("@decupa/media");
  return {
    ...real,
    hashFile: async (path: string) => {
      hashes.n += 1;
      return real.hashFile(path);
    },
  };
});

import { createTemplateRuntime } from "./routes.ts";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

it("não refaz o sha256 a cada Range e responde 409 quando a referência muda", async () => {
  const dir = await mkdtemp(join(tmpdir(), "template-hash-"));
  // Cópia: o teste troca o arquivo, e a fixture compartilhada não pode mudar.
  await copyFile(join(FIXTURES, "clip.mp4"), join(dir, "clip.mp4"));
  const clip = await realpath(join(dir, "clip.mp4"));
  let port = 0;
  const runtime = createTemplateRuntime(dir, {
    port: () => port,
    selectFn: async () => ({ paths: [clip] }),
    exec: { run: async () => { throw new Error("external blocked"); } },
    send: async () => "{}",
    modelKey: "test",
    allowModel: false,
    allowVisual: false,
  });
  const server = createServer((req, res) => {
    void runtime.handleTemplates(req, res).then((handled) => {
      if (!handled) { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  closes.push(() => new Promise((resolve) => server.close(() => resolve())));
  closes.push(() => rm(dir, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${port}`;

  const created = await fetch(`${base}/templates/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Evento" }),
  });
  expect(created.status).toBe(201);
  const { recipe } = await created.json() as { recipe: { id: string } };
  const afterCreate = hashes.n;
  expect(afterCreate).toBeGreaterThan(0);

  const media = `${base}/templates/api/${recipe.id}/media`;
  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(media, { headers: { range: "bytes=0-9" } });
    expect(res.status).toBe(206);
    await res.arrayBuffer();
  }
  // Memo de tamanho+mtime: o primeiro GET hasheia, os Range seguintes não.
  expect(hashes.n).toBe(afterCreate + 1);

  await writeFile(clip, Buffer.from("referencia trocada"));
  const changed = await fetch(media, { headers: { range: "bytes=0-9" } });
  expect(changed.status).toBe(409);
  expect(await changed.text()).toMatch(/referência mudou/);
  expect(hashes.n).toBe(afterCreate + 2);
});
