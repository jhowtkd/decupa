# App de limpeza de fala — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma página local onde você aponta um vídeo, lê o corte como prosa corrida, desliga o que não quer, e exporta MP4, EDL ou transcrição.

**Architecture:** Servidor `node:http` dentro de `apps/cli`, servindo uma página sem build step — o padrão que `apps/cli/src/mark-web/server.ts` já estabeleceu. O servidor não reimplementa nenhuma etapa do motor: invoca os mesmos comandos do SKILL.md. Toda a lógica que decide alguma coisa (EDL, review, estado do job) é função pura testada offline.

**Tech Stack:** TypeScript ESM (`--experimental-strip-types`), vitest, `node:http`, HTML/CSS/JS sem framework, pnpm workspaces.

**Spec:** [docs/superpowers/specs/2026-09-04-app-limpeza-design.md](../specs/2026-09-04-app-limpeza-design.md)

## Global Constraints

- **O app cobre os passos 1 a 6 do SKILL.md.** QC (passo 7) e entrega (passo 8) ficam fora do v1. Dentro desses seis, divergir do procedimento manual é bug do app.
- **O servidor invoca os comandos do motor, nunca reimplementa etapa.** Inclui `--drop-fillers hard` no plano, que é o default da skill.
- **Cada job tem seu diretório de trabalho**, passado ao motor por `CLAUDE_PROJECT_DIR`. Sem isso dois vídeos no mesmo cwd se sobrescrevem.
- **A triagem sempre recebe um proxy**, gerado com `fps=1,scale=270:480`. Mandar o original quebra: 11,2 MB viram 14,9 MB em base64 e voltam como erro genérico do provedor.
- **`keepList` é a mesma string que o `--keep` do motor consome** (`"u001-u003 u005-u022"`), nunca um array. Uma borda, um formato.
- **Clique não re-planeja.** Estado local; re-plano com debounce de 250 ms; export sempre re-planeja antes.
- **EDL v1: frame rate inteiro, non-drop-frame, um canal de vídeo, um reel.** Frame rate fracionário (29,97) falha com mensagem, nunca gera timecode errado em silêncio.
- **Bind em `127.0.0.1`**, nunca `0.0.0.0`. O app processa material de cliente; não se expõe à rede.
- Pacotes e testes seguem o padrão do repo: `<módulo>.test.ts` ao lado do fonte, `pnpm test`.
- Comentários e mensagens ao usuário em português.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `apps/cli/src/app/edl.ts` | clips + fps → texto CMX3600. Puro. |
| `apps/cli/src/app/review.ts` | plano + índice → o `Review` que a página consome. Puro. |
| `apps/cli/src/app/jobs.ts` | estado do job em memória. Puro. |
| `apps/cli/src/app/pipeline.ts` | invoca os comandos do motor; executor injetável. |
| `apps/cli/src/app/server.ts` | rotas |
| `apps/cli/src/app/page.html` | a página |
| `apps/cli/src/index.ts` | registra `decupa limpar` |

---

## Task 1: EDL

**Files:**
- Create: `apps/cli/src/app/edl.ts`
- Test: `apps/cli/src/app/edl.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `timecode(seconds: number, fps: number): string`, `buildEdl(opts: { clips: EdlClip[]; fps: number; title: string }): string`, `EdlClip = { start: number; end: number }`.

- [ ] **Step 1: Escrever o teste que falha**

`apps/cli/src/app/edl.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildEdl, timecode } from "./edl.ts";

describe("timecode", () => {
  it("zero é 00:00:00:00", () => {
    expect(timecode(0, 30)).toBe("00:00:00:00");
  });

  it("um segundo a 30fps", () => {
    expect(timecode(1, 30)).toBe("00:00:01:00");
  });

  it("converte fração de segundo em quadro", () => {
    // 25,318s × 30 = 759,54 → quadro 760 → 25s + quadro 10
    expect(timecode(25.318, 30)).toBe("00:00:25:10");
  });

  it("passa de minuto e de hora", () => {
    expect(timecode(61, 25)).toBe("00:01:01:00");
    expect(timecode(3661, 25)).toBe("01:01:01:00");
  });

  it("não deixa o quadro chegar ao valor do fps", () => {
    // 0,999s a 30fps arredonda para 30 quadros, que é 1s exato, não ":30"
    expect(timecode(0.999, 30)).toBe("00:00:01:00");
  });
});

describe("buildEdl", () => {
  const clips = [
    { start: 25.318, end: 28.436 },
    { start: 31.956, end: 35.141 },
  ];

  it("abre com título e FCM não-drop-frame", () => {
    const edl = buildEdl({ clips, fps: 30, title: "corte" });
    expect(edl).toContain("TITLE: corte");
    expect(edl).toContain("FCM: NON-DROP FRAME");
  });

  it("numera os eventos a partir de 001", () => {
    const edl = buildEdl({ clips, fps: 30, title: "c" });
    expect(edl).toMatch(/^001\s+AX\s+V\s+C\s+/m);
    expect(edl).toMatch(/^002\s+AX\s+V\s+C\s+/m);
  });

  it("usa o tempo de fonte de cada clipe como source in/out", () => {
    const edl = buildEdl({ clips, fps: 30, title: "c" });
    expect(edl).toContain("00:00:25:10 00:00:28:13");
  });

  it("encadeia o record timecode sem buraco entre eventos", () => {
    // clipe 1 dura 3,118s = 94 quadros; o evento 2 começa exatamente ali
    const linhas = buildEdl({ clips, fps: 30, title: "c" })
      .split("\n").filter((l) => /^\d{3}\s/.test(l));
    expect(linhas[0]).toContain("00:00:00:00 00:00:03:04");
    expect(linhas[1]!).toContain("00:00:03:04 00:00:06:07");
  });

  it("recusa frame rate fracionário em vez de gerar timecode errado", () => {
    expect(() => buildEdl({ clips, fps: 29.97, title: "c" })).toThrow(/29\.97|inteiro/);
  });

  it("recusa lista de clipes vazia", () => {
    expect(() => buildEdl({ clips: [], fps: 30, title: "c" })).toThrow(/nenhum clipe/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run apps/cli/src/app/edl.test.ts`
Expected: FAIL — `Failed to resolve import "./edl.ts"`

- [ ] **Step 3: Implementar**

`apps/cli/src/app/edl.ts`:

```ts
export interface EdlClip {
  /** segundos na fonte */
  start: number;
  end: number;
}

/** Segundos → `HH:MM:SS:FF`. */
export function timecode(seconds: number, fps: number): string {
  const totalFrames = Math.round(seconds * fps);
  const frame = totalFrames % fps;
  const whole = Math.floor(totalFrames / fps);
  const parts = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60, frame];
  return parts.map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * Lista de cortes no formato CMX3600, que Premiere e DaVinci importam sem
 * plugin. Entrega os cortes na timeline da ferramenta onde o editor já
 * trabalha, com o material original intacto — ao contrário do MP4, que ninguém
 * consegue mais ajustar.
 *
 * Escopo deliberadamente estreito no v1: frame rate inteiro, non-drop-frame,
 * um canal de vídeo, um reel. Drop-frame 29,97 e faixas de áudio separadas são
 * projeto próprio; deixá-los em aberto faria o EDL virar um segundo projeto no
 * meio do primeiro.
 */
export function buildEdl(opts: { clips: EdlClip[]; fps: number; title: string }): string {
  const { clips, fps, title } = opts;
  if (clips.length === 0) throw new Error("nenhum clipe para exportar");
  if (!Number.isInteger(fps)) {
    throw new Error(
      `frame rate ${fps} não é inteiro. O EDL do v1 só gera non-drop-frame com fps ` +
      "inteiro; para 29.97 o timecode sairia errado em silêncio.",
    );
  }

  const lines = [`TITLE: ${title}`, "FCM: NON-DROP FRAME", ""];
  let recordFrames = 0;

  clips.forEach((clip, i) => {
    const durationFrames = Math.round(clip.end * fps) - Math.round(clip.start * fps);
    const recordIn = recordFrames / fps;
    const recordOut = (recordFrames + durationFrames) / fps;
    lines.push(
      `${String(i + 1).padStart(3, "0")}  AX       V     C        ` +
      `${timecode(clip.start, fps)} ${timecode(clip.end, fps)} ` +
      `${timecode(recordIn, fps)} ${timecode(recordOut, fps)}`,
    );
    recordFrames += durationFrames;
  });

  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run apps/cli/src/app/edl.test.ts`
Expected: PASS, 11 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/edl.ts apps/cli/src/app/edl.test.ts
git commit -m "feat(app): exportação de lista de cortes em CMX3600"
```

---

## Task 2: Review

**Files:**
- Create: `apps/cli/src/app/review.ts`
- Test: `apps/cli/src/app/review.test.ts`

**Interfaces:**
- Consumes: nada (lê JSON já parseado).
- Produces: `Review`, `ReviewUnit`, `ReviewJoin`, `buildReview(plan: unknown, index: unknown): Review`.

- [ ] **Step 1: Escrever o teste que falha**

`apps/cli/src/app/review.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildReview } from "./review.ts";

const index = {
  units: [
    { id: "u001", index: 0, text: "Eu esqueci o começo." },
    { id: "u002", index: 1, text: "Dicas pra você." },
    { id: "u003", index: 2, text: "Primeira coisa." },
  ],
};

const plan = {
  source_duration: 40,
  output_duration: 12,
  clips: [{ unit_ids: ["u002", "u003"], start: 10, end: 22 }],
  joins: [{
    outgoing_unit: "u002",
    incoming_unit: "u003",
    removed_seconds: 3.5,
    outgoing_tail: "pra você.",
    incoming_head: "Primeira coisa",
    flags: [{
      code: "mid_thought_out", severity: "warning",
      message: "u002 não tem pontuação final", hint: "Estenda o clipe.",
    }],
  }],
};

describe("buildReview", () => {
  it("traz todas as unidades, em ordem de fonte", () => {
    expect(buildReview(plan, index).units.map((u) => u.id)).toEqual(["u001", "u002", "u003"]);
  });

  it("marca como kept só as que aparecem em algum clipe", () => {
    const { units } = buildReview(plan, index);
    expect(units.map((u) => u.kept)).toEqual([false, true, true]);
  });

  it("inclui as dropadas — é o que permite restaurar sem re-planejar", () => {
    expect(buildReview(plan, index).units[0]).toEqual({
      id: "u001", text: "Eu esqueci o começo.", kept: false,
    });
  });

  it("leva o texto dos dois lados da junção", () => {
    const [join] = buildReview(plan, index).joins;
    expect(join!.outgoingTail).toBe("pra você.");
    expect(join!.incomingHead).toBe("Primeira coisa");
  });

  it("preserva os flags como objetos, com o hint", () => {
    // Achatar para string jogaria fora o hint, que é a única parte acionável.
    const [join] = buildReview(plan, index).joins;
    expect(join!.flags[0]!.code).toBe("mid_thought_out");
    expect(join!.flags[0]!.hint).toBe("Estenda o clipe.");
  });

  it("ancora a junção na unidade de saída", () => {
    expect(buildReview(plan, index).joins[0]!.afterUnitId).toBe("u002");
  });

  it("copia as durações do plano", () => {
    const review = buildReview(plan, index);
    expect(review.outputSeconds).toBe(12);
    expect(review.sourceSeconds).toBe(40);
  });

  it("aguenta plano sem junção nenhuma", () => {
    expect(buildReview({ ...plan, joins: [] }, index).joins).toEqual([]);
  });

  it("aguenta join sem flags", () => {
    const semFlags = { ...plan, joins: [{ ...plan.joins[0], flags: undefined }] };
    expect(buildReview(semFlags, index).joins[0]!.flags).toEqual([]);
  });

  it("estoura em índice sem units em vez de devolver review vazio", () => {
    expect(() => buildReview(plan, { units: [] })).toThrow(/units/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run apps/cli/src/app/review.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`apps/cli/src/app/review.ts`:

```ts
export interface ReviewUnit {
  id: string;
  text: string;
  kept: boolean;
}

export interface ReviewFlag {
  code: string;
  severity: string;
  message: string;
  hint: string;
}

export interface ReviewJoin {
  afterUnitId: string;
  incomingUnitId: string;
  removedSeconds: number;
  /** as últimas palavras antes do corte */
  outgoingTail: string;
  /** as primeiras depois */
  incomingHead: string;
  flags: ReviewFlag[];
}

export interface Review {
  units: ReviewUnit[];
  joins: ReviewJoin[];
  outputSeconds: number;
  sourceSeconds: number;
}

/**
 * O que a página consome: as unidades em ordem de fonte com o estado de cada
 * uma, mais as junções com o texto dos dois lados.
 *
 * As unidades dropadas vêm junto de propósito — é o que permite restaurar sem
 * ida ao servidor, e é o que faz o marcador colapsado poder mostrar o texto que
 * saiu. Sem isso, restaurar viraria caça ao tesouro entre marcadores idênticos.
 */
export function buildReview(rawPlan: unknown, rawIndex: unknown): Review {
  const plan = rawPlan as Record<string, any>;
  const index = rawIndex as Record<string, any>;

  const rawUnits = index?.units;
  if (!Array.isArray(rawUnits) || rawUnits.length === 0) {
    throw new Error("índice sem `units` — rode `condense.py index` antes");
  }

  const kept = new Set<string>();
  for (const clip of plan?.clips ?? []) {
    for (const id of clip.unit_ids ?? []) kept.add(String(id));
  }

  const units: ReviewUnit[] = [...rawUnits]
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map((u) => ({ id: String(u.id), text: String(u.text ?? ""), kept: kept.has(String(u.id)) }));

  const joins: ReviewJoin[] = (plan?.joins ?? []).map((j: Record<string, any>) => ({
    afterUnitId: String(j.outgoing_unit ?? ""),
    incomingUnitId: String(j.incoming_unit ?? ""),
    removedSeconds: Number(j.removed_seconds ?? 0),
    outgoingTail: String(j.outgoing_tail ?? ""),
    incomingHead: String(j.incoming_head ?? ""),
    // Os flags do motor são objetos {code, severity, message, hint}. O `hint`
    // diz o que fazer a respeito, então achatar para string perde a única
    // parte acionável.
    flags: (j.flags ?? []).map((f: Record<string, any>) => ({
      code: String(f.code ?? ""),
      severity: String(f.severity ?? "warning"),
      message: String(f.message ?? ""),
      hint: String(f.hint ?? ""),
    })),
  }));

  return {
    units,
    joins,
    outputSeconds: Number(plan?.output_duration ?? 0),
    sourceSeconds: Number(plan?.source_duration ?? 0),
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run apps/cli/src/app/review.test.ts`
Expected: PASS, 10 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/review.ts apps/cli/src/app/review.test.ts
git commit -m "feat(app): monta o review que a página consome a partir do plano e do índice"
```

---

## Task 3: Estado do job

**Files:**
- Create: `apps/cli/src/app/jobs.ts`
- Test: `apps/cli/src/app/jobs.test.ts`

**Interfaces:**
- Consumes: `Review` (Task 2).
- Produces: `Stage`, `Job`, `JobStore` com `create`, `get`, `setStage`, `setReview`, `fail`, `cancel`, `keepListOf`, `setKeepList`.

- [ ] **Step 1: Escrever o teste que falha**

`apps/cli/src/app/jobs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { JobStore } from "./jobs.ts";

const review = { units: [], joins: [], outputSeconds: 0, sourceSeconds: 0 };

describe("JobStore", () => {
  it("cria o job em `queued` com id próprio", () => {
    const store = new JobStore();
    const job = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    expect(job.stage).toBe("queued");
    expect(job.id).toMatch(/\S/);
  });

  it("dá ids diferentes a jobs diferentes", () => {
    const store = new JobStore();
    const a = store.create({ videoPath: "/a.mp4", workDir: "/w" });
    const b = store.create({ videoPath: "/b.mp4", workDir: "/w" });
    expect(a.id).not.toBe(b.id);
  });

  it("devolve undefined para id que não existe", () => {
    expect(new JobStore().get("nada")).toBeUndefined();
  });

  it("avança de estágio", () => {
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.setStage(id, "transcribing");
    expect(store.get(id)!.stage).toBe("transcribing");
  });

  it("guarda o review e vai para `ready`", () => {
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.setReview(id, review, "u001-u003");
    expect(store.get(id)!.stage).toBe("ready");
    expect(store.get(id)!.keepList).toBe("u001-u003");
  });

  it("falhar guarda a mensagem e vai para `error`", () => {
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.fail(id, "ffmpeg não encontrado");
    expect(store.get(id)!.stage).toBe("error");
    expect(store.get(id)!.error).toBe("ffmpeg não encontrado");
  });

  it("não deixa um job que falhou voltar a avançar", () => {
    // Uma etapa que termina depois do erro não pode apagar o erro da tela.
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.fail(id, "morreu");
    store.setStage(id, "planning");
    expect(store.get(id)!.stage).toBe("error");
  });

  it("cancelar é terminal do mesmo jeito", () => {
    const store = new JobStore();
    const { id } = store.create({ videoPath: "/v.mp4", workDir: "/w" });
    store.cancel(id);
    store.setStage(id, "indexing");
    expect(store.get(id)!.stage).toBe("cancelled");
  });

  it("ignora operação em id inexistente sem estourar", () => {
    expect(() => new JobStore().setStage("nada", "indexing")).not.toThrow();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run apps/cli/src/app/jobs.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`apps/cli/src/app/jobs.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Review } from "./review.ts";

export type Stage =
  | "queued" | "transcribing" | "indexing" | "planning"
  | "ready" | "error" | "cancelled";

const TERMINAL: ReadonlySet<Stage> = new Set(["error", "cancelled"]);

export interface Job {
  id: string;
  videoPath: string;
  workDir: string;
  stage: Stage;
  error?: string;
  keepList?: string;
  review?: Review;
}

/**
 * Um job por vez, em memória, sem banco. É app local de um usuário só;
 * persistência e fila seriam complexidade sem cliente. Reiniciar perde o job
 * em andamento, o que é aceitável porque a transcrição fica em cache no
 * diretório de trabalho e re-rodar sai barato.
 */
export class JobStore {
  private readonly jobs = new Map<string, Job>();

  create(opts: { videoPath: string; workDir: string }): Job {
    const job: Job = { id: randomUUID(), stage: "queued", ...opts };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Estado terminal não volta atrás: etapa que termina depois de um erro
   *  não pode apagar o erro da tela. */
  private mutate(id: string, patch: Partial<Job>, force = false): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (TERMINAL.has(job.stage) && !force) return;
    this.jobs.set(id, { ...job, ...patch });
  }

  setStage(id: string, stage: Stage): void {
    this.mutate(id, { stage });
  }

  setReview(id: string, review: Review, keepList: string): void {
    this.mutate(id, { review, keepList, stage: "ready" });
  }

  setKeepList(id: string, keepList: string): void {
    this.mutate(id, { keepList });
  }

  fail(id: string, error: string): void {
    this.mutate(id, { stage: "error", error }, true);
  }

  cancel(id: string): void {
    this.mutate(id, { stage: "cancelled" }, true);
  }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run apps/cli/src/app/jobs.test.ts`
Expected: PASS, 9 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/jobs.ts apps/cli/src/app/jobs.test.ts
git commit -m "feat(app): estado do job em memória, com estágio terminal irreversível"
```

---

## Task 4: Pipeline

**Files:**
- Create: `apps/cli/src/app/pipeline.ts`
- Test: `apps/cli/src/app/pipeline.test.ts`

**Interfaces:**
- Consumes: nada de tasks anteriores em runtime.
- Produces: `Executor`, `ExecResult`, `FakeExecutor`, `runIngest(...)`, `runPlan(...)`, `runTriage(...)`, `runRender(...)`, `makeTriageProxy(...)`.

- [ ] **Step 1: Escrever o teste que falha**

`apps/cli/src/app/pipeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeExecutor, makeTriageProxy, runIngest, runPlan } from "./pipeline.ts";

const job = { id: "j1", videoPath: "/vid/aula.mp4", workDir: "/work/j1" };

describe("runIngest", () => {
  it("transcreve, indexa e reporta cada estágio na ordem", async () => {
    const exec = new FakeExecutor();
    const stages: string[] = [];
    await runIngest(job, exec, (s) => stages.push(s));
    expect(stages).toEqual(["transcribing", "indexing"]);
  });

  it("passa CLAUDE_PROJECT_DIR para o motor em toda chamada", async () => {
    // Sem diretório por job, dois vídeos no mesmo cwd se sobrescrevem.
    const exec = new FakeExecutor();
    await runIngest(job, exec, () => {});
    for (const call of exec.calls) {
      expect(call.env?.CLAUDE_PROJECT_DIR).toBe("/work/j1");
    }
  });

  it("estoura com a saída do motor quando uma etapa falha", async () => {
    const exec = new FakeExecutor({ code: 2, stdout: "[ERROR] transcript inválido" });
    await expect(runIngest(job, exec, () => {})).rejects.toThrow(/transcript inválido/);
  });
});

describe("runPlan", () => {
  it("sempre manda --drop-fillers hard, que é o default da skill", async () => {
    const exec = new FakeExecutor();
    await runPlan(job, "u001-u003 u005", exec);
    const call = exec.calls.at(-1)!;
    expect(call.args).toContain("--drop-fillers");
    expect(call.args).toContain("hard");
  });

  it("passa o keep-list como itens separados, não como uma string só", async () => {
    // `--keep u001-u003 u005` são dois argumentos para o argparse do motor.
    const exec = new FakeExecutor();
    await runPlan(job, "u001-u003 u005", exec);
    const { args } = exec.calls.at(-1)!;
    expect(args.slice(args.indexOf("--keep") + 1, args.indexOf("--keep") + 3))
      .toEqual(["u001-u003", "u005"]);
  });

  it("recusa keep-list vazio antes de chamar o motor", async () => {
    const exec = new FakeExecutor();
    await expect(runPlan(job, "   ", exec)).rejects.toThrow(/keep/);
    expect(exec.calls).toHaveLength(0);
  });
});

describe("makeTriageProxy", () => {
  it("gera o proxy a 1 fps e resolução reduzida", async () => {
    // Mandar o original quebra: 11,2 MB viram 14,9 MB em base64 e voltam como
    // erro genérico do provedor.
    const exec = new FakeExecutor();
    const out = await makeTriageProxy(job, exec);
    const { command, args } = exec.calls.at(-1)!;
    expect(command).toBe("ffmpeg");
    expect(args.join(" ")).toContain("fps=1,scale=270:480");
    expect(out).toContain("triage-proxy.mp4");
  });

  it("não regera o proxy se ele já existe", async () => {
    const exec = new FakeExecutor();
    await makeTriageProxy(job, exec, { exists: async () => true });
    expect(exec.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run apps/cli/src/app/pipeline.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`apps/cli/src/app/pipeline.ts`:

```ts
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecCall {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface Executor {
  run(call: ExecCall): Promise<ExecResult>;
}

export interface PipelineJob {
  id: string;
  videoPath: string;
  workDir: string;
}

export class SpawnExecutor implements Executor {
  run(call: ExecCall): Promise<ExecResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(call.command, call.args, {
        env: { ...process.env, ...call.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += String(d); });
      child.stderr.on("data", (d) => { stderr += String(d); });
      child.on("error", reject);
      child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    });
  }
}

/** Roteiriza a saída para testar o pipeline sem rodar WhisperX. */
export class FakeExecutor implements Executor {
  readonly calls: ExecCall[] = [];
  constructor(private readonly result: Partial<ExecResult> = {}) {}
  async run(call: ExecCall): Promise<ExecResult> {
    this.calls.push(call);
    return { code: 0, stdout: "", stderr: "", ...this.result };
  }
}

function envFor(job: PipelineJob): Record<string, string> {
  // O motor grava out/ e .video_agent/ no cwd ou em CLAUDE_PROJECT_DIR. Sem um
  // diretório por job, dois vídeos se sobrescrevem.
  return { CLAUDE_PROJECT_DIR: job.workDir };
}

async function must(exec: Executor, call: ExecCall, what: string): Promise<ExecResult> {
  const result = await exec.run(call);
  if (result.code !== 0) {
    const detail = (result.stdout + result.stderr).trim().slice(0, 500);
    throw new Error(`${what} falhou (código ${result.code}): ${detail || "sem saída"}`);
  }
  return result;
}

export const transcriptPath = (job: PipelineJob) => join(job.workDir, "transcript.json");
export const planPath = (job: PipelineJob) => join(job.workDir, "out", "condense_plan.json");
export const indexPath = (job: PipelineJob) => join(job.workDir, "out", "speech_index.json");

export async function runIngest(
  job: PipelineJob,
  exec: Executor,
  onStage: (stage: "transcribing" | "indexing") => void,
): Promise<void> {
  onStage("transcribing");
  await must(exec, {
    command: "pnpm",
    args: ["decupa", "condense-prep", "--input", job.videoPath, "--out", transcriptPath(job)],
    env: envFor(job),
  }, "a transcrição");

  onStage("indexing");
  await must(exec, {
    command: "python3",
    args: ["scripts/condense.py", "index", job.videoPath, transcriptPath(job)],
    env: envFor(job),
  }, "a medição do índice");
}

export async function runPlan(job: PipelineJob, keepList: string, exec: Executor): Promise<void> {
  const ranges = keepList.trim().split(/\s+/).filter(Boolean);
  if (ranges.length === 0) {
    throw new Error("keep-list vazio: nada sobraria no corte");
  }
  await must(exec, {
    command: "python3",
    args: [
      "scripts/condense.py", "plan", job.videoPath,
      "--keep", ...ranges,
      "--drop-fillers", "hard",
    ],
    env: envFor(job),
  }, "o plano");
}

export async function makeTriageProxy(
  job: PipelineJob,
  exec: Executor,
  fs: { exists?: (p: string) => Promise<boolean> } = {},
): Promise<string> {
  const out = join(job.workDir, "triage-proxy.mp4");
  const exists = fs.exists ?? (async (p) => access(p).then(() => true, () => false));
  if (await exists(out)) return out;

  await must(exec, {
    command: "ffmpeg",
    args: [
      "-i", job.videoPath,
      "-vf", "fps=1,scale=270:480",
      "-c:v", "libx264", "-crf", "32", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "24k", "-ac", "1",
      "-y", out,
    ],
    env: envFor(job),
  }, "a geração do proxy de triagem");
  return out;
}

export async function runTriage(job: PipelineJob, exec: Executor, provider: string): Promise<string> {
  const proxy = await makeTriageProxy(job, exec);
  const result = await must(exec, {
    command: "pnpm",
    args: [
      "decupa", "triage",
      "--index", indexPath(job), "--video", proxy,
      "--out", join(job.workDir, "out"), "--provider", provider,
    ],
    env: envFor(job),
  }, "a triagem");

  const match = /keep-list:\s*(.+)/.exec(result.stdout);
  if (!match) throw new Error(`a triagem não devolveu keep-list: ${result.stdout.slice(0, 300)}`);
  return match[1]!.trim();
}

export async function runRender(job: PipelineJob, outPath: string, exec: Executor): Promise<string> {
  await must(exec, {
    command: "python3",
    args: ["scripts/condense.py", "render", job.videoPath, outPath],
    env: envFor(job),
  }, "o render");
  return outPath;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run apps/cli/src/app/pipeline.test.ts`
Expected: PASS, 8 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/pipeline.ts apps/cli/src/app/pipeline.test.ts
git commit -m "feat(app): pipeline que invoca o motor, com executor injetável"
```

---

## Task 5: Servidor

**Files:**
- Create: `apps/cli/src/app/server.ts`
- Test: `apps/cli/src/app/server.test.ts`

**Interfaces:**
- Consumes: `JobStore` (Task 3), `buildReview` (Task 2), `buildEdl` (Task 1), pipeline (Task 4).
- Produces: `startApp(opts: { input: string; port?: number; provider?: string }): Promise<{ port: number; close(): Promise<void> }>`.

- [ ] **Step 1: Escrever o teste que falha**

`apps/cli/src/app/server.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "./server.ts";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { await stop?.(); stop = null; });

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "decupa-app-"));
  const app = await startApp({ input: join(dir, "v.mp4"), port: 0, autoStart: false });
  stop = app.close;
  return { app, base: `http://127.0.0.1:${app.port}` };
}

describe("startApp", () => {
  it("sobe numa porta e serve a página em /", async () => {
    const { base } = await boot();
    const res = await fetch(base);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("escuta só em 127.0.0.1", async () => {
    // O app processa material de cliente; não se expõe à rede.
    const { app } = await boot();
    expect(app.address).toBe("127.0.0.1");
  });

  it("404 com corpo curto para rota que não existe", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/nada`)).status).toBe(404);
  });

  it("devolve 404 para job inexistente", async () => {
    const { base } = await boot();
    expect((await fetch(`${base}/jobs/inexistente`)).status).toBe(404);
  });

  it("recusa keep-list que não é string", async () => {
    const { base, app } = await boot();
    const res = await fetch(`${base}/jobs/${app.jobId}/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList: ["u001", "u002"] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/string/);
  });

  it("cancelar leva o job a `cancelled`", async () => {
    const { base, app } = await boot();
    await fetch(`${base}/jobs/${app.jobId}/cancel`, { method: "POST" });
    const body = await (await fetch(`${base}/jobs/${app.jobId}`)).json() as { stage: string };
    expect(body.stage).toBe("cancelled");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run apps/cli/src/app/server.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`apps/cli/src/app/server.ts`:

```ts
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEdl } from "./edl.ts";
import { JobStore } from "./jobs.ts";
import {
  indexPath, planPath, runIngest, runPlan, runRender, runTriage,
  SpawnExecutor, type Executor, type PipelineJob,
} from "./pipeline.ts";
import { buildReview } from "./review.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export interface AppHandle {
  port: number;
  address: string;
  jobId: string;
  close(): Promise<void>;
}

export async function startApp(opts: {
  input: string;
  port?: number;
  provider?: string;
  executor?: Executor;
  /** false nos testes: não dispara o pipeline de verdade. */
  autoStart?: boolean;
}): Promise<AppHandle> {
  const input = resolve(opts.input);
  const exec = opts.executor ?? new SpawnExecutor();
  const provider = opts.provider ?? "gemini";
  const page = await readFile(join(HERE, "page.html"), "utf8");

  const workDir = join(dirname(input), `.decupa-${basename(input).replace(/\.[^.]+$/, "")}`);
  await mkdir(join(workDir, "out"), { recursive: true });

  const store = new JobStore();
  const job = store.create({ videoPath: input, workDir });
  const pipelineJob: PipelineJob = { id: job.id, videoPath: input, workDir };

  /** Re-planeja e recarrega o review. Chamado no /keep e antes de exportar. */
  async function replan(keepList: string): Promise<void> {
    store.setStage(job.id, "planning");
    await runPlan(pipelineJob, keepList, exec);
    const review = buildReview(await readJson(planPath(pipelineJob)), await readJson(indexPath(pipelineJob)));
    store.setReview(job.id, review, keepList);
  }

  async function ingest(): Promise<void> {
    try {
      await runIngest(pipelineJob, exec, (stage) => store.setStage(job.id, stage));
      const index = await readJson(indexPath(pipelineJob)) as { units: { id: string }[] };
      const all = `${index.units[0]!.id}-${index.units[index.units.length - 1]!.id}`;
      await replan(all);
    } catch (error) {
      store.fail(job.id, error instanceof Error ? error.message : String(error));
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    const handle = async (): Promise<void> => {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }

      if (parts[0] === "jobs" && parts[1]) {
        const current = store.get(parts[1]);
        if (!current) { sendJson(res, { error: "job não existe" }, 404); return; }

        if (parts.length === 2 && req.method === "GET") {
          sendJson(res, {
            stage: current.stage, error: current.error,
            keepList: current.keepList, review: current.review,
          });
          return;
        }

        if (parts[2] === "cancel" && req.method === "POST") {
          store.cancel(current.id);
          sendJson(res, { ok: true });
          return;
        }

        if (parts[2] === "keep" && req.method === "POST") {
          const body = await readBody(req);
          // A borda aceita um formato só: a mesma string que o --keep consome.
          if (typeof body.keepList !== "string") {
            sendJson(res, { error: "keepList precisa ser string, no formato \"u001-u003 u005\"" }, 400);
            return;
          }
          await replan(body.keepList);
          sendJson(res, { review: store.get(current.id)!.review });
          return;
        }

        if (parts[2] === "triage" && req.method === "POST") {
          const suggested = await runTriage(pipelineJob, exec, provider);
          const report = await readFile(join(workDir, "out", "triage.md"), "utf8")
            .catch(() => "");
          // Prévia: devolve a sugestão e o relatório, não aplica.
          sendJson(res, { keepList: suggested, report });
          return;
        }

        if (parts[2] === "export" && req.method === "POST") {
          const body = await readBody(req);
          const kind = String(body.kind ?? "");
          // Export sempre re-planeja: nenhum arquivo sai de um plano velho.
          if (typeof body.keepList === "string") await replan(body.keepList);
          const plan = await readJson(planPath(pipelineJob)) as Record<string, any>;

          if (kind === "edl") {
            const fps = Math.round(Number(body.fps ?? 30));
            const out = join(workDir, "corte.edl");
            await writeFile(out, buildEdl({
              clips: plan.clips, fps, title: basename(input),
            }), "utf8");
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/edl` });
            return;
          }
          if (kind === "mp4") {
            const out = join(workDir, "corte.mp4");
            await runRender(pipelineJob, out, exec);
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/mp4` });
            return;
          }
          if (kind === "transcript") {
            sendJson(res, {
              path: join(workDir, "out", "condensed_transcript.json"),
              downloadUrl: `/jobs/${current.id}/download/transcript`,
            });
            return;
          }
          sendJson(res, { error: `kind desconhecido: ${kind}` }, 400);
          return;
        }

        if (parts[2] === "download" && parts[3]) {
          const files: Record<string, string> = {
            edl: join(workDir, "corte.edl"),
            mp4: join(workDir, "corte.mp4"),
            transcript: join(workDir, "out", "condensed_transcript.json"),
          };
          const path = files[parts[3]];
          if (!path) { sendJson(res, { error: "arquivo desconhecido" }, 404); return; }
          const data = await readFile(path);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${basename(path)}"`,
            "content-length": data.length,
          });
          res.end(data);
          return;
        }
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("não encontrado");
    };

    handle().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) sendJson(res, { error: message }, 500);
      else res.end();
    });
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 7788, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (opts.port ?? 7788);

  if (opts.autoStart !== false) void ingest();

  return {
    port, address: "127.0.0.1", jobId: job.id,
    close: async () => {
      await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
    },
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run apps/cli/src/app/server.test.ts`
Expected: PASS, 6 testes.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/server.ts apps/cli/src/app/server.test.ts
git commit -m "feat(app): servidor com rotas de job, keep, triagem, export e download"
```

---

## Task 6: Página e comando

**Files:**
- Create: `apps/cli/src/app/page.html`
- Modify: `apps/cli/src/index.ts`

**Interfaces:**
- Consumes: `startApp` (Task 5).
- Produces: o comando `decupa limpar`.

- [ ] **Step 1: Escrever a página**

`apps/cli/src/app/page.html` — segue o visual do `mark-web` (mesmas variáveis
de cor, mesma tipografia):

```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>decupa · limpar fala</title>
<style>
  :root {
    --bg: #12171a; --panel: #1a2125; --line: #2a3439;
    --ink: #e4e9e5; --muted: #94a0a5; --accent: #f2c230;
    --ok: #63be97; --warn: #e0765c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.75 ui-serif, Georgia, serif;
  }
  header {
    position: sticky; top: 0; display: flex; align-items: center; gap: 18px;
    padding: 12px 18px; border-bottom: 1px solid var(--line);
    background: var(--panel); font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 13px;
  }
  main { max-width: 44rem; margin: 0 auto; padding: 32px 20px 120px; }
  button {
    font: inherit; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px;
    background: var(--panel); color: var(--ink); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 12px; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  /* A unidade mantida é texto corrido. O X só aparece no hover, para não
     poluir a leitura — que é o ponto da tela. */
  .u { position: relative; }
  .u .x {
    opacity: 0; cursor: pointer; color: var(--warn);
    font-family: ui-sans-serif, sans-serif; font-size: 11px; padding: 0 3px;
  }
  .u:hover .x { opacity: 1; }
  /* Dropada: colapsa para um marcador com as primeiras palavras, e o texto
     em volta se fecha. O título traz o texto inteiro. */
  .gone {
    display: inline-block; max-width: 12rem; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;
    font-family: ui-sans-serif, sans-serif; font-size: 11px;
    color: var(--muted); background: #ffffff0d; border: 1px dashed var(--line);
    border-radius: 4px; padding: 0 6px; margin: 0 2px; cursor: pointer;
  }
  .gone:hover { color: var(--ink); border-color: var(--accent); }
  .join { display: block; margin: 14px 0; font-family: ui-sans-serif, sans-serif; font-size: 12px; }
  .join .flag { color: var(--warn); display: block; padding-left: 10px; border-left: 2px solid var(--warn); }
  .join .hint { color: var(--muted); }
  #stage { color: var(--muted); font-family: ui-sans-serif, sans-serif; }
</style>
</head>
<body>
<header>
  <strong>decupa</strong>
  <span id="stage">carregando…</span>
  <span style="flex:1"></span>
  <button id="triar">sugerir cortes</button>
  <button id="edl">exportar EDL</button>
  <button id="mp4">exportar MP4</button>
  <button id="txt">transcrição</button>
</header>
<main id="prosa"></main>
<script>
const jobId = new URLSearchParams(location.search).get("job") || window.__JOB__;
let review = null, kept = new Map(), timer = null;

const api = (p, o) => fetch(`/jobs/${jobId}${p}`, o).then((r) => r.json());

function keepList() {
  // Mesma string que o --keep do motor consome: faixas de ids consecutivos.
  // Guarda o id de fim, não o número: reconstruir "u" + padStart(3) quebraria
  // silenciosamente num vídeo com mais de 999 unidades, e o corte sairia
  // errado sem nada avisar.
  const ids = review.units.filter((u) => kept.get(u.id)).map((u) => u.id);
  const num = (id) => Number(id.slice(1));
  const out = [];
  let startId = null, prevId = null;
  for (const id of ids) {
    if (prevId === null || num(id) !== num(prevId) + 1) {
      if (startId) out.push(range(startId, prevId));
      startId = id;
    }
    prevId = id;
  }
  if (startId) out.push(range(startId, prevId));
  return out.join(" ");
}
const range = (startId, endId) => (startId === endId ? startId : `${startId}-${endId}`);

function render() {
  const joinsBy = new Map(review.joins.map((j) => [j.afterUnitId, j]));
  const main = document.getElementById("prosa");
  main.replaceChildren();
  for (const u of review.units) {
    if (kept.get(u.id)) {
      const span = document.createElement("span");
      span.className = "u";
      span.append(u.text + " ");
      const x = document.createElement("span");
      x.className = "x"; x.textContent = "✕"; x.title = "tirar este trecho";
      x.onclick = () => { kept.set(u.id, false); render(); schedule(); };
      span.append(x);
      main.append(span);
      const join = joinsBy.get(u.id);
      if (join?.flags?.length) main.append(joinNode(join));
    } else {
      const mark = document.createElement("span");
      mark.className = "gone";
      mark.textContent = u.text;      // o CSS trunca; o título mostra inteiro
      mark.title = `restaurar: ${u.text}`;
      mark.onclick = () => { kept.set(u.id, true); render(); schedule(); };
      main.append(mark);
    }
  }
  document.getElementById("stage").textContent =
    `${review.units.filter((u) => kept.get(u.id)).length}/${review.units.length} trechos · ` +
    `${review.outputSeconds.toFixed(0)}s de ${review.sourceSeconds.toFixed(0)}s`;
}

function joinNode(join) {
  const box = document.createElement("span");
  box.className = "join";
  for (const f of join.flags) {
    const el = document.createElement("span");
    el.className = "flag";
    el.textContent = `⚠ ${f.message}`;
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = ` → ${f.hint}`;
    el.append(hint);
    box.append(el);
  }
  return box;
}

// Clique não re-planeja: 250ms depois do último, o servidor recalcula as
// junções. Sem isso, um aviso de mid_thought_out apontaria para uma junção
// que não existe mais.
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const r = await api("/keep", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepList: keepList() }),
    });
    if (r.review) { review = r.review; render(); }
  }, 250);
}

async function poll() {
  const j = await api("");
  document.getElementById("stage").textContent = {
    queued: "na fila…", transcribing: "transcrevendo (leva alguns minutos)…",
    indexing: "medindo…", planning: "planejando…", cancelled: "cancelado",
  }[j.stage] ?? j.stage;
  if (j.stage === "error") { document.getElementById("stage").textContent = "erro: " + j.error; return; }
  if (j.stage === "ready" && j.review) {
    review = j.review;
    kept = new Map(review.units.map((u) => [u.id, u.kept]));
    render();
    return;
  }
  if (j.stage !== "cancelled") setTimeout(poll, 1000);
}

document.getElementById("triar").onclick = async () => {
  const r = await api("/triage", { method: "POST" });
  if (r.error) { alert(r.error); return; }
  // Prévia, não aplicação muda: mostra o que cairia antes de mexer na tela.
  const proposto = new Set(expand(r.keepList));
  const cairiam = review.units.filter((u) => kept.get(u.id) && !proposto.has(u.id));
  const ok = confirm(
    `A sugestão tira ${cairiam.length} trecho(s):\n\n` +
    cairiam.map((u) => "· " + u.text.slice(0, 60)).join("\n") +
    "\n\nAplicar?",
  );
  if (!ok) return;
  for (const u of review.units) kept.set(u.id, proposto.has(u.id));
  render(); schedule();
};

function expand(list) {
  // A largura do zero-padding vem do próprio id recebido, não de um 3 fixo.
  const ids = [];
  for (const part of list.trim().split(/\s+/).filter(Boolean)) {
    const [a, b] = part.split("-");
    const width = a.length - 1;
    const from = Number(a.slice(1)), to = b ? Number(b.slice(1)) : from;
    for (let n = from; n <= to; n += 1) ids.push("u" + String(n).padStart(width, "0"));
  }
  return ids;
}

for (const [id, kind] of [["edl", "edl"], ["mp4", "mp4"], ["txt", "transcript"]]) {
  document.getElementById(id).onclick = async () => {
    const r = await api("/export", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, keepList: keepList() }),
    });
    if (r.error) { alert(r.error); return; }
    location.href = r.downloadUrl;
  };
}

poll();
</script>
</body>
</html>
```

- [ ] **Step 2: Injetar o id do job na página**

Em `apps/cli/src/app/server.ts`, na rota `/`, trocar `res.end(page)` por:

```ts
res.end(page.replace("window.__JOB__", JSON.stringify(job.id)));
```

- [ ] **Step 3: Registrar o comando**

Em `apps/cli/src/index.ts`, adicionar ao `USAGE`:

```
  decupa limpar --input <vídeo> [--port 7788] [--provider gemini|zai]
      Abre a tela de limpeza no navegador: lê o corte como prosa, desliga o
      que não quer, exporta MP4, EDL ou transcrição.
```

E o bloco de comando:

```ts
  if (command === "limpar") {
    const { values } = parseArgs({
      args: rest,
      options: {
        input: { type: "string" },
        port: { type: "string" },
        provider: { type: "string" },
      },
    });
    if (!values.input) {
      console.error("limpar precisa de --input");
      return 1;
    }
    const { startApp } = await import("./app/server.ts");
    const app = await startApp({
      input: values.input,
      port: values.port ? Number(values.port) : undefined,
      provider: values.provider,
    });
    const url = `http://127.0.0.1:${app.port}`;
    console.log(`tela de limpeza aberta em ${url}`);
    console.log("Ctrl+C para encerrar");
    // Abre o navegador; falhar aqui não é motivo para derrubar o servidor.
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    await new Promise(() => {});  // fica de pé até Ctrl+C
    return 0;
  }
```

Adicionar no topo de `apps/cli/src/index.ts`:

```ts
import { spawn } from "node:child_process";
```

- [ ] **Step 4: Verificar que compila e que a suíte passa**

Run: `pnpm typecheck && pnpm test`
Expected: tudo verde, incluindo os testes que já existiam.

- [ ] **Step 5: Rodar de verdade**

```bash
pnpm decupa limpar --input work/ritmo/proxy.mp4
```

Confirmar, olhando a tela: a prosa aparece; clicar no ✕ colapsa o trecho e o
texto se fecha; o marcador mostra o texto no hover e restaura ao clicar; o
contador de segundos muda; um aviso de junção aparece entre as palavras dos
dois lados. Exportar EDL e abrir o arquivo — os timecodes devem começar em
`00:00:00:00` e encadear sem buraco.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/page.html apps/cli/src/app/server.ts apps/cli/src/index.ts
git commit -m "feat(app): página de revisão e comando decupa limpar"
```

---

## Auto-revisão do plano

**Cobertura do spec:**

| Requisito do spec | Task |
|---|---|
| EDL CMX3600, fps inteiro, non-drop-frame, um canal | 1 |
| `Review` com units dropadas, flags como objeto, tail/head | 2 |
| Estado do job, terminal irreversível | 3 |
| Pipeline invoca o motor, `--drop-fillers hard` | 4 |
| `CLAUDE_PROJECT_DIR` por job | 4 |
| Proxy de triagem a `fps=1,scale=270:480` | 4 |
| Rotas de job/keep/triagem/export/download/cancel | 5 |
| `keepList` como string, recusa array | 5 |
| Bind em `127.0.0.1` | 5 |
| Export sempre re-planeja | 5 |
| Prosa corrida, unidade colapsa, marcador com texto | 6 |
| Debounce de 250 ms | 6 |
| Triagem como prévia com confirmação | 6 |
| Avisos de junção entre as palavras dos dois lados | 6 |
| Entrada por `--input`, sem file picker | 6 |
| Download em vez de path na tela | 5, 6 |

**Consistência de tipos:** `Review`/`ReviewJoin`/`ReviewFlag` são definidos na
Task 2 e consumidos como tal nas 3, 5 e 6. `PipelineJob` (Task 4) é um
subconjunto de `Job` (Task 3) de propósito — o pipeline não precisa de estágio
nem de review, e depender só do que usa mantém as duas testáveis em separado.
`Executor`/`ExecCall`/`FakeExecutor` vivem na Task 4 e são injetados na 5.

**Lacunas conhecidas, deliberadas:**

- `spawn("open", ...)` é de macOS. O repo já é macOS-only na prática
  (`services/speech`, ffmpeg via Homebrew); se rodar noutro sistema, a falha é
  o navegador não abrir, e a URL fica impressa no terminal de qualquer forma.
- O `fps` do EDL é enviado pela página com default 30 e não é lido do arquivo.
  Ler via `ffprobe` no export é uma linha a mais na Task 5, mas exige o
  binário e um teste com arquivo real — fica para quando houver material com
  fps diferente de 30 para verificar contra.
- `runRender` não reporta progresso. Render de vídeo longo fica com a tela
  parada. O `condense_qc` está fora do v1 pelo mesmo motivo que o progresso de
  render: são do caminho do MP4, e o caminho principal é o EDL.
