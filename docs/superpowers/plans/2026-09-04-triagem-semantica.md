# Triagem semântica — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao pipeline de limpeza de fala uma camada que decide o que é conteúdo do vídeo e o que não é, produzindo o keep-list que hoje uma pessoa escreve na mão.

**Architecture:** Um pacote TypeScript novo (`packages/triage`) que lê `speech_index.json`, manda as unidades e o vídeo pro Gemini Flash, e **confere cada alegação do modelo contra o índice antes de aplicar**. O modelo emite IDs de unidade, nunca tempos — o código resolve ID → tempo pelo índice. Dois passes: estrutura (verificável por máquina) e densidade (só com alvo explícito, cai na revisão de prosa).

**Tech Stack:** TypeScript ESM (`--experimental-strip-types`), vitest, `@google/genai` v2.3.0+, pnpm workspaces.

**Spec:** [docs/superpowers/specs/2026-09-04-triagem-semantica-design.md](../specs/2026-09-04-triagem-semantica-design.md)

## Global Constraints

- **O modelo nunca emite tempo.** Só IDs de unidade (`u001`). Timestamps do Gemini são `MM:SS`, resolução de um segundo; um corte precisa de milissegundo. Qualquer campo de tempo vindo do modelo é bug.
- **Limiar de similaridade: `0.8`.** Constante nomeada `RESTATEMENT_THRESHOLD`, exportada e documentada.
- **`generation_config: { seed: 0 }`** em toda chamada ao modelo (reprodutibilidade na Interactions API).
- **Modelo default: `gemini-3.8-flash`**, sobrescrevível por `--model`. Modo `processing: "agentic"` no input de vídeo.
- **Alegação não verificada nunca é aplicada em silêncio.** Ou passa e entra no keep-list, ou é rejeitada e aparece no relatório com a condição que falhou.
- **Passe 2 (densidade) só roda com `--target`.** Sem alvo não há condição de parada.
- Pacotes seguem o padrão do repo: `@decupa/<nome>`, `private: true`, `type: "module"`, `main`/`exports` apontando pra `./src/index.ts`, tsconfig estendendo `../../tsconfig.base.json`.
- Testes colocados ao lado do fonte como `<módulo>.test.ts`, rodados com `pnpm test`.
- Comentários e mensagens ao usuário em português, como o resto do repo.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `packages/triage/src/similarity.ts` | Dice sobre bigramas de token. Puro. |
| `packages/triage/src/speech-index.ts` | Tipos do `speech_index.json` e leitura do subconjunto consumido. |
| `packages/triage/src/claims.ts` | As quatro regras de verificação e a ordem de avaliação em duas etapas. |
| `packages/triage/src/keeplist.ts` | Unidades sobreviventes → string de faixas. |
| `packages/triage/src/prompt.ts` | Monta o bloco de unidades mandado ao modelo. Puro. |
| `packages/triage/src/model.ts` | Interface `TriageModel` + fake de teste. |
| `packages/triage/src/gemini.ts` | Adaptador real do `@google/genai`. |
| `packages/triage/src/cache.ts` | Cache por hash de vídeo + índice + prompt + modelo + passe. |
| `packages/triage/src/density.ts` | Passe 2: aplica candidatos até fechar o orçamento. |
| `packages/triage/src/report.ts` | `out/triage.md`. |
| `packages/triage/src/index.ts` | Re-exports. |
| `apps/cli/src/triage.ts` | Fiação do comando. |
| `apps/cli/src/index.ts` | Registra o subcomando `triage`. |

---

## Task 1: Pacote e similaridade

**Files:**
- Create: `packages/triage/package.json`
- Create: `packages/triage/tsconfig.json`
- Create: `packages/triage/src/similarity.ts`
- Test: `packages/triage/src/similarity.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `similarity(a: string, b: string): number`, `RESTATEMENT_THRESHOLD: 0.8`.

- [ ] **Step 1: Criar o esqueleto do pacote**

`packages/triage/package.json`:

```json
{
  "name": "@decupa/triage",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@decupa/core": "workspace:*"
  }
}
```

`packages/triage/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 2: Escrever o teste que falha**

`packages/triage/src/similarity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RESTATEMENT_THRESHOLD, similarity } from "./similarity.ts";

describe("similarity", () => {
  it("dá 1 para texto idêntico", () => {
    expect(similarity("Isso não escala", "Isso não escala")).toBe(1);
  });

  it("ignora pontuação e caixa", () => {
    // o caso real: u032 vs u036 no material de 2026-09-04
    expect(similarity("Isso não escala", "isso não escala...")).toBe(1);
  });

  it("passa do limiar em retomada quase-verbatim", () => {
    // u026 vs u027, que o motor mediu em 0.881
    const s = similarity(
      "E quem contrata quer sentir o resultado.",
      "E quem contrata quer resultado.",
    );
    expect(s).toBeGreaterThanOrEqual(RESTATEMENT_THRESHOLD);
  });

  it("fica bem abaixo do limiar em frases de assuntos diferentes", () => {
    const s = similarity(
      "Isso não escala",
      "Dessa forma, não escala a comunicação e dilui muito o seu poder de conversão.",
    );
    expect(s).toBeLessThan(RESTATEMENT_THRESHOLD);
  });

  it("cai para Dice de token quando não há bigrama", () => {
    // uma palavra só não tem bigrama; sem o fallback isso seria 0
    expect(similarity("Entende?", "entende")).toBe(1);
    expect(similarity("Entende?", "escala")).toBe(0);
  });

  it("dá 0 quando um dos lados é vazio", () => {
    expect(similarity("", "Isso não escala")).toBe(0);
  });
});
```

- [ ] **Step 3: Rodar o teste e ver falhar**

Run: `pnpm vitest run packages/triage/src/similarity.test.ts`
Expected: FAIL — `Failed to resolve import "./similarity.ts"`

- [ ] **Step 4: Implementar**

`packages/triage/src/similarity.ts`:

```ts
/**
 * Similaridade de texto para detectar retomada quase-verbatim.
 *
 * O `condense_index` do motor também mede isso, mas só expõe o número como
 * prosa em inglês dentro de `trim_candidates[].reasons`
 * ("restates u032 (similarity 1.0)"). Depender daquilo acoplaria a verificação
 * à redação do motor, então medimos por conta própria.
 *
 * Coeficiente de Dice sobre bigramas de token: mais discriminante que
 * sobreposição de palavras soltas, que casaria "não escala" em duas frases
 * sobre assuntos diferentes.
 */

/** Acima disto, duas unidades contam como a mesma frase repetida. */
export const RESTATEMENT_THRESHOLD = 0.8;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function bigrams(list: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length - 1; i += 1) out.push(`${list[i]} ${list[i + 1]}`);
  return out;
}

/** Dice sobre multiconjuntos: 2·|A∩B| / (|A|+|B|). */
function dice(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const item of a) pool.set(item, (pool.get(item) ?? 0) + 1);
  let shared = 0;
  for (const item of b) {
    const left = pool.get(item) ?? 0;
    if (left > 0) {
      shared += 1;
      pool.set(item, left - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  // Uma palavra só não produz bigrama; sem este desvio toda interjeição
  // ("Entende?", "Ih, foi!") mediria 0 contra qualquer coisa.
  if (ta.length < 2 || tb.length < 2) return dice(ta, tb);
  return dice(bigrams(ta), bigrams(tb));
}
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `pnpm vitest run packages/triage/src/similarity.test.ts`
Expected: PASS, 6 testes.

- [ ] **Step 6: Commit**

```bash
git add packages/triage/package.json packages/triage/tsconfig.json packages/triage/src/similarity.ts packages/triage/src/similarity.test.ts
git commit -m "feat(triage): similaridade por Dice de bigrama para detectar retomada"
```

---

## Task 2: Tipos e leitura do índice

**Files:**
- Create: `packages/triage/src/speech-index.ts`
- Test: `packages/triage/src/speech-index.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `IndexUnit`, `TopicRun`, `SpeechIndex`, `parseSpeechIndex(raw: unknown): SpeechIndex`, `unitByIdOrThrow(index: SpeechIndex, id: string): IndexUnit`, `topicSpan(index: SpeechIndex): { first: number; last: number } | null`.

- [ ] **Step 1: Escrever o teste que falha**

`packages/triage/src/speech-index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseSpeechIndex, topicSpan, unitByIdOrThrow } from "./speech-index.ts";

const raw = {
  source_duration: 245.5,
  budget: { lossless_floor_seconds: 120.179 },
  topic_runs: [
    { keyword: "instituição", unit_ids: ["u006", "u008"] },
    { keyword: "você", unit_ids: ["u003", "u009"] },
  ],
  units: [
    { id: "u003", index: 2, start: 3, end: 4, duration: 1, text: "três", has_terminal_punct: true, is_question: false },
    { id: "u006", index: 5, start: 6, end: 7.5, duration: 1.5, text: "seis", has_terminal_punct: true, is_question: false },
    { id: "u008", index: 7, start: 8, end: 9, duration: 1, text: "oito", has_terminal_punct: false, is_question: false },
    { id: "u009", index: 8, start: 9.5, end: 10, duration: 0.5, text: "nove", has_terminal_punct: true, is_question: true },
  ],
};

describe("parseSpeechIndex", () => {
  it("lê unidades e topic_runs", () => {
    const index = parseSpeechIndex(raw);
    expect(index.units).toHaveLength(4);
    expect(index.topicRuns).toHaveLength(2);
    expect(index.losslessFloorSeconds).toBeCloseTo(120.179, 6);
  });

  it("ordena as unidades por index mesmo se vierem fora de ordem", () => {
    const shuffled = { ...raw, units: [raw.units[2], raw.units[0], raw.units[3], raw.units[1]] };
    expect(parseSpeechIndex(shuffled).units.map((u) => u.id))
      .toEqual(["u003", "u006", "u008", "u009"]);
  });

  it("recusa JSON sem units em vez de devolver índice vazio", () => {
    expect(() => parseSpeechIndex({ topic_runs: [] })).toThrow(/units/);
  });
});

describe("topicSpan", () => {
  it("devolve o menor e o maior index citados por qualquer topic_run", () => {
    // u003 (index 2) é o menor; u009 (index 8) é o maior
    expect(topicSpan(parseSpeechIndex(raw))).toEqual({ first: 2, last: 8 });
  });

  it("devolve null quando não há topic_run nenhum", () => {
    expect(topicSpan(parseSpeechIndex({ ...raw, topic_runs: [] }))).toBeNull();
  });
});

describe("unitByIdOrThrow", () => {
  it("acha a unidade", () => {
    expect(unitByIdOrThrow(parseSpeechIndex(raw), "u006").text).toBe("seis");
  });

  it("estoura com o id no texto do erro quando o modelo inventa um", () => {
    expect(() => unitByIdOrThrow(parseSpeechIndex(raw), "u999")).toThrow(/u999/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run packages/triage/src/speech-index.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`packages/triage/src/speech-index.ts`:

```ts
/**
 * O subconjunto do `speech_index.json` que a triagem consome.
 *
 * O arquivo do motor tem muito mais campo do que isto. Declarar só o que é
 * usado deixa explícito de que parte do contrato a triagem depende — e o resto
 * do índice pode mudar sem quebrar nada aqui.
 */

export interface IndexUnit {
  id: string;
  index: number;
  start: number;
  end: number;
  duration: number;
  text: string;
  hasTerminalPunct: boolean;
  isQuestion: boolean;
}

export interface TopicRun {
  keyword: string;
  unitIds: string[];
}

export interface SpeechIndex {
  units: IndexUnit[];
  topicRuns: TopicRun[];
  losslessFloorSeconds: number;
  sourceDurationSeconds: number;
}

export function parseSpeechIndex(raw: unknown): SpeechIndex {
  const root = raw as Record<string, unknown>;
  const rawUnits = root?.units;
  if (!Array.isArray(rawUnits) || rawUnits.length === 0) {
    throw new Error("speech_index.json sem `units` — rode `condense.py index` antes da triagem");
  }
  const units: IndexUnit[] = rawUnits
    .map((u: Record<string, unknown>) => ({
      id: String(u.id),
      index: Number(u.index),
      start: Number(u.start),
      end: Number(u.end),
      duration: Number(u.duration),
      text: String(u.text ?? ""),
      hasTerminalPunct: Boolean(u.has_terminal_punct),
      isQuestion: Boolean(u.is_question),
    }))
    .sort((a, b) => a.index - b.index);

  const rawRuns = Array.isArray(root.topic_runs) ? root.topic_runs : [];
  const topicRuns: TopicRun[] = rawRuns.map((r: Record<string, unknown>) => ({
    keyword: String(r.keyword),
    unitIds: (r.unit_ids as string[] | undefined ?? []).map(String),
  }));

  const budget = (root.budget ?? {}) as Record<string, unknown>;
  return {
    units,
    topicRuns,
    losslessFloorSeconds: Number(budget.lossless_floor_seconds ?? 0),
    sourceDurationSeconds: Number(root.source_duration ?? 0),
  };
}

export function unitByIdOrThrow(index: SpeechIndex, id: string): IndexUnit {
  const found = index.units.find((u) => u.id === id);
  if (!found) throw new Error(`unidade ${id} não existe no índice`);
  return found;
}

/**
 * Menor e maior `index` citados por qualquer topic_run — a extensão do corpo
 * do vídeo segundo a agregação por keyword que o motor já faz. Fora dessa
 * faixa é onde pré-rolo e pós-rolo podem estar.
 */
export function topicSpan(index: SpeechIndex): { first: number; last: number } | null {
  const indices: number[] = [];
  for (const run of index.topicRuns) {
    for (const id of run.unitIds) {
      const unit = index.units.find((u) => u.id === id);
      if (unit) indices.push(unit.index);
    }
  }
  if (indices.length === 0) return null;
  return { first: Math.min(...indices), last: Math.max(...indices) };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run packages/triage/src/speech-index.test.ts`
Expected: PASS, 7 testes.

- [ ] **Step 5: Commit**

```bash
git add packages/triage/src/speech-index.ts packages/triage/src/speech-index.test.ts
git commit -m "feat(triage): tipos e leitura do subconjunto consumido do speech_index"
```

---

## Task 3: Verificação de alegações

Esta é a tarefa central. É o que torna o raciocínio do modelo falsificável.

**Files:**
- Create: `packages/triage/src/claims.ts`
- Test: `packages/triage/src/claims.test.ts`

**Interfaces:**
- Consumes: `SpeechIndex`, `topicSpan`, `unitByIdOrThrow` (Task 2); `similarity`, `RESTATEMENT_THRESHOLD` (Task 1).
- Produces: `DropReason`, `StructureClaim`, `Verdict`, `verifyClaims(claims: StructureClaim[], index: SpeechIndex): Verdict[]`, `acceptedDropIds(verdicts: Verdict[]): Set<string>`.

- [ ] **Step 1: Escrever o teste que falha**

`packages/triage/src/claims.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { acceptedDropIds, verifyClaims, type StructureClaim } from "./claims.ts";
import { parseSpeechIndex } from "./speech-index.ts";

/** Miniatura do material real: pré-rolo, corpo, retomada, aparte, pós-rolo. */
const index = parseSpeechIndex({
  source_duration: 100,
  budget: { lossless_floor_seconds: 50 },
  topic_runs: [{ keyword: "escala", unit_ids: ["u003", "u007"] }],
  units: [
    { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Eu esqueci o começo, perdão." },
    { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "Agora vai, calma aí." },
    { id: "u003", index: 2, start: 6, end: 9, duration: 3, text: "Isso não escala e não te dá." },
    { id: "u004", index: 3, start: 10, end: 11, duration: 1, text: "Isso não escala" },
    { id: "u005", index: 4, start: 12, end: 13, duration: 1, text: "Isso não escala..." },
    { id: "u006", index: 5, start: 14, end: 16, duration: 2, text: "Nossa, hoje o sol está puxando." },
    { id: "u007", index: 6, start: 17, end: 21, duration: 4, text: "Dessa forma, não escala a comunicação." },
    { id: "u008", index: 7, start: 22, end: 24, duration: 2, text: "Ih, foi!" },
  ],
});

const claim = (c: Partial<StructureClaim> & Pick<StructureClaim, "unit_ids" | "reason">): StructureClaim =>
  ({ restated_by: null, note: "", ...c });

describe("verifyClaims — pré-rolo", () => {
  it("aceita trecho contíguo do começo, antes do primeiro topic_run", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u001", "u002"], reason: "preroll" })], index);
    expect(v!.accepted).toBe(true);
  });

  it("rejeita pré-rolo que não começa na primeira unidade", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u002"], reason: "preroll" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/primeira unidade/);
  });

  it("rejeita pré-rolo que invade o corpo do vídeo", () => {
    // u003 já está num topic_run — não pode ser pré-rolo
    const [v] = verifyClaims([claim({ unit_ids: ["u001", "u002", "u003"], reason: "preroll" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/topic_run/);
  });

  it("rejeita pré-rolo com buraco no meio", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u001", "u003"], reason: "preroll" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/contígu/);
  });
});

describe("verifyClaims — pós-rolo", () => {
  it("aceita trecho contíguo do fim, depois do último topic_run", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u008"], reason: "postroll" })], index);
    expect(v!.accepted).toBe(true);
  });

  it("rejeita pós-rolo que não termina na última unidade", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u006"], reason: "postroll" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/última unidade/);
  });
});

describe("verifyClaims — bloco de retomada", () => {
  it("aceita bloco cujas unidades se repetem, com versão completa depois", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u003", "u004", "u005"], reason: "restart_block", restated_by: "u007" })],
      index,
    );
    expect(v!.accepted).toBe(true);
  });

  it("rejeita quando falta restated_by", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u003", "u004", "u005"], reason: "restart_block" })],
      index,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/restated_by/);
  });

  it("rejeita quando nenhuma unidade do bloco repete outra", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u006", "u007"], reason: "restart_block", restated_by: "u008" })],
      index,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/quase-verbatim/);
  });

  it("rejeita quando restated_by também está sendo dropada", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u003", "u004", "u005", "u007"], reason: "restart_block", restated_by: "u007" })],
      index,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/também está sendo dropada/);
  });

  it("rejeita quando restated_by vem antes do bloco", () => {
    const [v] = verifyClaims(
      [claim({ unit_ids: ["u004", "u005"], reason: "restart_block", restated_by: "u003" })],
      index,
    );
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/posterior/);
  });
});

describe("verifyClaims — aparte", () => {
  it("aceita unidade fora de topic_run com conteúdo dos dois lados", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u006"], reason: "aside" })], index);
    expect(v!.accepted).toBe(true);
  });

  it("rejeita aparte que pertence a um topic_run", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u007"], reason: "aside" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/topic_run/);
  });

  it("rejeita aparte na borda — isso seria pré ou pós-rolo", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u008"], reason: "aside" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/dos dois lados/);
  });
});

describe("verifyClaims — id inventado", () => {
  it("rejeita em vez de estourar quando o modelo cita unidade inexistente", () => {
    const [v] = verifyClaims([claim({ unit_ids: ["u999"], reason: "preroll" })], index);
    expect(v!.accepted).toBe(false);
    expect(v!.accepted === false && v!.failed).toMatch(/u999/);
  });
});

describe("ordem de avaliação", () => {
  it("é independente da ordem das alegações", () => {
    const a = claim({ unit_ids: ["u001", "u002"], reason: "preroll" });
    const b = claim({ unit_ids: ["u006"], reason: "aside" });
    const c = claim({ unit_ids: ["u008"], reason: "postroll" });
    const forward = verifyClaims([a, b, c], index).map((v) => v.accepted);
    const backward = verifyClaims([c, b, a], index).map((v) => v.accepted).reverse();
    expect(forward).toEqual(backward);
    expect(forward).toEqual([true, true, true]);
  });
});

describe("acceptedDropIds", () => {
  it("junta só os ids das alegações aceitas", () => {
    const verdicts = verifyClaims(
      [
        claim({ unit_ids: ["u001", "u002"], reason: "preroll" }),
        claim({ unit_ids: ["u007"], reason: "aside" }), // rejeitada
      ],
      index,
    );
    expect([...acceptedDropIds(verdicts)].sort()).toEqual(["u001", "u002"]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run packages/triage/src/claims.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`packages/triage/src/claims.ts`:

```ts
import { RESTATEMENT_THRESHOLD, similarity } from "./similarity.ts";
import { topicSpan, type IndexUnit, type SpeechIndex } from "./speech-index.ts";

/** Categoria fechada. O modelo escolhe uma; o código confere a escolha. */
export type DropReason = "preroll" | "postroll" | "aside" | "restart_block";

export interface StructureClaim {
  unit_ids: string[];
  reason: DropReason;
  /** Só para `restart_block`: a unidade posterior que diz a frase inteira. */
  restated_by: string | null;
  note: string;
}

export type Verdict =
  | { claim: StructureClaim; accepted: true }
  | { claim: StructureClaim; accepted: false; failed: string };

/**
 * Confere cada alegação contra o índice.
 *
 * O que isto faz: rejeita alegação impossível. O que isto NÃO faz: certificar
 * alegação correta. A regra de `preroll` aceita `u001-u005` tão bem quanto
 * `u001-u004` — ela prova que o trecho está antes do corpo, não que o gancho
 * do vídeo não foi junto. A leitura do `condense_script.md` continua sendo a
 * checagem de verdade.
 *
 * Ordem de avaliação: "unidade que fica" significa *não reivindicada por
 * nenhuma alegação deste passe* — conjunto calculado uma vez, antes de
 * qualquer rejeição. Sem isso, a ordem das alegações mudaria o resultado.
 */
export function verifyClaims(claims: StructureClaim[], index: SpeechIndex): Verdict[] {
  const claimed = new Set<string>();
  for (const c of claims) for (const id of c.unit_ids) claimed.add(id);

  const span = topicSpan(index);
  const inTopicRun = new Set<string>();
  for (const run of index.topicRuns) for (const id of run.unitIds) inTopicRun.add(id);

  const firstIndex = index.units[0]!.index;
  const lastIndex = index.units[index.units.length - 1]!.index;

  return claims.map((claim) => {
    const failed = checkClaim(claim, {
      index, claimed, span, inTopicRun, firstIndex, lastIndex,
    });
    return failed === null
      ? { claim, accepted: true as const }
      : { claim, accepted: false as const, failed };
  });
}

interface Context {
  index: SpeechIndex;
  claimed: Set<string>;
  span: { first: number; last: number } | null;
  inTopicRun: Set<string>;
  firstIndex: number;
  lastIndex: number;
}

/** Devolve `null` se passa, ou a frase que descreve a condição que falhou. */
function checkClaim(claim: StructureClaim, ctx: Context): string | null {
  if (claim.unit_ids.length === 0) return "alegação sem unidade nenhuma";

  const units: IndexUnit[] = [];
  for (const id of claim.unit_ids) {
    const unit = ctx.index.units.find((u) => u.id === id);
    if (!unit) return `unidade ${id} não existe no índice`;
    units.push(unit);
  }
  units.sort((a, b) => a.index - b.index);

  const lo = units[0]!.index;
  const hi = units[units.length - 1]!.index;
  if (hi - lo + 1 !== units.length) return "as unidades não são contíguas";

  switch (claim.reason) {
    case "preroll": {
      if (lo !== ctx.firstIndex) return "pré-rolo não começa na primeira unidade do vídeo";
      if (ctx.span && hi >= ctx.span.first) {
        return "pré-rolo invade o corpo do vídeo (alcança unidade citada por topic_run)";
      }
      return null;
    }
    case "postroll": {
      if (hi !== ctx.lastIndex) return "pós-rolo não termina na última unidade do vídeo";
      if (ctx.span && lo <= ctx.span.last) {
        return "pós-rolo invade o corpo do vídeo (alcança unidade citada por topic_run)";
      }
      return null;
    }
    case "aside": {
      for (const unit of units) {
        if (ctx.inTopicRun.has(unit.id)) {
          return `${unit.id} pertence a um topic_run, então é assunto do vídeo, não aparte`;
        }
      }
      const keptBefore = ctx.index.units.some((u) => u.index < lo && !ctx.claimed.has(u.id));
      const keptAfter = ctx.index.units.some((u) => u.index > hi && !ctx.claimed.has(u.id));
      if (!keptBefore || !keptAfter) {
        return "aparte precisa de conteúdo mantido dos dois lados; na borda seria pré ou pós-rolo";
      }
      return null;
    }
    case "restart_block": {
      if (!claim.restated_by) return "restart_block sem `restated_by`";
      const target = ctx.index.units.find((u) => u.id === claim.restated_by);
      if (!target) return `unidade ${claim.restated_by} não existe no índice`;
      if (target.index <= hi) return "`restated_by` precisa ser posterior ao bloco";
      if (ctx.claimed.has(target.id)) {
        return "`restated_by` também está sendo dropada, então nada resta dizendo a frase";
      }
      const repeats = units.some((a, i) =>
        units.slice(i + 1).some((b) => similarity(a.text, b.text) >= RESTATEMENT_THRESHOLD),
      );
      if (!repeats) {
        return `nenhum par do bloco é quase-verbatim (limiar ${RESTATEMENT_THRESHOLD})`;
      }
      return null;
    }
  }
}

export function acceptedDropIds(verdicts: Verdict[]): Set<string> {
  const ids = new Set<string>();
  for (const v of verdicts) {
    if (v.accepted) for (const id of v.claim.unit_ids) ids.add(id);
  }
  return ids;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run packages/triage/src/claims.test.ts`
Expected: PASS, 17 testes.

- [ ] **Step 5: Commit**

```bash
git add packages/triage/src/claims.ts packages/triage/src/claims.test.ts
git commit -m "feat(triage): verificação das alegações do modelo contra o índice"
```

---

## Task 4: Montagem do keep-list

**Files:**
- Create: `packages/triage/src/keeplist.ts`
- Test: `packages/triage/src/keeplist.test.ts`

**Interfaces:**
- Consumes: `SpeechIndex` (Task 2).
- Produces: `keepListFrom(index: SpeechIndex, droppedIds: Set<string>): string`.

- [ ] **Step 1: Escrever o teste que falha**

`packages/triage/src/keeplist.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { keepListFrom } from "./keeplist.ts";
import { parseSpeechIndex } from "./speech-index.ts";

const index = parseSpeechIndex({
  units: Array.from({ length: 8 }, (_, i) => ({
    id: `u00${i + 1}`, index: i, start: i, end: i + 1, duration: 1, text: `t${i}`,
  })),
});

describe("keepListFrom", () => {
  it("comprime unidades consecutivas em faixa", () => {
    expect(keepListFrom(index, new Set(["u001", "u002"]))).toBe("u003-u008");
  });

  it("produz várias faixas quando há buraco no meio", () => {
    // o formato exato que o procedimento produziu na mão em 2026-09-04
    expect(keepListFrom(index, new Set(["u001", "u005", "u006"]))).toBe("u002-u004 u007-u008");
  });

  it("escreve unidade solta sem hífen", () => {
    expect(keepListFrom(index, new Set(["u002", "u004"]))).toBe("u001 u003 u005-u008");
  });

  it("devolve tudo quando nada foi dropado", () => {
    expect(keepListFrom(index, new Set())).toBe("u001-u008");
  });

  it("estoura em vez de devolver string vazia quando tudo foi dropado", () => {
    const all = new Set(index.units.map((u) => u.id));
    expect(() => keepListFrom(index, all)).toThrow(/nenhuma unidade/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run packages/triage/src/keeplist.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`packages/triage/src/keeplist.ts`:

```ts
import type { SpeechIndex } from "./speech-index.ts";

/**
 * Unidades sobreviventes → o argumento `--keep` do `condense.py plan`.
 *
 * Faixas consecutivas viram `u005-u031`; unidade solta fica `u007`. Manter
 * unidades consecutivas juntas importa: consecutivas não produzem corte
 * nenhum, que é a junção mais natural que existe.
 */
export function keepListFrom(index: SpeechIndex, droppedIds: Set<string>): string {
  const kept = index.units.filter((u) => !droppedIds.has(u.id));
  if (kept.length === 0) {
    throw new Error("a triagem dropou nenhuma unidade sobrando — não há o que cortar");
  }

  const ranges: string[] = [];
  let runStart = kept[0]!;
  let previous = kept[0]!;

  for (const unit of kept.slice(1)) {
    if (unit.index !== previous.index + 1) {
      ranges.push(runStart.id === previous.id ? runStart.id : `${runStart.id}-${previous.id}`);
      runStart = unit;
    }
    previous = unit;
  }
  ranges.push(runStart.id === previous.id ? runStart.id : `${runStart.id}-${previous.id}`);

  return ranges.join(" ");
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run packages/triage/src/keeplist.test.ts`
Expected: PASS, 5 testes.

- [ ] **Step 5: Commit**

```bash
git add packages/triage/src/keeplist.ts packages/triage/src/keeplist.test.ts
git commit -m "feat(triage): montagem do keep-list a partir das unidades sobreviventes"
```

---

## Task 5: Prompt, interface do modelo e fake

**Files:**
- Create: `packages/triage/src/prompt.ts`
- Create: `packages/triage/src/model.ts`
- Test: `packages/triage/src/prompt.test.ts`

**Interfaces:**
- Consumes: `SpeechIndex` (Task 2), `StructureClaim` (Task 3).
- Produces: `buildUnitsBlock(index: SpeechIndex): string`, `STRUCTURE_INSTRUCTIONS: string`, `PROMPT_VERSION: string`, `TriageModel`, `StructureRequest`, `DensityRequest`, `DensityCandidate`, `FakeTriageModel`.

- [ ] **Step 1: Escrever o teste que falha**

`packages/triage/src/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PROMPT_VERSION, STRUCTURE_INSTRUCTIONS, buildUnitsBlock } from "./prompt.ts";
import { parseSpeechIndex } from "./speech-index.ts";

const index = parseSpeechIndex({
  units: [
    { id: "u001", index: 0, start: 8.491, end: 11.815, duration: 3.324,
      text: "Eu esqueci o começo, perdão.", has_terminal_punct: true, is_question: false },
    { id: "u002", index: 1, start: 17.37, end: 21.58, duration: 4.21,
      text: "Agora vai, calma aí.", has_terminal_punct: true, is_question: false },
  ],
});

describe("buildUnitsBlock", () => {
  it("põe uma unidade por linha, com id, tempo e texto", () => {
    const block = buildUnitsBlock(index);
    expect(block.split("\n")).toHaveLength(2);
    expect(block).toContain("u001");
    expect(block).toContain("Eu esqueci o começo, perdão.");
  });

  it("usa segundos com uma casa, não MM:SS", () => {
    // MM:SS é o formato que o Gemini usa e que não serve para corte;
    // mandar segundos deixa claro que o tempo é do índice, não dele.
    const block = buildUnitsBlock(index);
    expect(block).toContain("8.5");
    expect(block).not.toMatch(/\d+:\d\d/);
  });

  it("não vaza quebra de linha do texto da unidade", () => {
    const dirty = parseSpeechIndex({
      units: [{ id: "u001", index: 0, start: 0, end: 1, duration: 1, text: "uma\nduas" }],
    });
    expect(buildUnitsBlock(dirty).split("\n")).toHaveLength(1);
  });
});

describe("STRUCTURE_INSTRUCTIONS", () => {
  it("proíbe o modelo de emitir tempo", () => {
    expect(STRUCTURE_INSTRUCTIONS.toLowerCase()).toContain("nunca");
    expect(STRUCTURE_INSTRUCTIONS).toContain("unit_ids");
  });

  it("tem versão fixada, que entra na chave de cache", () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run packages/triage/src/prompt.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar o prompt**

`packages/triage/src/prompt.ts`:

```ts
import type { SpeechIndex } from "./speech-index.ts";

/**
 * Muda sempre que o texto das instruções mudar — entra na chave de cache,
 * senão uma decisão velha sobreviveria a uma mudança de prompt.
 */
export const PROMPT_VERSION = "v1";

export const STRUCTURE_INSTRUCTIONS = `Você está vendo um vídeo de uma pessoa falando para a câmera, e a transcrição dele dividida em unidades numeradas.

Sua tarefa: identificar o que NÃO é o conteúdo do vídeo.

Quatro categorias, e só elas:

- "preroll": o começo, antes do vídeo de fato começar. A pessoa falando com quem está operando a câmera, se preparando, pedindo desculpa, contando que vai começar. Vem sempre no início e é contíguo.
- "postroll": o mesmo no fim — comemorar que gravou, perguntar se ficou bom, falar com a sala.
- "aside": um comentário fora do assunto no meio do vídeo, dirigido a alguém presente e não a quem assiste.
- "restart_block": a pessoa tropeça e recomeça a mesma frase várias vezes, e mais adiante consegue dizê-la inteira. Reivindique as tentativas falhas e aponte em "restated_by" a unidade que diz a frase completa.

Regras:

- Você identifica unidades por "unit_ids" (ex: ["u001","u002"]). NUNCA devolva tempo, timestamp, MM:SS ou segundos — o tempo exato vem do índice, não de você.
- Se algo é o assunto do vídeo, deixe passar. Na dúvida, não reivindique.
- Cada alegação precisa ser contígua.
- Em "note", uma frase curta em português dizendo por que aquilo não é o vídeo.
- Se nada se encaixar, devolva lista vazia.

O vídeo está junto para você ver o contexto — se a pessoa está olhando para a câmera ou para o lado, se está ajeitando alguma coisa, se aponta para algo na tela. Use isso para decidir, nunca para medir tempo.`;

/** Uma unidade por linha: id, começo, duração e texto. */
export function buildUnitsBlock(index: SpeechIndex): string {
  return index.units
    .map((u) => {
      const text = u.text.replace(/\s+/g, " ").trim();
      return `${u.id} | ${u.start.toFixed(1)}s +${u.duration.toFixed(1)}s | ${text}`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Implementar a interface e o fake**

`packages/triage/src/model.ts`:

```ts
import type { StructureClaim } from "./claims.ts";

export interface StructureRequest {
  unitsBlock: string;
  videoPath: string;
}

export interface DensityRequest {
  unitsBlock: string;
  videoPath: string;
  budgetSeconds: number;
}

export interface DensityCandidate {
  unit_ids: string[];
  note: string;
  /** 1 é o primeiro a sair. */
  rank: number;
}

/**
 * A única superfície que fala com um LLM. Tudo o mais no pacote é função pura
 * sobre o índice, e por isso testa offline.
 */
export interface TriageModel {
  structure(req: StructureRequest): Promise<StructureClaim[]>;
  density(req: DensityRequest): Promise<DensityCandidate[]>;
}

/** Devolve respostas roteirizadas — inclusive erradas, de propósito. */
export class FakeTriageModel implements TriageModel {
  readonly calls: { kind: "structure" | "density"; req: StructureRequest | DensityRequest }[] = [];

  constructor(
    private readonly claims: StructureClaim[] = [],
    private readonly candidates: DensityCandidate[] = [],
  ) {}

  async structure(req: StructureRequest): Promise<StructureClaim[]> {
    this.calls.push({ kind: "structure", req });
    return this.claims;
  }

  async density(req: DensityRequest): Promise<DensityCandidate[]> {
    this.calls.push({ kind: "density", req });
    return this.candidates;
  }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run packages/triage/src/prompt.test.ts`
Expected: PASS, 5 testes.

- [ ] **Step 6: Commit**

```bash
git add packages/triage/src/prompt.ts packages/triage/src/model.ts packages/triage/src/prompt.test.ts
git commit -m "feat(triage): prompt de estrutura, interface do modelo e fake de teste"
```

---

## Task 6: Passe de densidade

**Files:**
- Create: `packages/triage/src/density.ts`
- Test: `packages/triage/src/density.test.ts`

**Interfaces:**
- Consumes: `SpeechIndex` (Task 2), `DensityCandidate` (Task 5).
- Produces: `DENSITY_INSTRUCTIONS: string`, `applyDensityBudget(candidates, index, opts): { droppedIds: Set<string>; applied: DensityCandidate[]; skipped: { candidate: DensityCandidate; why: string }[] }`.

- [ ] **Step 1: Escrever o teste que falha**

`packages/triage/src/density.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyDensityBudget } from "./density.ts";
import { parseSpeechIndex } from "./speech-index.ts";

const index = parseSpeechIndex({
  units: Array.from({ length: 6 }, (_, i) => ({
    id: `u00${i + 1}`, index: i, start: i * 10, end: i * 10 + 5, duration: 5, text: `t${i}`,
  })),
});

const cand = (ids: string[], rank: number) => ({ unit_ids: ids, note: "", rank });

describe("applyDensityBudget", () => {
  it("aplica por rank até fechar o orçamento e para", () => {
    const out = applyDensityBudget([cand(["u001"], 1), cand(["u002"], 2), cand(["u003"], 3)],
      index, { budgetSeconds: 7, alreadyDropped: new Set() });
    // u001 (5s) entra; u002 levaria a 10s, acima de 7 — para antes
    expect([...out.droppedIds]).toEqual(["u001"]);
    expect(out.applied).toHaveLength(1);
  });

  it("respeita o rank mesmo se vier fora de ordem", () => {
    const out = applyDensityBudget([cand(["u003"], 2), cand(["u001"], 1)],
      index, { budgetSeconds: 5, alreadyDropped: new Set() });
    expect([...out.droppedIds]).toEqual(["u001"]);
  });

  it("pula candidato que já saiu no passe 1, sem gastar orçamento", () => {
    const out = applyDensityBudget([cand(["u001"], 1), cand(["u002"], 2)],
      index, { budgetSeconds: 5, alreadyDropped: new Set(["u001"]) });
    expect([...out.droppedIds]).toEqual(["u002"]);
    expect(out.skipped[0]!.why).toMatch(/passe 1/);
  });

  it("pula id inexistente em vez de estourar", () => {
    const out = applyDensityBudget([cand(["u999"], 1), cand(["u002"], 2)],
      index, { budgetSeconds: 5, alreadyDropped: new Set() });
    expect([...out.droppedIds]).toEqual(["u002"]);
    expect(out.skipped[0]!.why).toMatch(/u999/);
  });

  it("não dropa nada com orçamento zero", () => {
    const out = applyDensityBudget([cand(["u001"], 1)], index,
      { budgetSeconds: 0, alreadyDropped: new Set() });
    expect(out.droppedIds.size).toBe(0);
  });

  it("nunca dropa tudo — mantém ao menos uma unidade", () => {
    const all = index.units.map((u, i) => cand([u.id], i + 1));
    const out = applyDensityBudget(all, index, { budgetSeconds: 9999, alreadyDropped: new Set() });
    expect(out.droppedIds.size).toBeLessThan(index.units.length);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run packages/triage/src/density.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Implementar**

`packages/triage/src/density.ts`:

```ts
import type { DensityCandidate } from "./model.ts";
import type { SpeechIndex } from "./speech-index.ts";

export const DENSITY_INSTRUCTIONS = `A fala abaixo já teve o que não é conteúdo removido. Agora ela precisa encurtar, e o corte vai custar conteúdo de verdade.

Devolva candidatos a sair, do mais dispensável para o menos, cada um com "rank" (1 sai primeiro). Prefira nesta ordem:

1. unidade que repete o que outra já disse melhor;
2. exemplo a mais numa enumeração que já se entende;
3. elaboração que não muda a conclusão.

Nunca proponha tirar: a frase de abertura, a conclusão, ou uma unidade que responde a uma pergunta que fica.

Só "unit_ids" — nunca tempo. Unidade inteira, nunca pedaço.`;

/**
 * Aplica candidatos por rank até fechar o orçamento.
 *
 * Ao contrário do passe 1, aqui não há verificação por máquina: "isto é
 * redundante com o argumento" não é checável contra o índice. O que existe é
 * o orçamento — sem alvo explícito, "corte o que é redundante" não tem
 * condição de parada. A checagem de verdade é a leitura do condense_script.md.
 */
export function applyDensityBudget(
  candidates: DensityCandidate[],
  index: SpeechIndex,
  opts: { budgetSeconds: number; alreadyDropped: Set<string> },
): {
  droppedIds: Set<string>;
  applied: DensityCandidate[];
  skipped: { candidate: DensityCandidate; why: string }[];
} {
  const droppedIds = new Set<string>();
  const applied: DensityCandidate[] = [];
  const skipped: { candidate: DensityCandidate; why: string }[] = [];
  let spent = 0;

  const survivors = index.units.filter((u) => !opts.alreadyDropped.has(u.id)).length;

  for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
    const units = candidate.unit_ids.map((id) => index.units.find((u) => u.id === id));
    const missing = candidate.unit_ids.filter((_, i) => units[i] === undefined);
    if (missing.length > 0) {
      skipped.push({ candidate, why: `unidade inexistente no índice: ${missing.join(", ")}` });
      continue;
    }
    if (candidate.unit_ids.some((id) => opts.alreadyDropped.has(id))) {
      skipped.push({ candidate, why: "já saiu no passe 1" });
      continue;
    }
    if (survivors - droppedIds.size - candidate.unit_ids.length < 1) {
      skipped.push({ candidate, why: "dropar isto não deixaria unidade nenhuma de pé" });
      continue;
    }

    const cost = units.reduce((n, u) => n + u!.duration, 0);
    if (spent + cost > opts.budgetSeconds) break;

    for (const id of candidate.unit_ids) droppedIds.add(id);
    applied.push(candidate);
    spent += cost;
  }

  return { droppedIds, applied, skipped };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run packages/triage/src/density.test.ts`
Expected: PASS, 6 testes.

- [ ] **Step 5: Commit**

```bash
git add packages/triage/src/density.ts packages/triage/src/density.test.ts
git commit -m "feat(triage): passe de densidade limitado por orçamento explícito"
```

---

## Task 7: Cache e relatório

**Files:**
- Create: `packages/triage/src/cache.ts`
- Create: `packages/triage/src/report.ts`
- Test: `packages/triage/src/cache.test.ts`
- Test: `packages/triage/src/report.test.ts`

**Interfaces:**
- Consumes: `Verdict` (Task 3), `DensityCandidate` (Task 5).
- Produces: `cacheKey(parts: CacheKeyParts): string`, `readCache<T>(dir, key): Promise<T | null>`, `writeCache(dir, key, value): Promise<void>`, `renderReport(input: ReportInput): string`.

- [ ] **Step 1: Escrever os testes que falham**

`packages/triage/src/cache.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheKey, readCache, writeCache } from "./cache.ts";

const parts = {
  videoSha: "abc", indexSha: "def", promptVersion: "v1",
  model: "gemini-3.8-flash", pass: "structure" as const,
};

describe("cacheKey", () => {
  it("é estável para as mesmas entradas", () => {
    expect(cacheKey(parts)).toBe(cacheKey({ ...parts }));
  });

  it("muda quando a versão do prompt muda", () => {
    expect(cacheKey({ ...parts, promptVersion: "v2" })).not.toBe(cacheKey(parts));
  });

  it("muda quando o passe muda, para --target não invalidar o passe 1", () => {
    expect(cacheKey({ ...parts, pass: "density" })).not.toBe(cacheKey(parts));
  });

  it("é seguro como nome de arquivo", () => {
    expect(cacheKey(parts)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("readCache / writeCache", () => {
  it("devolve null quando não há nada gravado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-"));
    expect(await readCache(dir, cacheKey(parts))).toBeNull();
  });

  it("devolve o que foi gravado", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-"));
    await writeCache(dir, cacheKey(parts), [{ unit_ids: ["u001"] }]);
    expect(await readCache(dir, cacheKey(parts))).toEqual([{ unit_ids: ["u001"] }]);
  });

  it("trata cache corrompido como ausente em vez de estourar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, `${cacheKey(parts)}.json`), "{ isso não é json", "utf8");
    expect(await readCache(dir, cacheKey(parts))).toBeNull();
  });
});
```

`packages/triage/src/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderReport } from "./report.ts";

const base = {
  keepList: "u005-u031 u038-u041",
  model: "gemini-3.8-flash",
  verdicts: [
    { accepted: true as const, claim: { unit_ids: ["u001", "u002"], reason: "preroll" as const, restated_by: null, note: "falando com o operador" } },
    { accepted: false as const, failed: "pré-rolo invade o corpo do vídeo", claim: { unit_ids: ["u010"], reason: "preroll" as const, restated_by: null, note: "chute" } },
  ],
  density: null,
};

describe("renderReport", () => {
  it("mostra o keep-list pronto para colar", () => {
    expect(renderReport(base)).toContain("u005-u031 u038-u041");
  });

  it("lista alegação aceita com o motivo dado pelo modelo", () => {
    expect(renderReport(base)).toContain("falando com o operador");
  });

  it("lista alegação rejeitada com a condição que falhou", () => {
    const out = renderReport(base);
    expect(out).toContain("u010");
    expect(out).toContain("pré-rolo invade o corpo do vídeo");
  });

  it("diz que o passe de densidade não rodou quando não houve alvo", () => {
    expect(renderReport(base)).toMatch(/densidade.*não rodou|sem --target/i);
  });

  it("avisa quando nada foi reivindicado", () => {
    const out = renderReport({ ...base, verdicts: [] });
    expect(out).toMatch(/nada/i);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run packages/triage/src/cache.test.ts packages/triage/src/report.test.ts`
Expected: FAIL — módulos não resolvem.

- [ ] **Step 3: Implementar o cache**

`packages/triage/src/cache.ts`:

```ts
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CacheKeyParts {
  videoSha: string;
  indexSha: string;
  promptVersion: string;
  model: string;
  pass: "structure" | "density";
}

/**
 * Mandar o vídeo pro modelo custa e demora, e a resposta não é determinística.
 * O cache é o que devolve reprodutibilidade: a mesma entrada dá a mesma
 * decisão, e daqui a seis meses dá para ler o que o modelo disse e por quê.
 *
 * O passe entra na chave para que mudar `--target` re-rode só a densidade.
 */
export function cacheKey(parts: CacheKeyParts): string {
  return createHash("sha256")
    .update([parts.videoSha, parts.indexSha, parts.promptVersion, parts.model, parts.pass].join(" "))
    .digest("hex");
}

export async function readCache<T>(dir: string, key: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as T;
  } catch {
    // Ausente ou corrompido dão no mesmo: re-perguntar ao modelo é correto e
    // apenas custa. Estourar aqui transformaria um cache ruim em falha dura.
    return null;
  }
}

export async function writeCache(dir: string, key: string, value: unknown): Promise<void> {
  await writeFile(join(dir, `${key}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
```

- [ ] **Step 4: Implementar o relatório**

`packages/triage/src/report.ts`:

```ts
import type { DensityCandidate } from "./model.ts";
import type { Verdict } from "./claims.ts";

export interface ReportInput {
  keepList: string;
  model: string;
  verdicts: Verdict[];
  density: {
    budgetSeconds: number;
    applied: DensityCandidate[];
    skipped: { candidate: DensityCandidate; why: string }[];
  } | null;
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = ["# Triagem", "", `- modelo: ${input.model}`, `- keep-list: \`${input.keepList}\``, ""];

  const accepted = input.verdicts.filter((v) => v.accepted);
  const rejected = input.verdicts.filter((v) => !v.accepted);

  lines.push("## Passe 1 — estrutura", "");
  if (input.verdicts.length === 0) {
    lines.push("O modelo não reivindicou nada. Tudo foi mantido.", "");
  }
  if (accepted.length > 0) {
    lines.push("### Aplicado", "");
    for (const v of accepted) {
      lines.push(`- **${v.claim.unit_ids.join(", ")}** — \`${v.claim.reason}\` — ${v.claim.note}`);
    }
    lines.push("");
  }
  if (rejected.length > 0) {
    lines.push("### Rejeitado (alegação não conferiu com o índice)", "");
    for (const v of rejected) {
      if (v.accepted) continue;
      lines.push(`- **${v.claim.unit_ids.join(", ")}** — \`${v.claim.reason}\` — ${v.claim.note}`);
      lines.push(`  - falhou: ${v.failed}`);
    }
    lines.push("");
  }

  lines.push("## Passe 2 — densidade", "");
  if (!input.density) {
    lines.push("Não rodou: nenhum `--target` foi dado, então não havia condição de parada.", "");
  } else {
    lines.push(`Orçamento: ${input.density.budgetSeconds.toFixed(1)}s`, "");
    for (const c of input.density.applied) {
      lines.push(`- **${c.unit_ids.join(", ")}** (rank ${c.rank}) — ${c.note}`);
    }
    for (const s of input.density.skipped) {
      lines.push(`- ~~${s.candidate.unit_ids.join(", ")}~~ pulado: ${s.why}`);
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "A verificação rejeita alegação impossível. Ela **não** certifica alegação",
    "correta — a regra de pré-rolo aceitaria um trecho maior que engolisse o",
    "gancho do vídeo. Leia o `condense_script.md` inteiro antes de renderizar.",
    "",
  );

  return lines.join("\n");
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run packages/triage/src/cache.test.ts packages/triage/src/report.test.ts`
Expected: PASS, 12 testes.

- [ ] **Step 6: Commit**

```bash
git add packages/triage/src/cache.ts packages/triage/src/report.ts packages/triage/src/cache.test.ts packages/triage/src/report.test.ts
git commit -m "feat(triage): cache por hash e relatório de alegações aceitas e rejeitadas"
```

---

## Task 8: Adaptador Gemini

**Files:**
- Create: `packages/triage/src/gemini.ts`
- Create: `packages/triage/src/index.ts`
- Modify: `packages/triage/package.json` (adicionar `@google/genai`)

**Interfaces:**
- Consumes: `TriageModel`, `StructureRequest`, `DensityRequest`, `DensityCandidate` (Task 5); `STRUCTURE_INSTRUCTIONS`, `DENSITY_INSTRUCTIONS` (Tasks 5, 6); `StructureClaim` (Task 3).
- Produces: `GeminiTriageModel`, `DEFAULT_MODEL: "gemini-3.8-flash"`.

Este adaptador é a única parte que fala com a rede. Não tem teste unitário — o que dá para testar dele (formato do pedido, montagem do schema) já está coberto pelas funções puras, e o resto é exercitado no teste de aceitação da Task 10.

- [ ] **Step 1: Adicionar a dependência**

```bash
pnpm --filter @decupa/triage add @google/genai
```

Confirmar que a versão instalada é `>= 2.3.0` — abaixo disso não existe `interactions.create`:

```bash
node -e "console.log(require('./packages/triage/node_modules/@google/genai/package.json').version)"
```

- [ ] **Step 2: Implementar o adaptador**

`packages/triage/src/gemini.ts`:

```ts
import { GoogleGenAI } from "@google/genai";
import type { StructureClaim } from "./claims.ts";
import type { DensityCandidate, DensityRequest, StructureRequest, TriageModel } from "./model.ts";
import { DENSITY_INSTRUCTIONS } from "./density.ts";
import { STRUCTURE_INSTRUCTIONS } from "./prompt.ts";

export const DEFAULT_MODEL = "gemini-3.8-flash";

const STRUCTURE_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          unit_ids: { type: "array", items: { type: "string" } },
          reason: { type: "string", enum: ["preroll", "postroll", "aside", "restart_block"] },
          restated_by: { type: "string", nullable: true },
          note: { type: "string" },
        },
        required: ["unit_ids", "reason", "note"],
      },
    },
  },
  required: ["claims"],
} as const;

const DENSITY_SCHEMA = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          unit_ids: { type: "array", items: { type: "string" } },
          note: { type: "string" },
          rank: { type: "integer" },
        },
        required: ["unit_ids", "note", "rank"],
      },
    },
  },
  required: ["candidates"],
} as const;

export class GeminiTriageModel implements TriageModel {
  private readonly client: GoogleGenAI;
  private uploaded: { uri: string; mimeType: string } | null = null;

  constructor(private readonly model: string = DEFAULT_MODEL, apiKey = process.env.GEMINI_API_KEY) {
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY não está setada. A triagem precisa dela para ler o vídeo. " +
        "Sem a chave, monte o keep-list na mão e passe direto pro `condense.py plan`.",
      );
    }
    this.client = new GoogleGenAI({ apiKey });
  }

  /** Sobe o vídeo uma vez só e reusa entre os dois passes. */
  private async video(path: string): Promise<{ uri: string; mimeType: string }> {
    if (this.uploaded) return this.uploaded;
    let file = await this.client.files.upload({ file: path });
    while (file.state?.name !== "ACTIVE") {
      if (file.state?.name === "FAILED") throw new Error(`o Gemini falhou ao processar ${path}`);
      await new Promise((r) => setTimeout(r, 5000));
      file = await this.client.files.get({ name: file.name! });
    }
    this.uploaded = { uri: file.uri!, mimeType: file.mimeType! };
    return this.uploaded;
  }

  private async ask<T>(videoPath: string, instructions: string, text: string, schema: unknown, key: string): Promise<T[]> {
    const video = await this.video(videoPath);
    const interaction = await this.client.interactions.create({
      model: this.model,
      input: [
        { type: "video", uri: video.uri, mime_type: video.mimeType, processing: { type: "agentic" } },
        { type: "text", text: `${instructions}\n\n---\n\n${text}` },
      ],
      response_format: { type: "text", mime_type: "application/json", schema },
      generation_config: { seed: 0 },
    });
    const parsed = JSON.parse(interaction.output_text) as Record<string, T[]>;
    return parsed[key] ?? [];
  }

  async structure(req: StructureRequest): Promise<StructureClaim[]> {
    const claims = await this.ask<StructureClaim>(
      req.videoPath, STRUCTURE_INSTRUCTIONS, req.unitsBlock, STRUCTURE_SCHEMA, "claims",
    );
    // `restated_by` é opcional no schema; normalizar para o que claims.ts espera.
    return claims.map((c) => ({ ...c, restated_by: c.restated_by ?? null }));
  }

  async density(req: DensityRequest): Promise<DensityCandidate[]> {
    return this.ask<DensityCandidate>(
      req.videoPath,
      `${DENSITY_INSTRUCTIONS}\n\nOrçamento: ${req.budgetSeconds.toFixed(1)} segundos.`,
      req.unitsBlock, DENSITY_SCHEMA, "candidates",
    );
  }
}
```

- [ ] **Step 3: Escrever os re-exports**

`packages/triage/src/index.ts`:

```ts
export type { DropReason, StructureClaim, Verdict } from "./claims.ts";
export type { DensityCandidate, DensityRequest, StructureRequest, TriageModel } from "./model.ts";
export type { IndexUnit, SpeechIndex, TopicRun } from "./speech-index.ts";
export type { CacheKeyParts } from "./cache.ts";
export type { ReportInput } from "./report.ts";

export { acceptedDropIds, verifyClaims } from "./claims.ts";
export { applyDensityBudget, DENSITY_INSTRUCTIONS } from "./density.ts";
export { DEFAULT_MODEL, GeminiTriageModel } from "./gemini.ts";
export { keepListFrom } from "./keeplist.ts";
export { FakeTriageModel } from "./model.ts";
export { buildUnitsBlock, PROMPT_VERSION, STRUCTURE_INSTRUCTIONS } from "./prompt.ts";
export { renderReport } from "./report.ts";
export { cacheKey, readCache, writeCache } from "./cache.ts";
export { parseSpeechIndex, topicSpan, unitByIdOrThrow } from "./speech-index.ts";
export { RESTATEMENT_THRESHOLD, similarity } from "./similarity.ts";
```

- [ ] **Step 4: Verificar que compila**

Run: `pnpm typecheck`
Expected: sem erro.

- [ ] **Step 5: Commit**

```bash
git add packages/triage/src/gemini.ts packages/triage/src/index.ts packages/triage/package.json pnpm-lock.yaml
git commit -m "feat(triage): adaptador do Gemini com vídeo agentic e saída estruturada"
```

---

## Task 9: Comando `decupa triage`

**Files:**
- Create: `apps/cli/src/triage.ts`
- Modify: `apps/cli/src/index.ts` (registrar o subcomando e estender o USAGE)
- Modify: `apps/cli/package.json` (adicionar `@decupa/triage`)
- Test: `apps/cli/src/triage.test.ts`

**Interfaces:**
- Consumes: tudo o que `@decupa/triage` exporta (Tasks 1–8).
- Produces: `runTriage(opts: TriageOptions): Promise<TriageResult>` com
  `TriageOptions = { indexPath: string; videoPath: string; outDir: string; targetSeconds?: number; model?: TriageModel; modelName?: string }`
  e `TriageResult = { keepList: string; verdicts: Verdict[]; reportPath: string }`.

- [ ] **Step 1: Escrever o teste que falha**

`apps/cli/src/triage.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTriageModel } from "@decupa/triage";
import { describe, expect, it } from "vitest";
import { runTriage } from "./triage.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "triage-cli-"));
  const indexPath = join(dir, "speech_index.json");
  await writeFile(indexPath, JSON.stringify({
    source_duration: 40,
    budget: { lossless_floor_seconds: 20 },
    topic_runs: [{ keyword: "escala", unit_ids: ["u003", "u005"] }],
    units: [
      { id: "u001", index: 0, start: 0, end: 2, duration: 2, text: "Eu esqueci o começo." },
      { id: "u002", index: 1, start: 3, end: 5, duration: 2, text: "Agora vai." },
      { id: "u003", index: 2, start: 6, end: 9, duration: 3, text: "Isso não escala de jeito nenhum." },
      { id: "u004", index: 3, start: 10, end: 12, duration: 2, text: "Nossa, que calor." },
      { id: "u005", index: 4, start: 13, end: 16, duration: 3, text: "Dessa forma não escala a comunicação." },
    ],
  }), "utf8");
  const videoPath = join(dir, "v.mp4");
  await writeFile(videoPath, "não é vídeo de verdade; o modelo é falso neste teste", "utf8");
  return { dir, indexPath, videoPath };
}

describe("runTriage", () => {
  it("aplica alegação que confere e devolve o keep-list", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([
      { unit_ids: ["u001", "u002"], reason: "preroll", restated_by: null, note: "pré-rolo" },
    ]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model });
    expect(out.keepList).toBe("u003-u005");
  });

  it("não aplica alegação que não confere, e mantém as unidades", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([
      // u003 está num topic_run: não pode ser aparte
      { unit_ids: ["u003"], reason: "aside", restated_by: null, note: "chute" },
    ]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model });
    expect(out.keepList).toBe("u001-u005");
    expect(out.verdicts[0]!.accepted).toBe(false);
  });

  it("grava o relatório com a alegação rejeitada", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([
      { unit_ids: ["u003"], reason: "aside", restated_by: null, note: "chute" },
    ]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model });
    const report = await readFile(out.reportPath, "utf8");
    expect(report).toContain("Rejeitado");
    expect(report).toContain("topic_run");
  });

  it("mantém tudo quando o modelo não reivindica nada", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model: new FakeTriageModel([]) });
    expect(out.keepList).toBe("u001-u005");
  });

  it("não chama o passe de densidade sem alvo", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([]);
    await runTriage({ indexPath, videoPath, outDir: dir, model });
    expect(model.calls.filter((c) => c.kind === "density")).toHaveLength(0);
  });

  it("chama o passe de densidade quando há alvo", async () => {
    const { dir, indexPath, videoPath } = await fixture();
    const model = new FakeTriageModel([], [{ unit_ids: ["u004"], note: "aparte", rank: 1 }]);
    const out = await runTriage({ indexPath, videoPath, outDir: dir, model, targetSeconds: 25 });
    expect(model.calls.filter((c) => c.kind === "density")).toHaveLength(1);
    expect(out.keepList).toBe("u001-u003 u005");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run apps/cli/src/triage.test.ts`
Expected: FAIL — módulo não resolve.

- [ ] **Step 3: Adicionar a dependência**

Em `apps/cli/package.json`, dentro de `dependencies`:

```json
"@decupa/triage": "workspace:*"
```

- [ ] **Step 4: Implementar**

`apps/cli/src/triage.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acceptedDropIds, applyDensityBudget, buildUnitsBlock, cacheKey, DEFAULT_MODEL,
  GeminiTriageModel, keepListFrom, parseSpeechIndex, PROMPT_VERSION, readCache,
  renderReport, verifyClaims, writeCache,
  type DensityCandidate, type StructureClaim, type TriageModel, type Verdict,
} from "@decupa/triage";

export interface TriageOptions {
  indexPath: string;
  videoPath: string;
  outDir: string;
  targetSeconds?: number;
  /** Injetável para teste; em produção é o GeminiTriageModel. */
  model?: TriageModel;
  modelName?: string;
}

export interface TriageResult {
  keepList: string;
  verdicts: Verdict[];
  reportPath: string;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function runTriage(opts: TriageOptions): Promise<TriageResult> {
  const modelName = opts.modelName ?? DEFAULT_MODEL;
  const model = opts.model ?? new GeminiTriageModel(modelName);
  const index = parseSpeechIndex(JSON.parse(await readFile(opts.indexPath, "utf8")));
  const unitsBlock = buildUnitsBlock(index);

  const cacheDir = join(opts.outDir, "triage_cache");
  await mkdir(cacheDir, { recursive: true });
  const shas = { videoSha: await sha256(opts.videoPath), indexSha: await sha256(opts.indexPath) };
  const keyOf = (pass: "structure" | "density") =>
    cacheKey({ ...shas, promptVersion: PROMPT_VERSION, model: modelName, pass });

  // Passe 1 — estrutura
  const structureKey = keyOf("structure");
  let claims = await readCache<StructureClaim[]>(cacheDir, structureKey);
  if (claims === null) {
    claims = await model.structure({ unitsBlock, videoPath: opts.videoPath });
    await writeCache(cacheDir, structureKey, claims);
  }
  const verdicts = verifyClaims(claims, index);
  const dropped = acceptedDropIds(verdicts);

  // Passe 2 — densidade, só com alvo
  let density: TriageResult extends never ? never : Parameters<typeof renderReport>[0]["density"] = null;
  if (opts.targetSeconds !== undefined) {
    const budgetSeconds = Math.max(0, index.sourceDurationSeconds - opts.targetSeconds - index.losslessFloorSeconds);
    const densityKey = keyOf("density");
    let candidates = await readCache<DensityCandidate[]>(cacheDir, densityKey);
    if (candidates === null) {
      candidates = await model.density({ unitsBlock, videoPath: opts.videoPath, budgetSeconds });
      await writeCache(cacheDir, densityKey, candidates);
    }
    const applied = applyDensityBudget(candidates, index, { budgetSeconds, alreadyDropped: dropped });
    for (const id of applied.droppedIds) dropped.add(id);
    density = { budgetSeconds, applied: applied.applied, skipped: applied.skipped };
  }

  const keepList = keepListFrom(index, dropped);
  const reportPath = join(opts.outDir, "triage.md");
  await writeFile(reportPath, renderReport({ keepList, model: modelName, verdicts, density }), "utf8");

  return { keepList, verdicts, reportPath };
}
```

- [ ] **Step 5: Registrar o subcomando**

Em `apps/cli/src/index.ts`, adicionar ao `USAGE` antes da crase de fechamento:

```
  decupa triage --index <speech_index.json> --video <vídeo> --out <pasta> [--target 90] [--model gemini-3.8-flash]
      Decide o que é conteúdo do vídeo e o que não é, e devolve o keep-list
      pronto pro `condense.py plan`. Cada alegação do modelo é conferida
      contra o índice antes de virar corte. --target liga o passe de
      densidade; sem ele, só estrutura.
```

E, junto dos outros blocos de comando:

```ts
  if (command === "triage") {
    const { values } = parseArgs({
      args: rest,
      options: {
        index: { type: "string" },
        video: { type: "string" },
        out: { type: "string" },
        target: { type: "string" },
        model: { type: "string" },
      },
    });
    if (!values.index || !values.video || !values.out) {
      console.error("triage precisa de --index, --video e --out");
      return 1;
    }
    const { runTriage } = await import("./triage.ts");
    const result = await runTriage({
      indexPath: values.index,
      videoPath: values.video,
      outDir: values.out,
      targetSeconds: values.target ? Number(values.target) : undefined,
      modelName: values.model,
    });
    const rejected = result.verdicts.filter((v) => !v.accepted).length;
    console.log(`keep-list: ${result.keepList}`);
    console.log(`${result.verdicts.length - rejected} alegação(ões) aplicada(s), ${rejected} rejeitada(s) · ${result.reportPath}`);
    if (rejected > 0) console.log("Leia as rejeitadas no relatório antes de seguir.");
    return 0;
  }
```

O `import` é dinâmico para que `decupa gold`, `mark` e `measure` continuem
rodando sem `@google/genai` instalado.

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm vitest run apps/cli/src/triage.test.ts`
Expected: PASS, 6 testes.

- [ ] **Step 7: Rodar a suíte inteira**

Run: `pnpm test && pnpm typecheck`
Expected: tudo verde, incluindo os testes que já existiam.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/triage.ts apps/cli/src/triage.test.ts apps/cli/src/index.ts apps/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): comando decupa triage"
```

---

## Task 10: Aceitação no material real

Esta tarefa não escreve código de produção. Ela responde à única pergunta que
importa: a triagem chega sozinha na resposta que uma pessoa derivou na mão?

**Files:**
- Create: `docs/skills/limpar-fala/SKILL.md` (modificar — inserir o passo)

**Interfaces:**
- Consumes: `decupa triage` (Task 9).
- Produces: nada de código.

- [ ] **Step 1: Rodar contra o vídeo de referência**

O índice e o proxy já existem de 2026-09-04:

```bash
export GEMINI_API_KEY=...  # sem isto o comando falha com a mensagem certa
pnpm decupa triage \
  --index work/corte-contexto/out/speech_index.json \
  --video work/ritmo/proxy.mp4 \
  --out work/corte-contexto/out
```

- [ ] **Step 2: Comparar com a resposta derivada na mão**

A resposta de referência, verificada por QC (27 clipes, 0 corte `in_speech`,
`work/corte-contexto/condense-contexto.mp4`) é:

```
u005-u031 u038-u041
```

Registrar o que saiu em `work/corte-contexto/out/triage.md`. Três desfechos:

- **Igual** — a camada reproduz o julgamento humano. Seguir.
- **Perto** (pega `u001-u004` e `u042`, erra o bloco `u032-u037`) — ainda é
  vitória: o defeito que o usuário reclamou está resolvido. Anotar a
  divergência no relatório e decidir se vale ajustar o prompt.
- **Longe** (engole o gancho `u005`, ou não reivindica nada) — a verificação
  não pega isso, porque `u001-u005` passa na regra de pré-rolo. É exatamente
  o limite documentado no spec. Ajustar `STRUCTURE_INSTRUCTIONS`, subir
  `PROMPT_VERSION` para `v2` (o que invalida o cache) e rodar de novo.

- [ ] **Step 3: Rodar o pipeline inteiro com o keep-list que saiu**

```bash
export CLAUDE_PROJECT_DIR="$PWD/work/triagem-e2e"
mkdir -p work/triagem-e2e
python3 scripts/condense.py plan "$PWD/work/ritmo/proxy.mp4" --keep <o que saiu> --drop-fillers hard
python3 scripts/condense.py render "$PWD/work/ritmo/proxy.mp4" "$PWD/work/triagem-e2e/triagem.mp4"
python3 scripts/condense.py qc "$PWD/work/triagem-e2e/triagem.mp4"
```

Ler `out/condense_script.md` inteiro antes do render — esse é o checkpoint que
a triagem **não** substitui, e é o passo que pegou o bloco de gagueira quando
o keep-list foi montado à mão.

- [ ] **Step 4: Inserir o passo no SKILL.md**

Em `docs/skills/limpar-fala/SKILL.md`, entre o passo 2 (Medir) e o passo 3
(Decidir o que fica), inserir:

```markdown
### 2b. Triar (opcional, precisa de `GEMINI_API_KEY`)

```bash
pnpm decupa triage --index <pasta>/out/speech_index.json --video <vídeo> --out <pasta>/out
```

Devolve um keep-list proposto e `out/triage.md` com o que foi dropado, por
quê, e **quais alegações do modelo foram rejeitadas por não conferirem com o
índice**. Leia as rejeitadas: elas dizem onde o modelo estava errado, o que é
o melhor sinal que existe de que ele pode estar errado em outro lugar também.

O keep-list que sai daqui é ponto de partida do passo 3, não substituto dele.
A verificação rejeita alegação impossível; ela não certifica alegação correta.
Um pré-rolo grande demais que engula a frase de abertura passa na verificação
e só aparece na leitura da prosa, no passo 5.
```

E no passo 3, trocar a abertura "Monte uma lista de unidades a manter (`keep`)"
por "Monte ou ajuste a lista de unidades a manter (`keep`)".

- [ ] **Step 5: Commit**

```bash
git add docs/skills/limpar-fala/SKILL.md
git commit -m "docs(limpar-fala): passo de triagem semântica antes da decisão editorial"
```

---

## Auto-revisão do plano

**Cobertura do spec:**

| Requisito do spec | Task |
|---|---|
| Similaridade própria, Dice de bigrama, limiar 0.8 | 1 |
| Tipos e leitura do índice, `topic_runs` | 2 |
| Quatro regras de verificação | 3 |
| Ordem de avaliação em duas etapas | 3 |
| Verificação rejeita mas não certifica (documentado) | 3, 7, 10 |
| Keep-list em faixas | 4 |
| IDs nunca tempo | 5 (prompt + teste), 8 (schema sem campo de tempo) |
| Interface injetável + fake com respostas erradas | 5, 9 |
| Passe 2 só com alvo | 6, 9 |
| Cache por hash, passe na chave | 7 |
| Relatório com aceitas e rejeitadas | 7 |
| Adaptador Gemini, agentic, temperatura 0 | 8 |
| Degradação sem `GEMINI_API_KEY` | 8 |
| Comando CLI | 9 |
| Aceitação contra `u005-u031 u038-u041` | 10 |

**Consistência de tipos:** `StructureClaim` usa `unit_ids`/`restated_by` (snake_case) porque é o que atravessa a fronteira JSON com o modelo; o resto do código é camelCase. `SpeechIndex` expõe `topicRuns`/`losslessFloorSeconds` em camelCase, convertidos no parse. `Verdict` é união discriminada por `accepted`, e todo teste que lê `.failed` estreita antes.

**Lacuna conhecida, deliberada:** `apps/cli/src/triage.ts` tem uma anotação de tipo desajeitada na variável `density`. Se o typecheck reclamar, declarar `let density: ReportInput["density"] = null` e importar `ReportInput` de `@decupa/triage` — já está exportado na Task 8.
