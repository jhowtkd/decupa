import { createServer, type ServerResponse } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { hashFile } from "@decupa/media";
import { FIXTURES } from "../../../../../tests/fixtures/global-setup.ts";
import { createAssemblyRuntime, blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { createProject } from "./store.ts";

const streamed = vi.hoisted(() => ({ entered: () => {}, path: "", gate: Promise.resolve() }));
vi.mock("../../http/media.ts", () => ({
  serveMedia: async (_req: unknown, res: ServerResponse, path: string) => {
    streamed.path = path;
    streamed.entered();
    await streamed.gate;
    res.writeHead(200);
    res.end("stream completed");
  },
}));

it("serves a prepared derivative from the explicit preview route and closes metrics before streaming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-playback-route-"));
  let release!: () => void;
  streamed.gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { streamed.entered = resolve; });
  const runtime = createAssemblyRuntime(dir, {
    exec: { run: async call => {
      await copyFile(join(dir, "rev-1", "reference.mp4"), call.args.at(-1)!);
      return { code: 0, stdout: "", stderr: "" };
    } },
    port: () => 0,
  });
  const server = createServer((req, res) => {
    void runtime.handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)); });
  });
  let pending: Promise<Response> | undefined;
  try {
    const assembly = fixtureAssembly();
    const sourcePath = join(dir, "source.mp4");
    await copyFile(join(FIXTURES, "clip.mp4"), sourcePath);
    const sha256 = await hashFile(sourcePath);
    for (const source of assembly.sources) { source.path = sourcePath; source.sha256 = sha256; }
    const reference = join(dir, "rev-1", "reference.mp4");
    await mkdir(join(dir, "rev-1"), { recursive: true });
    await copyFile(sourcePath, reference);
    const project = blankProject("preview-playback");
    project.revision = 1;
    project.assembly = assembly;
    project.previewRevision = 1;
    project.previewArtifact = {
      revision: 1,
      relativePath: "rev-1/reference.mp4",
      sha256: await hashFile(reference),
      assemblySha256: createHash("sha256").update(JSON.stringify(assembly)).digest("hex"),
    };
    await createProject(dir, project);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing listener");

    pending = fetch(`http://127.0.0.1:${address.port}/project/preview/1`);
    await entered;
    expect(streamed.path).toMatch(/rev-1\/playback-v1-[a-f0-9]{64}\.mp4$/);
    const metricsDir = join(dir, ".decupa", "metrics");
    await vi.waitFor(async () => {
      const files = await readdir(metricsDir);
      const journal = (await Promise.all(files.map(file => readFile(join(metricsDir, file), "utf8")))).join("\n");
      expect(journal).toContain('"kind":"operation-finished"');
      expect(journal).toContain('"operation":"preview-playback"');
      expect(journal).not.toContain(dir);
    }, { timeout: 10_000 });
    release();
    expect(await (await pending).text()).toBe("stream completed");
  } finally {
    release();
    if (pending) await (await pending).text().catch(() => "");
    await runtime.close();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
