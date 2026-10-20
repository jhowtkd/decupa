import { spawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdir, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
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
  it("single-flight: mesmo id com limit 2 executa um build e entrega o resultado aos dois", async () => {
    const root = dir();
    const coordinator = createFileCoordinator(root, { limit: 2, pollMs: 5, now: () => 1_000 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let builds = 0;
    const build = async () => {
      builds += 1;
      await held;
      return { value: "compartilhado" };
    };
    const first = coordinator.run({ id: "shared", stage: "speech", build });
    await waitUntil("primeiro build", async () => builds === 1);
    const controller = new AbortController();
    const second = coordinator.run({ id: "shared", stage: "speech", signal: controller.signal, build });
    const settled = Promise.allSettled([first, second]);
    try {
      await waitUntil("seguidor observado", async () => builds > 1 || getEventListeners(controller.signal, "abort").length > 0);
    } finally {
      release();
    }
    const results = await settled;
    expect(builds).toBe(1);
    expect(results).toEqual([
      { status: "fulfilled", value: { value: "compartilhado" } },
      { status: "fulfilled", value: { value: "compartilhado" } },
    ]);
  });

  it("single-flight: falha de build encerra o lease e permite nova tentativa", async () => {
    const root = dir();
    const coordinator = createFileCoordinator(root, { limit: 2, pollMs: 5, now: () => 1_000 });
    const error = new Error("falhou o build");
    await expect(coordinator.run({ id: "retry", stage: "speech", build: () => { throw error; } })).rejects.toBe(error);
    const record = JSON.parse(await readFile(join(root, "tasks", "retry.json"), "utf8"));
    expect(record).toMatchObject({ status: "failed", leaseId: null, leaseUntil: 0 });
    await expect(coordinator.run({ id: "retry", stage: "speech", build: () => "retomado" })).resolves.toBe("retomado");
  });

  it("single-flight: seguidor não bloqueia outra tarefa no segundo slot", async () => {
    const root = dir();
    let t = 1_000;
    const coordinator = createFileCoordinator(root, { limit: 2, pollMs: 5, now: () => t });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const owner = coordinator.run({ id: "shared", stage: "speech", build: async () => {
      started = true;
      await held;
      return "owner";
    } });
    await waitUntil("owner ocupa primeiro slot", async () => started);
    t += 1;
    const controller = new AbortController();
    let duplicateBuilds = 0;
    const follower = coordinator.run({ id: "shared", stage: "speech", signal: controller.signal, build: async () => {
      duplicateBuilds += 1;
      await held;
      return "duplicate";
    } });
    const settled = Promise.allSettled([owner, follower]);
    let other: Promise<string> | undefined;
    let otherStarted = false;
    try {
      await waitUntil("seguidor aguarda", async () => duplicateBuilds > 0 || getEventListeners(controller.signal, "abort").length > 0);
      t += 1;
      other = coordinator.run({ id: "different", stage: "speech", build: () => {
        otherStarted = true;
        return "different";
      } });
      await waitUntil("outra tarefa usa segundo slot sem liberar owner", async () => otherStarted, 1_500);
    } finally {
      controller.abort();
      release();
      await settled;
      await other;
    }
    expect(duplicateBuilds).toBe(0);
    expect(otherStarted).toBe(true);
  });

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

  it("remove listeners de abort do polling depois de concluir ou cancelar", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const coordinator = createFileCoordinator(root, { limit: 1, pollMs: 5 });

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const blocker = coordinator.withSlot({ stage: "rendering" }, () => held);
    await waitUntil("blocker holds the slot", async () => {
      try {
        const waiters = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as unknown[];
        return waiters.length === 0;
      } catch {
        return false;
      }
    });

    const completes = new AbortController();
    const completedWaiter = coordinator.withSlot({ stage: "rendering", signal: completes.signal }, () => "done");
    await waitUntil("completed waiter polls", async () => getEventListeners(completes.signal, "abort").length > 0);
    expect(getEventListeners(completes.signal, "abort").length).toBeGreaterThan(0);
    release();
    await Promise.all([blocker, completedWaiter]);
    expect(getEventListeners(completes.signal, "abort")).toHaveLength(0);

    // Repeat with cancellation while the waiter is polling behind a held slot.
    let releaseAgain!: () => void;
    const heldAgain = new Promise<void>((resolve) => { releaseAgain = resolve; });
    let blockerStarted!: () => void;
    const secondBlockerStarted = new Promise<void>((resolve) => { blockerStarted = resolve; });
    const secondBlocker = coordinator.withSlot({ stage: "rendering" }, async () => {
      blockerStarted();
      await heldAgain;
    });
    await secondBlockerStarted;
    const controller = new AbortController();
    const cancelledWaiter = coordinator.withSlot({ stage: "rendering", signal: controller.signal }, () => "unreachable");
    await waitUntil("cancelled waiter polls", async () => getEventListeners(controller.signal, "abort").length > 0);
    controller.abort();
    await expect(cancelledWaiter).rejects.toBeInstanceOf(CancelledError);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    releaseAgain();
    await secondBlocker;
  });

  it("cancelar depois do claim não inicia o trabalho", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    const coordinator = createFileCoordinator(root, { limit: 1, leaseMs: 300, pollMs: 5 });
    await mkdir(join(root, "slots"), { recursive: true });
    await writeFile(join(root, "slots", "0.json"), JSON.stringify({ leaseId: "outro", until: Date.now() + 300 }));
    const controller = new AbortController();
    let ran = false;
    const pending = coordinator.withSlot({ stage: "rendering", signal: controller.signal }, () => {
      ran = true;
      return "renderizado";
    });
    await delay(80);
    for (;;) {
      try {
        await writeFile(join(root, ".lock"), `${process.pid} ${hostname()}\n`, { flag: "wx" });
        break;
      } catch {
        await delay(1);
      }
    }
    await delay(50);
    controller.abort();
    await delay(250);
    await unlink(join(root, ".lock"));
    await expect(pending).rejects.toBeInstanceOf(CancelledError);
    expect(ran).toBe(false);
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
    // Lease de 200 ms e espera de 1 s (5 leases, além do limite de 4): com 40 ms
    // um waiter vivo podia ser tomado por morto numa máquina carregada.
    const coordinator = createFileCoordinator(root, { leaseMs: 200, pollMs: 5 });
    const order: string[] = [];
    const first = coordinator.withSlot({ stage: "rendering" }, () => delay(1_000));
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

  it("waiter deste processo não é descartado por outro mesmo sem renovar a tempo", async () => {
    const root = dir();
    await mkdir(join(root, "slots"), { recursive: true });
    // A vaga está com outro processo; o relógio falso pula 100 leases sem que o
    // waiter lento (polling de 1 s) tenha renovado, e a vaga libera. Antes, o
    // waiter rápido o tomava por morto, regravava a fila sem ele e pegava a vaga.
    await writeFile(join(root, "slots", "0.json"), JSON.stringify({ leaseId: "externo", until: Number.MAX_SAFE_INTEGER }));
    let t = 1_000;
    const order: string[] = [];
    const slow = createFileCoordinator(root, { leaseMs: 100, pollMs: 1_000, now: () => t });
    const fast = createFileCoordinator(root, { leaseMs: 100, pollMs: 5, now: () => t });
    const readQueue = async (): Promise<unknown[]> => {
      try {
        return JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as unknown[];
      } catch {
        return [];
      }
    };
    const second = slow.withSlot({ stage: "rendering" }, () => { order.push("b"); });
    await waitUntil("waiter lento", async () => (await readQueue()).length === 1);
    t += 10_000;
    await unlink(join(root, "slots", "0.json"));
    const third = fast.withSlot({ stage: "rendering" }, () => { order.push("c"); });
    await Promise.all([second, third]);
    expect(order).toEqual(["b", "c"]);
  });

  it("erro transitório ao ler a fila é tentado de novo, sem regravá-la vazia", async () => {
    const root = dir();
    // Um diretório no lugar do arquivo dá EISDIR, como o EBUSY/EPERM do Windows
    // durante a troca do arquivo. Ler isso como fila vazia apagava os waiters.
    await mkdir(join(root, "waiters.json"), { recursive: true });
    const coordinator = createFileCoordinator(root, { leaseMs: 200, pollMs: 5 });
    const run = coordinator.withSlot({ stage: "rendering" }, () => "ok");
    await delay(30);
    await rm(join(root, "waiters.json"), { recursive: true });
    await expect(run).resolves.toBe("ok");
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

  it("lote ultrapassado uma vez entra na ordem FIFO e não sofre starvation", async () => {
    const root = dir();
    await mkdir(root, { recursive: true });
    // Dois clientes independentes exercitam o marcador persistido entre processos.
    const batchClient = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    const interactiveClient = createFileCoordinator(root, { limit: 1, pollMs: 5 });
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const blocker = batchClient.withSlot({ stage: "rendering" }, () => held);
    await waitUntil("blocker holds the slot", async () => {
      try {
        return (JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as unknown[]).length === 0;
      } catch {
        return false;
      }
    });

    const batch = batchClient.withSlot({ stage: "rendering", priority: "batch" }, () => { order.push("batch"); });
    await waitUntil("batch queued", async () => {
      try {
        const queue = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as { priority: string }[];
        return queue.some((waiter) => waiter.priority === "batch");
      } catch {
        return false;
      }
    });
    let releaseInteractive!: () => void;
    let firstInteractiveStarted!: () => void;
    const interactiveHeld = new Promise<void>((resolve) => { releaseInteractive = resolve; });
    const interactiveStarted = new Promise<void>((resolve) => { firstInteractiveStarted = resolve; });
    const firstInteractive = interactiveClient.withSlot({ stage: "rendering", priority: "interactive" }, async () => {
      order.push("interactive-1");
      firstInteractiveStarted();
      await interactiveHeld;
    });
    await waitUntil("interactive overtakes batch", async () => {
      try {
        const queue = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as { priority: string; [key: string]: unknown }[];
        return queue.some((waiter) => waiter.priority === "interactive");
      } catch {
        return false;
      }
    });
    release();
    await blocker;
    await interactiveStarted;
    const secondInteractive = interactiveClient.withSlot({ stage: "rendering", priority: "interactive" }, () => { order.push("interactive-2"); });
    await waitUntil("second interactive queued", async () => {
      try {
        const queue = JSON.parse(await readFile(join(root, "waiters.json"), "utf8")) as { priority: string }[];
        return queue.some((waiter) => waiter.priority === "interactive");
      } catch {
        return false;
      }
    });
    releaseInteractive();
    await Promise.all([firstInteractive, batch, secondInteractive]);
    expect(order).toEqual(["interactive-1", "batch", "interactive-2"]);
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
