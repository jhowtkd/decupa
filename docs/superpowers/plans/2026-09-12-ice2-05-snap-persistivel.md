# ICE-2 #05 — Cortes acústicos persistíveis e limitados ao take

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `cutStart`/`cutEnd` nas pausas vizinhas sobrevivem a `saveProject`; remover a primeira palavra de um take não lança.

**Architecture:** `snapWordCuts` empurra `cutStart` para **antes** de `word.start`. `validateWord` recusa isso. `wordIntervalsInTake` lança se o intervalo acústico sai do take. Corrigir validação (limites da **fonte**) e clambar ao take em vez de throw. Não mexer em `routes.ts` (plano 02 cobre pending eterno).

**Tech Stack:** TypeScript, vitest. Funções puras.

**Base:** `403bcf8`. **Donos:** `store.ts` (`validateWord`), `store.test.ts`, `words.ts` (`wordIntervalsInTake`), `words.test.ts`.

## Global Constraints

- Sem dependência nova. `git add` só destes arquivos.
- `cutStart <= word.start <= word.end <= cutEnd` depois do clamp acústico; ambos dentro de `[0, durationSeconds]`.

---

### Task 1: validateWord aceita corte na pausa

**Files:**
- Modify: `apps/cli/src/app/assembly/store.ts:145-152`
- Test: `apps/cli/src/app/assembly/store.test.ts`

`validateWord` **não** é importado no teste hoje. Export já existe. Importar e usar `fixtureAssembly`.

**Step 1: Teste que falha**

No final de `store.test.ts`:

```ts
import { validateWord } from "./store.ts";

it("validateWord aceita cutStart na pausa anterior e recusa fora da fonte", () => {
  const sources = new Map(fixtureAssembly().sources.map((s) => [s.id, s]));
  const word = validateWord({
    id: "w1", sourceId: "a", text: "Nilton", confidence: null,
    start: 1.0, end: 1.5, cutStart: 0.9, cutEnd: 1.5,
  }, sources);
  expect(word.cutStart).toBe(0.9);
  expect(word.cutEnd).toBe(1.5);
  expect(() => validateWord({
    id: "w1", sourceId: "a", text: "x", confidence: null,
    start: 1.0, end: 1.5, cutStart: -0.1, cutEnd: 1.5,
  }, sources)).toThrow(/fonte/);
  expect(() => validateWord({
    id: "w1", sourceId: "a", text: "x", confidence: null,
    start: 1.0, end: 1.5, cutStart: 1.6, cutEnd: 1.7,
  }, sources)).toThrow(/cutStart/);
});
```

Coloque o `import { validateWord }` no topo junto dos outros imports de `./store.ts`, não no meio do arquivo.

**Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/store.test.ts -t "cutStart na pausa"`

Expected: FAIL — `fora do intervalo da palavra`.

**Step 3: Corrigir validateWord**

Substituir o laço `cutStart`/`cutEnd` em `store.ts`:

```ts
  for (const key of ["cutStart", "cutEnd"] as const) {
    if (value[key] === undefined) continue;
    const cut = finiteNumber(value[key], `palavra ${id}.${key}`);
    if (cut < 0 || cut > source.durationSeconds) {
      throw new Error(`palavra ${id}.${key} fora da fonte`);
    }
    if (key === "cutStart" && cut > end) {
      throw new Error(`palavra ${id}.cutStart depois do fim da palavra`);
    }
    if (key === "cutEnd" && cut < start) {
      throw new Error(`palavra ${id}.cutEnd antes do início da palavra`);
    }
    word[key] = cut;
  }
```

**Step 4: Rodar store.test.ts**

Run: `npx vitest run apps/cli/src/app/assembly/store.test.ts`

Expected: PASS.

---

### Task 2: wordIntervalsInTake clamba ao take

**Files:**
- Modify: `apps/cli/src/app/assembly/words.ts` (os dois `if (startRange.start < take.start ... throw)`)
- Test: `apps/cli/src/app/assembly/words.test.ts`

**Step 1: Teste que falha**

No final de `words.test.ts`:

```ts
it("remove a primeira palavra do take clamba o corte acústico ao início do take", () => {
  const p = project();
  p.analyses[0]!.words[0] = { ...p.analyses[0]!.words[0]!, cutStart: 0.0 };
  p.scenes[0]!.takes[0] = { ...p.scenes[0]!.takes[0]!, start: 0.1, end: 2 };
  expect(() => applyTextEdit(p, {
    type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1"],
  })).not.toThrow();
  const removed = applyTextEdit(p, {
    type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1"],
  });
  expect(removed.scenes[0]!.takes[0]!.removed).toEqual([{ start: 0.1, end: 0.4 }]);
});
```

Hoje `wordCutInterval` com `cutStart: 0` produz start 0, take.start é 0.1 → throw `fora do take`.

**Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/words.test.ts -t "clamba o corte acústico"`

Expected: FAIL — `fora do take`.

**Step 3: Clambar**

Nas duas ocorrências em `wordIntervalsInTake` (o `if` do meio do loop e o `if` final), substituir throw por:

```ts
      const start = Math.max(take.start, startRange.start);
      const end = Math.min(take.end, endRange.end);
      if (end <= start) continue;
      ranges.push({ start, end });
```

No loop do meio, o `continue` aplica ao `for` de índices (não criar range vazio). No bloco final, `if (end <= start) return ranges;` em vez de push.

Remover os `throw new Error(\`palavra ${firstWord.id} fora do take ...\`)`.

**Step 4: Rodar words + store**

Run: `npx vitest run apps/cli/src/app/assembly/words.test.ts apps/cli/src/app/assembly/store.test.ts`

Expected: PASS (incluindo fusão de vizinhas já existente).

**Step 5: Typecheck e commit**

Run: `pnpm run typecheck`

```bash
git add apps/cli/src/app/assembly/store.ts apps/cli/src/app/assembly/store.test.ts apps/cli/src/app/assembly/words.ts apps/cli/src/app/assembly/words.test.ts
git commit -m "fix: persist acoustic cutStart/cutEnd and clamp word cuts to the take"
```
