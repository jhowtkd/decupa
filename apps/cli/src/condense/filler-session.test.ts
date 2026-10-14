import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CleanupPlanQueue, persistFillerSession, recoverFillerSession } from "./filler-session.ts";

it("retomada desfaz uma troca interrompida entre keep e fillers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleanup-session-"));
  await writeFile(join(dir, "keep.txt"), "novo"); await writeFile(join(dir, "fillers.json"), "fillers antigos");
  await writeFile(join(dir, ".fillers-session-pending.json"), JSON.stringify({ keep: "keep antigo", fillers: "fillers antigos" }));
  await recoverFillerSession(dir);
  expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("keep antigo");
  expect(await readFile(join(dir, "fillers.json"), "utf8")).toBe("fillers antigos");
  await expect(readFile(join(dir, ".fillers-session-pending.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("sessão só é publicada com as duas seleções da mesma geração", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleanup-session-"));
  const state = { generation: 4, keepList: "u001", fillers: { cut: [], kept: [{ candidateId: "c", wordIds: ["w"], texts: ["hã"] }] } };
  await persistFillerSession(dir, state, "sha");
  expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("u001\n");
  expect(JSON.parse(await readFile(join(dir, "fillers.json"), "utf8"))).toEqual({ transcriptSha256: "sha", ...state.fillers });
});

it("falha de persistência antes da troca conserva keep anterior", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cleanup-session-"));
  await writeFile(join(dir, "keep.txt"), "u001\n"); await mkdir(join(dir, "fillers.json"));
  await expect(persistFillerSession(dir, { generation: 1, keepList: "u002", fillers: { cut: [], kept: [] } }, "sha")).rejects.toThrow();
  expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("u001\n");
});

it("supersede falha antiga e todos os pedidos aguardam a geração vencedora", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), start = new Promise<void>(r => { entered = r; });
  const seen: number[] = [];
  const queue = new CleanupPlanQueue({ generation: 0, keepList: "u001", fillers: { cut: [], kept: [] } }, async state => {
    seen.push(state.generation); if (state.generation === 1) { entered(); await gate; throw Error("antigo"); }
  });
  const first = queue.update({ keepList: "u002" }); await start;
  const second = queue.update({ fillers: { kept: [{ candidateId: "c", wordIds: ["w"], texts: ["hã"] }] } });
  const third = queue.update({ keepList: "u003" });
  release(); await Promise.all([first, second, third]);
  expect(seen).toEqual([1, 3]); expect(queue.desired).toMatchObject({ generation: 3, keepList: "u003", fillers: { kept: [expect.objectContaining({ candidateId: "c" })] } });
});

it("pedido na microtarefa entre retorno do loop e finally inicia nova execução", async () => {
  const seen: number[] = [];
  let next!: Promise<void>;
  const queue = new CleanupPlanQueue({ generation: 0, keepList: "u001", fillers: { cut: [], kept: [] } }, async state => {
    seen.push(state.generation);
    if (state.generation === 1) queueMicrotask(() => queueMicrotask(() => { next = queue.update({ keepList: "u002" }); }));
  });
  await queue.update({}); await next;
  expect(seen).toEqual([1, 2]); expect(queue.desired.keepList).toBe("u002");
  await queue.update({ keepList: "u003" }); expect(seen).toEqual([1, 2, 3]);
});
