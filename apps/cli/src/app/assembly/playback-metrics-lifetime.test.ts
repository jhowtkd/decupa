import { createServer, type ServerResponse } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { createAssemblyRuntime } from "./routes.ts";
import { playbackDir, proxyPath, thumbnailPath } from "./media.ts";

const stream = vi.hoisted(() => ({ entered: () => {}, gate: Promise.resolve() }));
vi.mock("../../http/media.ts", () => ({ serveMedia: async (_req: unknown, res: ServerResponse) => {
  stream.entered();
  await stream.gate;
  res.writeHead(200);
  res.end("stream completed");
} }));

it("finishes the playback journal while the media stream is still held open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "playback-journal-lifetime-"));
  let release!: () => void;
  stream.gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { stream.entered = resolve; });
  const runtime = createAssemblyRuntime(dir, { exec: { run: async () => { throw new Error("cached proxy should avoid encoding"); } }, port: () => 0 });
  const server = createServer((req, res) => { void runtime.handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)); }); });
  let pending: Promise<Response> | undefined;
  try {
    const input = join(dir, "private-source.mp4");
    await copyFile(join(FIXTURES, "clip.mp4"), input);
    const project = await runtime.ensureProject([input]);
    const source = project.assembly.sources[0]!;
    await mkdir(playbackDir(dir, source.sha256), { recursive: true });
    await copyFile(input, proxyPath(dir, source.sha256));
    await writeFile(thumbnailPath(dir, source.sha256), "thumbnail");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing listener");
    pending = fetch(`http://127.0.0.1:${address.port}/project/media/${source.id}?view=playback`);
    await entered;
    const metricsDir = join(dir, ".decupa", "metrics");
    await vi.waitFor(async () => {
      const files = await readdir(metricsDir);
      const journal = (await Promise.all(files.map(file => readFile(join(metricsDir, file), "utf8")))).join("\n");
      expect(journal).toContain('"kind":"operation-finished"');
      expect(journal).not.toContain(dir);
    }, { timeout: 10_000 });
  } finally {
    release();
    if (pending) await (await pending).text();
    await runtime.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
