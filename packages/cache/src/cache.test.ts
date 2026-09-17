import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CancelledError } from "@decupa/queue";
import {
  createArtifactCache,
  inspectArtifact,
  publishAtomic,
  type ArtifactStatus,
} from "./index.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("publishAtomic / inspectArtifact", () => {
  it("distinguie missing, unknown e ready", async () => {
    const dir = join(tmpdir(), `cache-status-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const path = join(dir, "artifact.json");
    expect(await inspectArtifact(path)).toEqual({ status: "missing" satisfies ArtifactStatus });
    await mkdir(dir, { recursive: true });
    await writeFile(path, "{ truncado", "utf8");
    expect((await inspectArtifact(path)).status).toBe("unknown");
    await writeFile(path, "", "utf8");
    expect((await inspectArtifact(path)).status).toBe("unknown");
    await publishAtomic(path, `${JSON.stringify({ ok: true })}\n`);
    const ready = await inspectArtifact(path);
    expect(ready.status).toBe("ready");
    expect(ready.value).toEqual({ ok: true });
  });
});

describe("createArtifactCache", () => {
  it("dois consumidores simultâneos geram uma construção", async () => {
    const dir = join(tmpdir(), `cache-sf-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const cache = createArtifactCache(dir);
    let builds = 0;
    const build = () => cache.getOrCreate("clip", async () => {
      builds += 1;
      await delay(30);
      return { n: builds };
    });
    const [a, b] = await Promise.all([build(), build()]);
    expect(builds).toBe(1);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
  });

  it("arquivo truncado reconstrói e publicação atômica deixa JSON válido", async () => {
    const dir = join(tmpdir(), `cache-trunc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "clip.json"), "{ quebrado", "utf8");
    const cache = createArtifactCache(dir);
    let builds = 0;
    const value = await cache.getOrCreate("clip", async () => {
      builds += 1;
      return { rebuilt: true };
    });
    expect(builds).toBe(1);
    expect(value).toEqual({ rebuilt: true });
    expect(JSON.parse(await readFile(join(dir, "clip.json"), "utf8"))).toEqual({ rebuilt: true });
  });

  it("cancelamento no meio não publica sucesso", async () => {
    const dir = join(tmpdir(), `cache-cancel-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const cache = createArtifactCache(dir);
    const controller = new AbortController();
    const pending = cache.getOrCreate("clip", async () => {
      controller.abort();
      await delay(10);
      return { leaked: true };
    }, { signal: controller.signal });
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect((await inspectArtifact(join(dir, "clip.json"))).status).toBe("missing");
  });

  it("falha registrada não é reaproveitada como ready", async () => {
    const dir = join(tmpdir(), `cache-err-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const cache = createArtifactCache(dir);
    await expect(cache.getOrCreate("clip", async () => {
      throw new Error("ASR falhou");
    })).rejects.toThrow(/ASR falhou/);
    expect((await inspectArtifact(join(dir, "clip.json"))).status).not.toBe("ready");
    let builds = 0;
    const value = await cache.getOrCreate("clip", async () => {
      builds += 1;
      return { ok: true };
    });
    expect(builds).toBe(1);
    expect(value).toEqual({ ok: true });
  });
});
