import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { publishAtomic } from "./index.ts";

const { syncPaths } = vi.hoisted(() => ({ syncPaths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        syncPaths.push(String(args[0]));
        return sync();
      };
      return handle;
    }) as typeof actual.open,
  };
});

it("publishAtomic durable chama sync no temporário antes do rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publish-durable-"));
  const path = join(dir, "project.json");
  syncPaths.length = 0;
  await publishAtomic(path, "{\"ok\":true}\n", { durable: true });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ok: true });
  expect(syncPaths.some((opened) => opened !== path && opened.startsWith(path))).toBe(true);
});
