# Features de produto — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O bloco "produto utilizável por outra pessoa" da revisão ICE de 2026-09-09: `decupa doctor` (diagnóstico de ambiente num comando), export de legendas SRT do corte final, e telemetria editorial (o que a triagem cortou e por quê, na tela).

**Architecture:** Três features independentes, cada uma fecha com software funcionando. Doctor é um módulo puro + comando CLI que reutiliza as checagens que o `preflight` já faz. SRT é composição de dados que já existem (clipes do plano + palavras do WhisperX) remarcada na timeline de saída — sem re-transcrever nada. Telemetria é uma função pura sobre o `triage.json` + índice, renderizada na prévia da triagem.

**Tech Stack:** TypeScript ESM rodado com `node --experimental-strip-types`, vitest 4, pnpm workspaces, página sem build step (vanilla JS servida como string).

**Spec:** [docs/superpowers/specs/2026-09-04-app-limpeza-design.md](../specs/2026-09-04-app-limpeza-design.md) (o app de limpeza e sua forma de export), docs/skills/limpar-fala/SKILL.md (pré-requisitos que o doctor valida), e a revisão ICE GLM-only de 2026-09-09 para a priorização.

## Global Constraints

- **Node >= 22** (`package.json:engines`). O CLI roda com `--experimental-strip-types`, que é *strip-only*: nada de `enum`, `namespace`, decorator ou parameter property. A guarda é [apps/cli/src/strip-types.test.ts](../../../apps/cli/src/strip-types.test.ts) e ela **tem** que continuar passando.
- **pnpm 10.32.1** (`packageManager`). Nada de `npm install`.
- **Comentários, mensagens de erro e texto de tela em português**, como o resto do repo. Comentário explica *por quê*, não *o quê*.
- **Testes ao lado do fonte** como `<módulo>.test.ts`, rodados com `pnpm test`. Arquivo único: `pnpm vitest run <caminho>`.
- **Nenhuma etapa falha em silêncio devolvendo resultado vazio.**
- **O modelo nunca emite tempo.** Nenhuma feature nova recebe tempo de modelo; SRT remapeia tempo do WhisperX, que é medição.
- **A tela de leitura continua sendo de leitura.** A telemetria entra como uma linha de contexto na prévia da triagem, não como dashboard.
- **Doctor não tem efeito colateral**: não baixa nada, não chama rede, não escreve em disco. Só lê e reporta.
- **Não mexer no comportamento do corte.** `mechanical.gold.test.ts` continua verde.
- **Um commit por tarefa**, conventional commits com escopo. Commit feito por agente leva o trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Rodar `pnpm test` e `pnpm typecheck` antes de cada commit.**

## Origem

Revisão ICE de 2026-09-09 (cenário GLM-only). Os três itens de maior ICE do lado de features:

| # | Feature | ICE | Por quê agora |
|---|---------|-----|----------------|
| 1 | `decupa doctor` | 31,5 | Onboarding e skill listam pré-requisitos em prosa; o preflight já valida quase tudo, mas só dentro do `limpar`. |
| 2 | Export SRT do corte | 21 | Tempo por palavra (WhisperX) + clipes do plano já existem; composição pura. Maior valor por linha para quem publica. |
| 3 | Telemetria editorial | 20 | `triage.json` já carrega drop com reason; falta somar e mostrar. |

Backlog registrado (fora deste plano, cada um pede spec própria): slider de densidade no app (ICE 16), ouvir o corte inteiro antes de renderizar (ICE 16), `decupa lote` (ICE 12 — vira pré-requisito real o medidor de uso do plano de blindagem), léxico EN/ES (ICE 9), FCPXML/OTIO (ICE 9), diariação (ICE 5,8).

## Estrutura de arquivos

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `apps/cli/src/doctor.ts` | Checagens de ambiente como dados; renderização em texto. | 1 |
| `apps/cli/src/app/srt.ts` | Legendas do corte: seleção de palavras por clipe e remarcação na timeline de saída. Puro. | 2 |
| `apps/cli/src/app/stats.ts` | Estatísticas editoriais do drop da triagem. Puro. | 3 |
| `apps/cli/src/index.ts` | Comando `doctor`. | 1 |
| `apps/cli/src/app/server.ts` | Export `srt` + `stats` na resposta do POST de triagem. | 2, 3 |
| `apps/cli/src/app/page.html` | Linha de telemetria na prévia da triagem. | 3 |

---

### Task 1: `decupa doctor`

O SKILL `limpar-fala` lista pré-requisitos em prosa para o agente descobrir sozinho; a armadilha do endpoint Coding Plan (assinante recebendo `1113 — Insufficient balance` no caminho pay-as-you-go) está documentada só em comentário de código. Um comando que valida tudo e exita 1 com instruções de conserto destrava onboarding.

**Files:**
- Create: `apps/cli/src/doctor.ts`
- Test: `apps/cli/src/doctor.test.ts`
- Modify: `apps/cli/src/index.ts` (comando + linha de uso)
- Modify: `apps/cli/src/app/pipeline.ts` (exportar `SPEECH_SCRIPT`)

**Interfaces:**
- Consumes: `SpawnExecutor`, `DEFAULT_ENGINE`, `enginePatchError` de `apps/cli/src/app/pipeline.ts`.
- Produces: `runDoctor(deps?): Promise<DoctorLine[]>`; `renderDoctor(lines): string`; `DoctorLine { ok, name, detail, fix? }`.

- [ ] **Step 1: Escrever os testes que falham**

Criar `apps/cli/src/doctor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderDoctor, runDoctor } from "./doctor.ts";

/** Executor falso: binário conhecido existe (código 0), o resto não. */
const fakeRun = async (command: string, _args: string[]): Promise<{ code: number }> =>
  ({ code: ["ffmpeg", "ffprobe", "uv"].includes(command) ? 0 : 1 });

describe("runDoctor", () => {
  it("tudo presente dá linha verde inteira", async () => {
    const lines = await runDoctor({
      run: fakeRun,
      env: { ZAI_API_KEY: "k" },
      // sem engine/deps extras: os paths apontam pro repo de verdade, onde
      // script, motor e patch existem
    });
    expect(lines.every((l) => l.ok)).toBe(true);
  });

  it("binário ausente vira linha vermelha com conserto", async () => {
    const lines = await runDoctor({
      run: fakeRun,
      env: {},
    });
    const ffmpeg = lines.find((l) => l.name === "ffmpeg")!;
    expect(ffmpeg.ok).toBe(false);
    expect(ffmpeg.fix).toMatch(/brew install ffmpeg/);
  });

  it("sem ZAI_API_KEY, nomeia a variável", async () => {
    const lines = await runDoctor({ run: fakeRun, env: {} });
    const chave = lines.find((l) => l.name === "ZAI_API_KEY")!;
    expect(chave.ok).toBe(false);
    expect(chave.fix).toMatch(/ZAI_API_KEY/);
  });

  it("endpoint default vira nota sobre a armadilha 1113", async () => {
    const lines = await runDoctor({ run: fakeRun, env: { ZAI_API_KEY: "k" } });
    const endpoint = lines.find((l) => l.name === "ZAI_BASE_URL")!;
    expect(endpoint.ok).toBe(true);
    expect(endpoint.detail).toMatch(/coding/);
    expect(endpoint.detail).toMatch(/1113/);
  });
});

describe("renderDoctor", () => {
  it("marca OK/ERR e traz o conserto", () => {
    const out = renderDoctor([
      { ok: true, name: "node", detail: "22.9.0" },
      { ok: false, name: "ffmpeg", detail: "fora do PATH", fix: "brew install ffmpeg" },
    ]);
    expect(out).toContain("OK node — 22.9.0");
    expect(out).toContain("ERR ffmpeg — fora do PATH (brew install ffmpeg)");
  });
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `pnpm vitest run apps/cli/src/doctor.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar doctor.ts**

Em `apps/cli/src/app/pipeline.ts`, a constante privada `SPEECH_SCRIPT` passa a `export const SPEECH_SCRIPT` (mesmo padrão de `DEFAULT_ENGINE`; sem mudar o valor).

Criar `apps/cli/src/doctor.ts`:

```ts
import { access } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_ENGINE, enginePatchError, SPEECH_SCRIPT, SpawnExecutor } from "./app/pipeline.ts";

export interface DoctorLine {
  ok: boolean;
  name: string;
  detail: string;
  /** O que fazer quando não passa. */
  fix?: string;
}

export interface DoctorDeps {
  /** Injetável: testes não dependem do PATH da máquina. */
  run?: (command: string, args: string[]) => Promise<{ code: number }>;
  env?: Record<string, string | undefined>;
  engine?: string;
}

/**
 * Diagnóstico sem efeito colateral: não baixa, não chama rede, não escreve.
 * As checagens são as mesmas do preflight do app — a diferença é que o doctor
 * reporta tudo de uma vez, em vez de estourar na primeira que falta.
 */
export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorLine[]> {
  const run = deps.run
    ?? (async (command: string, args: string[]) => new SpawnExecutor().run({ command, args }));
  const env = deps.env ?? process.env;
  const engine = deps.engine ?? env.VE_PLUGIN_ROOT ?? DEFAULT_ENGINE;
  const lines: DoctorLine[] = [];

  const major = Number(process.versions.node.split(".")[0]);
  lines.push(major >= 22
    ? { ok: true, name: "node", detail: process.versions.node }
    : { ok: false, name: "node", detail: process.versions.node, fix: "o decupa precisa de Node >= 22" });

  for (const bin of ["ffmpeg", "ffprobe"]) {
    const { code } = await run(bin, ["-version"]);
    lines.push(code === 0
      ? { ok: true, name: bin, detail: "no PATH" }
      : { ok: false, name: bin, detail: "fora do PATH", fix: "brew install ffmpeg" });
  }

  const uv = await run("uv", ["--version"]);
  const hasSpeech = await access(SPEECH_SCRIPT).then(() => true, () => false);
  lines.push(uv.code === 0 && hasSpeech
    ? { ok: true, name: "sidecar de fala", detail: "uv + services/speech" }
    : {
        ok: false, name: "sidecar de fala",
        detail: uv.code === 0 ? "transcribe.py não encontrado" : "uv fora do PATH",
        fix: "veja services/speech/README.md",
      });

  const hasEngine = await access(join(engine, "mcp", "ve_tools", "condense.py"))
    .then(() => true, () => false);
  lines.push(hasEngine
    ? { ok: true, name: "motor de condense", detail: engine }
    : {
        ok: false, name: "motor de condense", detail: `não achei em ${engine}`,
        fix: "bash scripts/setup-engine.sh (ou aponte VE_PLUGIN_ROOT)",
      });

  if (hasEngine) {
    const patchError = await enginePatchError(engine);
    lines.push(patchError === null
      ? { ok: true, name: "patch PT-BR do motor", detail: "aplicado" }
      : { ok: false, name: "patch PT-BR do motor", detail: patchError, fix: "bash scripts/setup-engine.sh" });
  }

  lines.push(env.ZAI_API_KEY
    ? { ok: true, name: "ZAI_API_KEY", detail: "setada" }
    : {
        ok: false, name: "ZAI_API_KEY", detail: "não setada",
        fix: "sem ela a triagem não roda — monte o keep-list na mão (SKILL) ou exporte a chave",
      });

  // Reportar, não testar: chamada de rede em doctor quebraria a promessa de
  // efeito colateral zero. O que dá sem rede é avisar qual endpoint seria
  // usado — a armadilha 1113 é erro de endereço que parece erro de conta.
  const base = env.ZAI_BASE_URL ?? "https://api.z.ai/api/coding/paas/v4 (default)";
  lines.push({
    ok: true,
    name: "ZAI_BASE_URL",
    detail: base.includes("coding")
      ? `${base} — assinatura Coding Plan; o endpoint paas cobrado devolve 1113 e parece conta vazia`
      : base,
  });

  return lines;
}

export function renderDoctor(lines: DoctorLine[]): string {
  return lines
    .map((l) => `${l.ok ? "OK " : "ERR"} ${l.name} — ${l.detail}${l.ok || !l.fix ? "" : ` (${l.fix})`}`)
    .join("\n");
}
```

- [ ] **Step 4: Registrar o comando**

Em `apps/cli/src/index.ts`, na lista de uso do topo, adicionar a linha:

```
  decupa doctor — checa o ambiente (binários, sidecars, motor, patch, chave) e diz o que consertar
```

E o bloco de comando, junto dos outros `if (command === ...)`:

```ts
  if (command === "doctor") {
    const { runDoctor, renderDoctor } = await import("./doctor.ts");
    const lines = await runDoctor();
    console.log(renderDoctor(lines));
    return lines.every((l) => l.ok) ? 0 : 1;
  }
```

- [ ] **Step 5: Rodar testes e typecheck**

Run: `pnpm vitest run apps/cli/src/doctor.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Verificação manual (uma vez, na máquina real)**

Run: `pnpm decupa doctor`
Expected: todas as linhas OK na máquina do repo; experimentar também `env -u ZAI_API_KEY pnpm decupa doctor` → exit 1 com a linha da chave em ERR.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/doctor.ts apps/cli/src/doctor.test.ts apps/cli/src/index.ts apps/cli/src/app/pipeline.ts
git commit -m "feat(cli): decupa doctor diagnostica o ambiente num comando

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Export de legendas SRT do corte

O pipeline já tem tempo por palavra (WhisperX, `transcript.json`) e os clipes do corte (`condense_plan.json`). A legenda é composição: para cada clipe, as palavras que caem dentro, remarcadas na timeline de saída. Sem re-transcrever, sem nova etapa de minutos.

**Files:**
- Create: `apps/cli/src/app/srt.ts`
- Test: `apps/cli/src/app/srt.test.ts`
- Modify: `apps/cli/src/app/server.ts` (kind `srt` no export + entrada no download)

**Interfaces:**
- Consumes: `plan.clips` (mesmo shape que `buildEdl` consome: `{ start: number; end: number }` em segundos); `transcript.json` do WhisperX (`tokens` com `text/startMs/endMs`).
- Produces: `srtTimestamp(totalMs: number): string`; `buildSrt(opts: { clips: SrtClip[]; words: SrtWord[]; maxChars?; maxMs?; gapMs? }): string`; tipos `SrtWord`, `SrtClip`.

- [ ] **Step 1: Escrever os testes que falham**

Criar `apps/cli/src/app/srt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSrt, srtTimestamp, type SrtWord } from "./srt.ts";

const w = (text: string, startMs: number, endMs: number): SrtWord => ({ text, startMs, endMs });

describe("srtTimestamp", () => {
  it("formata HH:MM:SS,mmm com vírgula decimal", () => {
    expect(srtTimestamp(0)).toBe("00:00:00,000");
    expect(srtTimestamp(3_723_509)).toBe("01:02:03,509");
  });
});

describe("buildSrt", () => {
  const words = [
    w("o", 0, 100), w("corte", 100, 400), w("é", 500, 600),
    w("a", 3_000, 3_100), w("prosa", 3_100, 3_600),
  ];

  it("remapeia as palavras na timeline de saída, pulando o que saiu", () => {
    // Clipe 1: 0–1s da fonte. Clipe 2: 3–4s. O vão de 1–3s foi cortado —
    // na saída, "a prosa" começa em 1.000ms, não em 3.000ms.
    const srt = buildSrt({ clips: [{ start: 0, end: 1 }, { start: 3, end: 4 }], words });
    expect(srt).toContain("00:00:00,000 --> 00:00:00,600");
    expect(srt).toContain("o corte é");
    expect(srt).toContain("00:00:01,000 --> 00:00:01,600");
    expect(srt).toContain("a prosa");
  });

  it("quebra cue em pausa longa entre palavras do mesmo clipe", () => {
    const gap = [w("antes", 0, 300), w("depois", 2_000, 2_400)];
    const srt = buildSrt({ clips: [{ start: 0, end: 3 }], words: gap });
    expect(srt).toContain("antes");
    expect(srt).toContain("depois");
    // duas cues, não uma só atravessando o silêncio
    expect(srt.match(/-->/g)).toHaveLength(2);
  });

  it("respeita o teto de caracteres", () => {
    const longas = Array.from({ length: 10 }, (_, i) => w("palavramuito" + i, i * 400, i * 400 + 300));
    const srt = buildSrt({ clips: [{ start: 0, end: 10 }], words: longas, maxChars: 30 });
    for (const bloco of srt.split("\n\n")) {
      const texto = bloco.split("\n").slice(2).join(" ");
      expect(texto.length).toBeLessThanOrEqual(30);
    }
  });

  it("estoura quando não há clipe nenhum", () => {
    expect(() => buildSrt({ clips: [], words })).toThrow(/nenhum clipe/);
  });

  it("estoura quando nenhuma palavra cai nos clipes", () => {
    expect(() => buildSrt({ clips: [{ start: 10, end: 11 }], words })).toThrow(/nenhuma palavra/);
  });
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `pnpm vitest run apps/cli/src/app/srt.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar srt.ts**

```ts
export interface SrtWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface SrtClip {
  /** segundos na fonte */
  start: number;
  end: number;
}

/** ms → `HH:MM:SS,mmm`, o formato SRT (vírgula decimal, não ponto). */
export function srtTimestamp(totalMs: number): string {
  const ms = Math.max(0, Math.round(totalMs));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1_000) % 60;
  const rest = ms % 1_000;
  const pad = (n: number, size = 2): string => String(n).padStart(size, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rest, 3)}`;
}

/**
 * Legendas do corte: para cada clipe do plano, as palavras do WhisperX que
 * caem dentro, remarcadas na timeline de saída. O corte remove tempo entre
 * clipes — a legenda tem que sofrer o mesmo deslocamento, senão dessincroniza
 * exatamente nos pontos onde cortou.
 */
export function buildSrt(opts: {
  clips: SrtClip[];
  words: SrtWord[];
  maxChars?: number;
  maxMs?: number;
  gapMs?: number;
}): string {
  const { clips, words } = opts;
  if (clips.length === 0) throw new Error("nenhum clipe para exportar");
  const maxChars = opts.maxChars ?? 42;
  const maxMs = opts.maxMs ?? 5_000;
  const gapMs = opts.gapMs ?? 700;

  const cues: { startMs: number; endMs: number; text: string }[] = [];
  let at = 0; // cursor da timeline de saída, em ms

  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    const clipStartMs = Math.round(clip.start * 1_000);
    const clipEndMs = Math.round(clip.end * 1_000);
    const inClip = words.filter((word) => word.startMs >= clipStartMs && word.startMs < clipEndMs);

    let cue: SrtWord[] = [];
    let cueChars = 0;
    const flush = (): void => {
      if (cue.length === 0) return;
      cues.push({
        startMs: at + cue[0]!.startMs - clipStartMs,
        endMs: at + cue[cue.length - 1]!.endMs - clipStartMs,
        text: cue.map((word) => word.text).join(" "),
      });
      cue = [];
      cueChars = 0;
    };

    for (const word of inClip) {
      if (cue.length > 0) {
        const gap = word.startMs - cue[cue.length - 1]!.endMs;
        const dur = cue[cue.length - 1]!.endMs - cue[0]!.startMs;
        // Quebra nos mesmos sinais que um leitor percebe: pausa comprida,
        // cue longa demais, linha que não cabe.
        if (gap > gapMs || dur > maxMs || cueChars + word.text.length + 1 > maxChars) flush();
      }
      cue.push(word);
      cueChars += word.text.length + 1;
    }
    flush();
    at += clipEndMs - clipStartMs;
  }

  if (cues.length === 0) {
    throw new Error("nenhuma palavra do transcript cai dentro dos clipes do plano");
  }
  return cues
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.startMs)} --> ${srtTimestamp(c.endMs)}\n${c.text}\n`)
    .join("\n");
}
```

- [ ] **Step 4: Registrar os testes passando**

Run: `pnpm vitest run apps/cli/src/app/srt.test.ts`
Expected: PASS

- [ ] **Step 5: Ligar no export do app**

Em `apps/cli/src/app/server.ts`:

Import novo: `import { buildSrt, type SrtWord } from "./srt.ts";` e acrescentar `transcriptPath` à lista já importada de `./pipeline.ts`.

Dentro do handler `export`, depois do bloco `kind === "edl"`:

```ts
          if (kind === "srt") {
            // Palavras do WhisperX + clipes do plano, remarcadas na saída.
            // O transcript é cache do workDir — não há etapa nova de minutos.
            const transcript = await readJson(transcriptPath(pipelineJob)) as {
              tokens?: { text?: unknown; startMs?: unknown; endMs?: unknown }[];
            };
            const words = (transcript.tokens ?? []).filter(
              (t): t is SrtWord => typeof t.text === "string"
                && typeof t.startMs === "number" && typeof t.endMs === "number",
            );
            const out = join(workDir, "corte.srt");
            await writeFile(out, buildSrt({ clips: plan.clips, words }), "utf8");
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/srt` });
            return;
          }
```

No mapa `files` do handler `download`, acrescentar:

```ts
            srt: join(workDir, "corte.srt"),
```

(`plan` já vem de `readJson(planPath(...))` no início do handler de export — o mesmo objeto que o EDL consome.)

- [ ] **Step 6: Suíte inteira e typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/app/srt.ts apps/cli/src/app/srt.test.ts apps/cli/src/app/server.ts
git commit -m "feat(app): export de legendas SRT do corte

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Telemetria editorial na prévia da triagem

O `triage.json` carrega o drop com reason por unidade e o índice tem a duração de cada uma — só falta somar. A linha entra na prévia da triagem: quem lê a prosa decide com "corta 3m12s de 12m40s · 14/42 unidades · mais: retake (1m20s)" na cabeça, não às cegas.

**Files:**
- Create: `apps/cli/src/app/stats.ts`
- Test: `apps/cli/src/app/stats.test.ts`
- Modify: `apps/cli/src/app/server.ts` (POST de triagem devolve `stats`)
- Modify: `apps/cli/src/app/page.html` (linha na prévia)

**Interfaces:**
- Consumes: `triage.json` (`drop: { unit_ids, reason }[]`) e `speech_index.json` (`units: { id, start, end }[]`) — ambos já lidos pelo server.
- Produces: `editorialStats(units, drop): EditorialStats`; `EditorialStats { sourceSeconds, outputSeconds, removedSeconds, unitsTotal, unitsRemoved, byReason, summary }`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/cli/src/app/stats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { editorialStats } from "./stats.ts";

const units = [
  { id: "u001", start: 0, end: 10 },
  { id: "u002", start: 10, end: 25 },
  { id: "u003", start: 25, end: 30 },
  { id: "u004", start: 30, end: 42 },
];

describe("editorialStats", () => {
  it("soma duração, unidades e agrupa por motivo", () => {
    const stats = editorialStats(units, [
      { unit_ids: ["u001"], reason: "preroll" },
      { unit_ids: ["u003", "u004"], reason: "retake" },
    ]);
    expect(stats.sourceSeconds).toBe(42);
    expect(stats.removedSeconds).toBe(27);
    expect(stats.outputSeconds).toBe(15);
    expect(stats.unitsRemoved).toBe(3);
    expect(stats.byReason[0]).toMatchObject({ reason: "retake", units: 2, seconds: 17 });
  });

  it("não conta duas vezes unidade dropada por duas alegações aceitas", () => {
    const stats = editorialStats(units, [
      { unit_ids: ["u001"], reason: "preroll" },
      { unit_ids: ["u001"], reason: "dead_air" },
    ]);
    expect(stats.unitsRemoved).toBe(1);
    expect(stats.removedSeconds).toBe(10);
  });

  it("resumo nomeia os números e o maior motivo", () => {
    const stats = editorialStats(units, [{ unit_ids: ["u003", "u004"], reason: "retake" }]);
    expect(stats.summary).toContain("0m17s");
    expect(stats.summary).toContain("0m42s");
    expect(stats.summary).toContain("retake");
  });

  it("sem drop, resumo honesto de nada cortado", () => {
    const stats = editorialStats(units, []);
    expect(stats.removedSeconds).toBe(0);
    expect(stats.unitsRemoved).toBe(0);
    expect(stats.summary).not.toContain("mais:");
  });
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `pnpm vitest run apps/cli/src/app/stats.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar stats.ts**

```ts
export interface StatsUnit {
  id: string;
  start: number;
  end: number;
}

export interface StatsDrop {
  unit_ids: string[];
  reason: string;
}

export interface EditorialStats {
  sourceSeconds: number;
  outputSeconds: number;
  removedSeconds: number;
  unitsTotal: number;
  unitsRemoved: number;
  byReason: { reason: string; units: number; seconds: number }[];
  summary: string;
}

function mmss(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * O que a triagem sugeriu cortar, somado. Descreve a sugestão — não o corte
 * final, que é a pessoa lendo a prosa quem faz. O resumo é uma linha porque a
 * tela é de leitura: número dá contexto, dashboard rouba o foco.
 */
export function editorialStats(units: StatsUnit[], drop: StatsDrop[]): EditorialStats {
  const dur = new Map(units.map((u) => [u.id, Math.max(0, u.end - u.start)] as const));
  const removedIds = new Set(drop.flatMap((d) => d.unit_ids));

  const byReason = new Map<string, { reason: string; units: number; seconds: number }>();
  for (const d of drop) {
    const cur = byReason.get(d.reason) ?? { reason: d.reason, units: 0, seconds: 0 };
    cur.units += d.unit_ids.length;
    cur.seconds += d.unit_ids.reduce((n, id) => n + (dur.get(id) ?? 0), 0);
    byReason.set(d.reason, cur);
  }
  const ranked = [...byReason.values()].sort((a, b) => b.seconds - a.seconds);

  const sourceSeconds = units.reduce((n, u) => n + (dur.get(u.id) ?? 0), 0);
  const removedSeconds = [...removedIds].reduce((n, id) => n + (dur.get(id) ?? 0), 0);
  const summary = `corta ${mmss(removedSeconds)} de ${mmss(sourceSeconds)} · ` +
    `${removedIds.size}/${units.length} unidades` +
    (ranked[0] ? ` · mais: ${ranked[0].reason} (${mmss(ranked[0].seconds)})` : "");

  return {
    sourceSeconds,
    outputSeconds: sourceSeconds - removedSeconds,
    removedSeconds,
    unitsTotal: units.length,
    unitsRemoved: removedIds.size,
    byReason: ranked,
    summary,
  };
}
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `pnpm vitest run apps/cli/src/app/stats.test.ts`
Expected: PASS

- [ ] **Step 5: Ligar no server e na página**

Em `apps/cli/src/app/server.ts`: importar `editorialStats` de `./stats.ts` (o `indexPath` já vem importado de `./pipeline.ts` na lista atual). No handler `POST .../triage`, o `try` que hoje lê `triage.json` passa a computar stats no mesmo lugar onde `drop` já é lido:

```ts
          let drop: unknown[] | undefined;
          let reviewFlags: unknown[] | undefined;
          let stats: ReturnType<typeof editorialStats> | undefined;
          try {
            const json = await readJson(join(workDir, "out", "triage.json")) as {
              drop?: { unit_ids: string[]; reason: string }[];
              reviewFlags?: unknown[];
            };
            drop = json.drop;
            reviewFlags = json.reviewFlags;
            const index = await readJson(indexPath(pipelineJob)) as { units?: { id: string; start: number; end: number }[] };
            stats = editorialStats(index.units ?? [], json.drop ?? []);
          } catch {
            // triage.json é novo; fallback no markdown.
          }
```

E a resposta ganha `stats`:

```ts
          sendJson(res, {
            keepList: suggested,
            motivos: motivosFromReport(report),
            drop,
            reviewFlags,
            stats,
            report,
          });
```

Em `apps/cli/src/app/page.html`: dentro do `<aside id="triage" hidden>`, logo depois de `<h2>prévia da triagem</h2>`, adicionar:

```html
  <p id="triage-stats" class="lbl"></p>
```

No handler que consome a resposta do `/triage` (por volta da linha 432, onde hoje são chamados `fillList(el("triage-drop"), drop)` e `fillList(el("triage-look"), look)`), adicionar antes de `el("triage").hidden = false;`:

```js
    el("triage-stats").textContent = r.stats ? r.stats.summary : "";
```

- [ ] **Step 6: Suíte inteira e typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Verificação manual (uma vez, na máquina real)**

Com um vídeo de teste e `ZAI_API_KEY` no ambiente: `pnpm decupa limpar --input <vídeo>`, pedir a prévia da triagem na página e conferir que a linha de telemetria aparece acima das listas de drop — e que os minutos batem com o que o relatório `out/triage.md` diz.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/app/stats.ts apps/cli/src/app/stats.test.ts apps/cli/src/app/server.ts apps/cli/src/app/page.html
git commit -m "feat(app): telemetria editorial na prévia da triagem

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Ordem sugerida entre os dois planos

Este plano e o de blindagem (`2026-09-09-blindagem-glm.md`) são independentes tarefa a tarefa, com uma exceção de sequência que vale registrar: **a telemetria (Task 3) melhora se a blindagem tiver passado antes** — o medidor de uso da API (Task 4 da blindagem) pode alimentar a mesma linha de contexto com consumo de tokens, e o `stats` do server fica mais interessante com `triage.json` já carregando `usage`. Nada quebra se a ordem for outra; só não conte os tokens duas vezes.
