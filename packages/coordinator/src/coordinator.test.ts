import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { CancelledError } from "@decupa/queue";
import { describe, expect, it } from "vitest";
import { AbandonedError, createFileCoordinator } from "./index.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dir(): string {
  return join(tmpdir(), `coord-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function waitUntil(label: string, probe: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await probe()) return;
    await delay(10);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Attach the rejection handler immediately so Windows cannot surface unhandled AbandonedError. */
function watchAbandoned(run: Promise<unknown>): Promise<unknown> {
  return run.then(
    () => {
      throw new Error("execução velha deveria ter sido abandonada");
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(AbandonedError);
      return error;
    },
  );
}

describe("createFileCoordinator", () => {
  it("dois clientes isolados disputam o mesmo limite", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const a = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    const b = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    let concurrent = 0;
    let max = 0;
    const work = (id: string) => async () => {
      concurrent += 1;
      max = Math.max(max, concurrent);
      await delay(40);
      concurrent -= 1;
      return id;
    };
    const [ra, rb] = await Promise.all([
      a.run({ id: "t1", stage: "ingest", build: work("t1") }),
      b.run({ id: "t2", stage: "ingest", build: work("t2") }),
    ]);
    expect(new Set([ra, rb])).toEqual(new Set(["t1", "t2"]));
    expect(max).toBe(1);
  });

  it("não reutiliza uma tarefa concluída quando ela é executada de novo", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const coordinator = createFileCoordinator(root, { pollMs: 5 });
    let builds = 0;
    const execute = () => {
      builds += 1;
      return builds;
    };
    await coordinator.withSlot({ stage: "rendering" }, execute);
    await coordinator.withSlot({ stage: "rendering" }, execute);
    expect(builds).toBe(2);
  });

  it("withSlot serializa clientes diferentes sem memorizar resultado", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const a = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    const b = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    let concurrent = 0;
    let max = 0;
    const work = async (): Promise<void> => {
      concurrent += 1;
      max = Math.max(max, concurrent);
      await delay(40);
      concurrent -= 1;
    };
    await Promise.all([
      a.withSlot({ stage: "rendering" }, work),
      b.withSlot({ stage: "rendering" }, work),
    ]);
    expect(max).toBe(1);
  });

  it("cancelar enquanto espera tira o waiter e deixa a fila avançar", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const coordinator = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const blocker = coordinator.withSlot({ stage: "rendering" }, () => held);
    await waitUntil("slot ocupado", async () => {
      try {
        const waiters = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as unknown[];
        return Array.isArray(waiters) && waiters.length === 0;
      } catch {
        return false;
      }
    });
    const controller = new AbortController();
    const cancelled = coordinator.withSlot({ stage: "rendering", signal: controller.signal }, async () => "cancelada");
    await waitUntil("waiter cancelável", async () => {
      try {
        const waiters = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as unknown[];
        return Array.isArray(waiters) && waiters.length === 1;
      } catch {
        return false;
      }
    });
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(CancelledError);
    release();
    await blocker;
    await expect(coordinator.withSlot({ stage: "rendering" }, async () => "seguinte")).resolves.toBe("seguinte");
  });

  it("libera o slot quando a função lança", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const coordinator = createFileCoordinator(root, { pollMs: 5 });
    const error = new Error("falha do render");
    await expect(coordinator.withSlot({ stage: "rendering" }, async () => { throw error; })).rejects.toBe(error);
    await expect(coordinator.withSlot({ stage: "rendering" }, async () => "depois")).resolves.toBe("depois");
  });

  it("waiter vivo continua elegível depois de esperar mais que quatro leases", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const coordinator = createFileCoordinator(root, { leaseMs: 40, pollMs: 5 });
    const first = coordinator.withSlot({ stage: "rendering" }, () => delay(220));
    await delay(10);
    const controller = new AbortController();
    const second = coordinator.withSlot({ stage: "rendering", signal: controller.signal }, () => "b rodou");
    await first;
    const result = await Promise.race([
      second,
      delay(120).then(() => "travou"),
    ]);
    expect(result).toBe("b rodou");
    controller.abort();
    await second.catch(() => undefined);
  });

  it("mantém a ordem de chegada depois de uma espera longa", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const coordinator = createFileCoordinator(root, { leaseMs: 40, pollMs: 5 });
    const order: string[] = [];
    const first = coordinator.withSlot({ stage: "rendering" }, () => delay(220));
    await delay(10);
    const second = coordinator.withSlot({ stage: "rendering" }, () => { order.push("b"); return "b"; });
    await waitUntil("segundo waiter", async () => {
      try {
        const waiters = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as unknown[];
        return waiters.length === 1;
      } catch {
        return false;
      }
    });
    const third = coordinator.withSlot({ stage: "rendering" }, () => { order.push("c"); return "c"; });
    await Promise.all([first, second, third]);
    expect(order).toEqual(["b", "c"]);
  });

  it("reinsere waiter vivo se o arquivo da fila desaparecer", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const coordinator = createFileCoordinator(root, { leaseMs: 40, pollMs: 5 });
    const first = coordinator.withSlot({ stage: "rendering" }, () => delay(120));
    await delay(10);
    const second = coordinator.withSlot({ stage: "rendering" }, () => "reentrou");
    await waitUntil("waiter para apagar", async () => {
      try {
        const waiters = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as unknown[];
        return waiters.length === 1;
      } catch {
        return false;
      }
    });
    await unlink(join(root, "waiters.json"));
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, "reentrou"]);
  });

  it("descarta waiter que parou de renovar", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const now = Date.now();
    await writeFile(join(root, "waiters.json"), JSON.stringify([{
      waiterId: "processo-morto",
      taskId: "processo-morto",
      priority: "batch",
      at: now,
      seenAt: now - 200,
    }]));
    const coordinator = createFileCoordinator(root, { leaseMs: 40, pollMs: 5 });
    await expect(coordinator.withSlot({ stage: "rendering" }, () => "liberado")).resolves.toBe("liberado");
    const waiters = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as { waiterId: string }[];
    expect(waiters.some((waiter) => waiter.waiterId === "processo-morto")).toBe(false);
  });

  it("lê waiter antigo sem seenAt", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const old = Date.now() - 200;
    await writeFile(join(root, "waiters.json"), JSON.stringify([{
      waiterId: "formato-antigo",
      taskId: "formato-antigo",
      priority: "batch",
      at: old,
    }]));
    const coordinator = createFileCoordinator(root, { leaseMs: 40, pollMs: 5 });
    await expect(coordinator.withSlot({ stage: "rendering" }, () => "legivel")).resolves.toBe("legivel");
  });

  it("morte/reinício retoma só o incompleto", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const clock = { t: 1_000 };
    const first = createFileCoordinator(root, { limit: 1, leaseMs: 50, pollMs: 5, now: () => clock.t });
    let builds = 0;
    const stale = watchAbandoned(first.run({
      id: "asr",
      stage: "transcribe",
      build: async () => {
        builds += 1;
        await delay(80);
        return { from: "stale", n: builds };
      },
    }));
    await waitUntil("stale build started", async () => builds === 1);
    clock.t += 200;
    const second = createFileCoordinator(root, { limit: 1, leaseMs: 50, pollMs: 5, now: () => clock.t });
    const resumed = await second.run({
      id: "asr",
      stage: "transcribe",
      build: async () => {
        builds += 1;
        return { from: "resume", n: builds };
      },
    });
    expect(resumed).toEqual({ from: "resume", n: 2 });
    await stale;
    const replay = await second.run({
      id: "asr",
      stage: "transcribe",
      build: async () => {
        builds += 1;
        return { from: "replay", n: builds };
      },
    });
    expect(replay).toEqual({ from: "resume", n: 2 });
    expect(builds).toBe(2);
  });

  it("execução velha abandonada não publica resultado", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const clock = { t: 1 };
    const stale = createFileCoordinator(root, { limit: 1, leaseMs: 20, pollMs: 5, now: () => clock.t });
    let published = "";
    // A execução velha só termina depois que a nova tomou a vaga e rodou:
    // sem depender de 80 ms de relógio real, que num runner lento passavam
    // antes de a nova conseguir roubar o lease.
    let freshRan!: () => void;
    const freshTookOver = new Promise<void>((resolve) => { freshRan = resolve; });
    const abandoned = watchAbandoned(stale.run({
      id: "clip",
      stage: "encode",
      build: async () => {
        clock.t += 100;
        await freshTookOver;
        published = "stale-result";
        return { leaked: true };
      },
    }));
    await waitUntil("stale advanced the lease clock", async () => clock.t >= 100);
    const fresh = createFileCoordinator(root, { limit: 1, leaseMs: 20, pollMs: 5, now: () => clock.t });
    const result = await fresh.run({
      id: "clip",
      stage: "encode",
      build: async () => {
        freshRan();
        return { leaked: false };
      },
    });
    expect(result).toEqual({ leaked: false });
    await abandoned;
    expect(published).toBe("stale-result");
    const replay = await createFileCoordinator(root).run({
      id: "clip",
      stage: "encode",
      build: async () => ({ leaked: "nope" }),
    });
    expect(replay).toEqual({ leaked: false });
  });

  it("edição interativa passa na frente do lote quando a vaga libera", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const coord = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const blocker = coord.run({
      id: "blocker",
      stage: "ingest",
      build: async () => {
        await held;
        return "blocker";
      },
    });
    await waitUntil("blocker holds the slot", async () => {
      try {
        const raw = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as unknown[];
        return Array.isArray(raw) && raw.length === 0;
      } catch {
        return false;
      }
    });
    const batch = coord.run({
      id: "batch",
      stage: "ingest",
      priority: "batch",
      build: async () => {
        order.push("batch");
        return "batch";
      },
    });
    const interactive = coord.run({
      id: "edit",
      stage: "ingest",
      priority: "interactive",
      build: async () => {
        order.push("interactive");
        return "edit";
      },
    });
    await waitUntil("batch and interactive are queued", async () => {
      try {
        const waiters = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as { priority: string }[];
        return waiters.some((w) => w.priority === "batch") && waiters.some((w) => w.priority === "interactive");
      } catch {
        return false;
      }
    });
    release();
    expect(await Promise.all([blocker, batch, interactive])).toEqual(["blocker", "batch", "edit"]);
    expect(order).toEqual(["interactive", "batch"]);
  });

  /** Se a trava prender, apaga o arquivo para o loop antigo conseguir sair. */
  async function correOuSolta(root: string, windowMs: number): Promise<"done" | "stuck"> {
    const coord = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    const run = coord.run({ id: "tarefa", stage: "speech", build: async () => "ok" });
    const settled = run.then(() => "done" as const, () => "done" as const);
    const winner = await Promise.race([
      settled,
      delay(windowMs).then(() => "stuck" as const),
    ]);
    if (winner === "stuck") {
      await unlink(join(root, ".lock")).catch(() => undefined);
      await settled;
    }
    return winner;
  }

  it("trava com o PID de um processo morto não segura a tarefa seguinte", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const code = await new Promise<number>((resolve, reject) => {
      child.on("exit", (status) => resolve(status ?? 1));
      child.on("error", reject);
    });
    expect(code).toBe(0);
    const pid = child.pid ?? 0;
    expect(() => process.kill(pid, 0)).toThrow();
    const root = dir();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".lock"), `${pid} ${hostname()}\n`, "utf8");
    expect(await correOuSolta(root, 800)).toBe("done");
  });

  it("trava sem PID e com data velha não segura a tarefa seguinte", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const lock = join(root, ".lock");
    await writeFile(lock, "sem pid\n", "utf8");
    const passado = new Date(Date.now() - 60_000);
    await utimes(lock, passado, passado);
    expect(await correOuSolta(root, 800)).toBe("done");
  });

  it("trava de um processo vivo e recente continua segurando", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".lock"), `${process.pid} ${hostname()}\n`, "utf8");
    expect(await correOuSolta(root, 250)).toBe("stuck");
  });
});
