import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { blankProject } from "./routes.ts";
import { writeHistorySnapshot } from "./store.ts";

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: vi.fn((from: string, to: string) => actual.rename(from, to)),
  };
});

import * as fs from "node:fs/promises";

const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(fs.rename).mockReset();
  vi.mocked(fs.rename).mockImplementation((from, to) =>
    vi.importActual<typeof import("node:fs/promises")>("node:fs/promises").then((actual) => actual.rename(from, to)));
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

it("foto do histórico é atômica: falha no rename preserva a anterior e não deixa .tmp", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "pr4b-atomic-"));
  dirs.push(dir);
  const antigo = blankProject("atom");
  antigo.input = { kind: "brief", text: "ANTIGO", targetSeconds: 60 };
  await writeHistorySnapshot(dir, antigo);

  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }));
  const novo = { ...antigo, input: { ...antigo.input, text: "NOVO" } };
  let threw = false;
  try {
    await writeHistorySnapshot(dir, novo);
  } catch {
    threw = true;
  }
  const body = JSON.parse(await fs.readFile(join(dir, "history", "rev-0.json"), "utf8")) as { input: { text: string } };
  const temps = (await fs.readdir(join(dir, "history"))).filter((nome) => nome.includes(".tmp"));
  expect({ threw, texto: body.input.text, temps }).toEqual({ threw: true, texto: "ANTIGO", temps: [] });
});
