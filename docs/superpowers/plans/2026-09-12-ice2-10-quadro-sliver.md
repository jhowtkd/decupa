# ICE-2 #10 — Quantização que não some 1 quadro

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fragmento retido cuja duração é ~1 frame na grade da timeline vira 1 frame na montagem, não é descartado por `round(end) === round(start)`.

**Architecture:** `compileScenes` faz `first = round(start)`, `last = round(end)` e `if (last <= first) return`. Em 25 fps, `[0.02, 0.04)` → 0.5 e 1.0 frames → ambos arredondam para 1 → sliver some na prévia/OTIO mas permanece na prosa. Usar `floor` no início e `max(first+1, round(end))` no fim.

**Tech Stack:** TypeScript, vitest, helper `project()` de `scenes.test.ts`.

**Base:** `403bcf8`. **Donos:** `scenes.ts` (laço de `retainedRanges` em `compileScenes`), `scenes.test.ts`.

## Global Constraints

- Não mexer no laço de apoio V2 (já corrigido na ICE-1).
- Sem dependência nova. `git add` só destes arquivos.

---

### Task 1: Sliver de 1 frame sobrevive à compilação

**Files:**
- Modify: `apps/cli/src/app/assembly/scenes.ts:347-364`
- Test: `apps/cli/src/app/assembly/scenes.test.ts`

`compileScenes` usa `scene.takes` quando existem. O helper `project()` já monta `Project`.

**Step 1: Teste que falha**

No final de `scenes.test.ts`:

```ts
it("fragmento de ~1 frame na grade não é descartado na compilação", () => {
  const p = project();
  // 25 fps: 0.02s=0.5f → round 1; 0.04s=1.0f → round 1; last<=first descarta.
  p.scenes = [{
    id: "s1",
    objective: "abrir",
    rationale: "tema",
    speechIds: ["a:u001"],
    takes: [{
      id: "t1", sourceId: "a", speechId: "a:u001",
      start: 0.02, end: 0.04, removed: [], protected: [],
    }],
    visualEvidenceIds: [],
    support: [],
    gaps: [],
  }];
  const compiled = compileScenes(p, p.scenes);
  const v1 = compiled.tracks.find((t) => t.name === "V1")!.clips;
  expect(v1).toHaveLength(1);
  expect(v1[0]!.durationFrames).toBe(1);
  expect(v1[0]!.startFrame).toBe(0);
});
```

**Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/scenes.test.ts -t "1 frame"`

Expected: FAIL — `v1` vazio.

**Step 3: Quantizar sem colapsar**

No `forEach` de `retainedRanges` em `compileScenes`, substituir:

```ts
        const first = toFrames(fragment.start);
        const last = toFrames(fragment.end);
        // Sliver sub-frame não tem frame renderizável: pula sem perder conteúdo.
        if (last <= first) return;
```

por:

```ts
        const first = Math.floor((fragment.start * fpsNum) / fpsDen);
        const lastRounded = Math.round((fragment.end * fpsNum) / fpsDen);
        const last = Math.max(first + 1, lastRounded);
        if (last <= first) return;
```

Manter `toSeconds(first)` em `sourceStartSeconds` e `durationFrames: last - first`. Não alterar o laço de `scene.support`.

**Step 4: Rodar scenes.test.ts**

Run: `npx vitest run apps/cli/src/app/assembly/scenes.test.ts`

Expected: PASS, inclusive apoio no meio da cena (ICE-1).

**Step 5: Typecheck e commit**

Run: `pnpm run typecheck`

```bash
git add apps/cli/src/app/assembly/scenes.ts apps/cli/src/app/assembly/scenes.test.ts
git commit -m "fix: keep one-frame retained fragments when rounding to the timeline grid"
```
