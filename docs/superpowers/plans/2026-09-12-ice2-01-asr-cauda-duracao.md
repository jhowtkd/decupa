# ICE-2 #01 — Cauda ASR além da duração arredondada

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Palavras cujo `end` ultrapassa a duração da fonte por até 1 ms (arredondamento de `durationMs`) entram no catálogo em vez de zerar `wordsStatus`.

**Architecture:** `probe` grava `durationMs = round(seconds*1000)`; `sourceFromFile` usa `durationMs/1000`. WhisperX frequentemente emite `end` 0,1–1 ms além. `wordsFromTranscript` hoje rejeita com `end > durationSeconds` e `wordsFromCache` engole o throw → `wordsStatus: "missing"`. Visual spans já toleram `+ 1e-9`. Aqui: clambar `end` a `durationSeconds` quando o excesso é ≤ 1 ms; excesso maior continua erro.

**Tech Stack:** TypeScript strip-types, vitest. Sem I/O, sem ffmpeg, sem LLM.

**Base:** `403bcf8`. **Donos:** só `apps/cli/src/app/assembly/analysis.ts` e `analysis.test.ts`.

## Global Constraints

- Sem dependência nova, sem chamada paga, sem `.gitignore`.
- Comentários/erros/nomes de teste em pt-BR.
- `git add` só dos arquivos deste plano.
- Intervalos semiabertos `[start, end)`.

---

### Task 1: Tolerar cauda de 1 ms e clambar

**Files:**
- Modify: `apps/cli/src/app/assembly/analysis.ts:105-123`
- Test: `apps/cli/src/app/assembly/analysis.test.ts`

**Step 1: Escrever o teste que falha**

No final de `apps/cli/src/app/assembly/analysis.test.ts`, acrescentar (o helper `fixtureAssembly` e `wordsFromTranscript` já estão importados):

```ts
it("clamba palavra que ultrapassa a duração arredondada por até 1 ms", () => {
  const source = fixtureAssembly().sources[0]!; // durationSeconds: 3
  const words = wordsFromTranscript(source, {
    segments: [{ words: [
      { text: "olá", start: 0.10, end: 0.40 },
      { text: "fim", start: 2.90, end: 3.0004 },
    ] }],
  });
  expect(words).toHaveLength(2);
  expect(words[1]!.text).toBe("fim");
  expect(words[1]!.end).toBe(3);
  expect(words[1]!.start).toBe(2.90);
});

it("continua recusando excesso maior que 1 ms", () => {
  const source = fixtureAssembly().sources[0]!;
  expect(() => wordsFromTranscript(source, {
    segments: [{ words: [{ text: "depois", start: 2.9, end: 3.5 }] }],
  })).toThrow(/intervalo/);
});
```

O teste existente `rejeita palavra sem tempo válido` com `end: 3.5` permanece; o novo só deixa explícito o limiar.

**Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/analysis.test.ts`

Expected: FAIL no teste da cauda 3.0004 (`/intervalo/`).

**Step 3: Implementar o clamp**

Em `apps/cli/src/app/assembly/analysis.ts`, substituir o bloco de validação (linhas 104-114) por:

```ts
      const start = entry.start;
      const endRaw = entry.end;
      if (
        typeof start !== "number" || typeof endRaw !== "number"
        || !Number.isFinite(start) || !Number.isFinite(endRaw)
        || start < 0 || endRaw <= start
      ) {
        throw new Error(
          `palavra "${entry.text}" com intervalo inválido [${String(start)}, ${String(endRaw)}) na fonte ${source.id}`,
        );
      }
      // durationMs é round(s*1000): ASR real frequentemente termina 0,1–1 ms
      // além. Excesso ≤ 1 ms clamba; além disso continua erro (não é arredondamento).
      const slack = 0.001;
      if (endRaw > source.durationSeconds + slack) {
        throw new Error(
          `palavra "${entry.text}" com intervalo inválido [${String(start)}, ${String(endRaw)}) na fonte ${source.id}`,
        );
      }
      const end = Math.min(endRaw, source.durationSeconds);
```

O `flat.push` usa `end` (já clamado), não `endRaw`.

**Step 4: Rodar os testes**

Run: `npx vitest run apps/cli/src/app/assembly/analysis.test.ts`

Expected: PASS, inclusive `rejeita palavra sem tempo válido` (3.5 ainda estoura).

**Step 5: Typecheck e commit**

Run: `pnpm run typecheck`

```bash
git add apps/cli/src/app/assembly/analysis.ts apps/cli/src/app/assembly/analysis.test.ts
git commit -m "fix: clamp ASR word tails that overrun rounded source duration by 1ms"
```
