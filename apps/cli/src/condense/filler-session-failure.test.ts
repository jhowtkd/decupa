import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const inject = vi.hoisted(() => ({ failOnce: false, failRecovery: false, abort: undefined as AbortController | undefined }));
afterEach(() => { inject.failOnce = false; inject.failRecovery = false; inject.abort = undefined; });
vi.mock("@decupa/cache", async importOriginal => {
  const original = await importOriginal<typeof import("@decupa/cache")>();
  return { ...original, publishAtomic: async (...args: Parameters<typeof original.publishAtomic>) => {
    if (inject.failRecovery && args[0].endsWith("keep.txt") && args[1] === "anterior") {
      inject.failRecovery = false; throw Error("recuperação simulada");
    }
    if (args[0].endsWith("fillers.json")) {
      if (inject.failOnce) { inject.failOnce = false; throw Error("falha de publicação simulada"); }
      inject.abort?.abort(); inject.abort = undefined;
    }
    return original.publishAtomic(...args);
  } };
});
import { persistFillerSession } from "./filler-session.ts";

it("duas falhas de recuperação conservam o diário original antes de novo persist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleanup-journal-retry-")), journal = join(dir, ".fillers-session-pending.json");
  await writeFile(join(dir, "keep.txt"), "anterior"); await writeFile(join(dir, "fillers.json"), "decisões anteriores");
  const state = { generation: 1, keepList: "u001", fillers: { cut: [], kept: [] } };
  inject.failOnce = true; inject.failRecovery = true;
  await expect(persistFillerSession(dir, state, "sha")).rejects.toThrow("recuperação simulada");
  const previousJournal = await readFile(journal, "utf8");
  expect(JSON.parse(previousJournal)).toEqual({ keep: "anterior", fillers: "decisões anteriores" });
  expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("u001\n");
  inject.failRecovery = true;
  await expect(persistFillerSession(dir, { ...state, generation: 2, keepList: "u002" }, "sha")).rejects.toThrow("recuperação simulada");
  expect(await readFile(journal, "utf8")).toBe(previousJournal);
  expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("u001\n");
  await persistFillerSession(dir, { ...state, generation: 2, keepList: "u002" }, "sha");
  expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("u002\n");
  expect(JSON.parse(await readFile(join(dir, "fillers.json"), "utf8"))).toMatchObject({ transcriptSha256: "sha", cut: [], kept: [] });
  await expect(readFile(journal)).rejects.toMatchObject({ code: "ENOENT" });
});

it("falha na segunda publicação e cancelamento desfazem ambos os arquivos", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleanup-session-fail-"));
  await writeFile(join(dir, "keep.txt"), "anterior"); await writeFile(join(dir, "fillers.json"), "anterior");
  const state = { generation: 2, keepList: "u002", fillers: { cut: [], kept: [] } };
  inject.failOnce = true;
  await expect(persistFillerSession(dir, state, "sha")).rejects.toThrow(/simulada/);
  expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("anterior"); expect(await readFile(join(dir, "fillers.json"), "utf8")).toBe("anterior");
  const controller = new AbortController(); inject.abort = controller;
  await expect(persistFillerSession(dir, state, "sha", controller.signal)).rejects.toThrow();
  expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("anterior"); expect(await readFile(join(dir, "fillers.json"), "utf8")).toBe("anterior");
});
