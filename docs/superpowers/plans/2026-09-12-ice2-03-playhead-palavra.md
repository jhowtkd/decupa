# ICE-2 #03 — Playhead pinta a palavra na prosa

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Durante a reprodução, a palavra cujo intervalo de montagem contém o playhead recebe classe `ativa` na prosa — critério 2 da spec texto-centrada.

**Architecture:** A faixa já assina `"playhead"` (`sequencia.js:327`). `texto.js` só assina `project`/`selection`. Extrair função pura `wordAtPlayhead` em `montage.js` (testável sem DOM); `texto.js` assina o playhead e marca o botão `.word`.

**Tech Stack:** JS puro do editor, vitest. Sem DOM nos testes novos.

**Base:** `403bcf8`. **Donos:** `editor/montage.js`, `editor/montage.test.ts`, `editor/texto.js`.

## Global Constraints

- Não reescrever o render da prosa. Só assinar playhead e togglar classe.
- Sem dependência nova. `git add` só destes arquivos.

---

### Task 1: `wordAtPlayhead` + assinatura no texto

**Files:**
- Modify: `apps/cli/src/app/assembly/editor/montage.js`
- Modify: `apps/cli/src/app/assembly/editor/texto.js` (final do `mount`, após os `subscribe` existentes)
- Test: `apps/cli/src/app/assembly/editor/montage.test.ts`

**Step 1: Escrever o teste que falha**

Em `montage.test.ts`, acrescentar `wordAtPlayhead` ao import de `./montage.js`. No final do arquivo (o helper `project()` já existe):

```ts
it("wordAtPlayhead devolve a palavra cujo intervalo de montagem contém o tempo", () => {
  const p = project();
  // w1 [0.1, 0.4] é a primeira retida; montageTimeOfWord(w1) == 0.1
  const hit = wordAtPlayhead(p, 0.2);
  expect(hit).toEqual({ sceneId: "s1", takeId: "t1", wordId: "w1" });
  expect(wordAtPlayhead(p, 0.0)).toBeNull();
  expect(wordAtPlayhead(p, 1.15)?.wordId).toBe("w4");
  expect(wordAtPlayhead(p, null)).toBeNull();
});
```

**Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/editor/montage.test.ts`

Expected: FAIL — `wordAtPlayhead` não exportada.

**Step 3: Implementar a função pura**

No final de `montage.js`:

```js
/**
 * Palavra retida sob o playhead da montagem (pura). Usa o mesmo eixo de
 * montageTimeOfWord: a prosa acende o botão cujo intervalo contém t.
 */
export function wordAtPlayhead(project, playhead) {
  if (typeof playhead !== "number" || !Number.isFinite(playhead) || !project) return null;
  let best = null;
  let bestStart = -Infinity;
  for (const scene of project.scenes) {
    for (const take of scene.takes) {
      for (const word of takeWords(project, scene, take)) {
        if (word.removed) continue;
        const start = montageTimeOfWord(project, scene.id, take.id, word);
        if (start == null) continue;
        const srcStart = word.cutStart ?? word.start;
        const srcEnd = word.cutEnd ?? word.end;
        const end = start + Math.max(0, srcEnd - srcStart);
        if (playhead >= start && playhead < end && start >= bestStart) {
          best = { sceneId: scene.id, takeId: take.id, wordId: word.id };
          bestStart = start;
        }
      }
    }
  }
  return best;
}
```

**Step 4: Ligar no `texto.js`**

1. No import de `./montage.js`, acrescentar `wordAtPlayhead`.
2. Depois dos `state.subscribe("selection", ...)` existentes (~linha 730), antes de `const el = root();`:

```js
  function paintPlayhead(playhead) {
    const el = root();
    if (!el) return;
    const hit = wordAtPlayhead(state.get("project"), playhead);
    for (const btn of el.querySelectorAll("button.word")) {
      const on = hit
        && btn.dataset.scene === hit.sceneId
        && btn.dataset.take === hit.takeId
        && btn.dataset.wordId === hit.wordId;
      btn.classList.toggle("ativa", !!on);
    }
  }
  state.subscribe("playhead", (t) => paintPlayhead(t));
```

Não adicionar CSS novo se `.ativa` já existir na faixa; se a prosa precisar de contraste, em `page.css` (NÃO neste plano — a classe sozinha basta para o teste de contrato; estilo visual é Task 12). Se `.word.ativa` não existir, o toggle ainda é observável no DOM.

**Step 5: Testes, typecheck, commit**

Run: `npx vitest run apps/cli/src/app/assembly/editor/montage.test.ts apps/cli/src/app/assembly/editor/texto.test.ts`

Expected: PASS.

Run: `pnpm run typecheck`

```bash
git add apps/cli/src/app/assembly/editor/montage.js apps/cli/src/app/assembly/editor/montage.test.ts apps/cli/src/app/assembly/editor/texto.js
git commit -m "feat: highlight the spoken word in prose from the playhead"
```
