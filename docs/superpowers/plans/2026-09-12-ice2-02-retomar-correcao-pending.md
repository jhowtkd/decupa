# ICE-2 #02 — Retomar correção pending após restart

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Correção `pending` não fica eterna: erro não-CAS vira `error` visível; `GET /project` relança o alinhamento se não houver job neste processo.

**Architecture:** Espelhar a reconciliação de preparação órfã. `publishCorrection` hoje `return` em qualquer erro que não seja `revisão desatualizada` e, após 3 CAS, só faz `console.warn`. `alignCorrectionJob` tem `catch {}`. `GET /project` não olha `corrections`. Um Set module-level evita relançar o mesmo id.

**Tech Stack:** TypeScript, vitest, `startApp` HTTP como nos testes de `routes.test.ts`. Sem WhisperX live: fonte inexistente faz o job falhar e publicar `error`.

**Base:** `403bcf8`. **Donos:** `routes.ts` **exceto** `applyCanvasFrom` (plano 07) e `routes.test.ts` (só testes novos no final).

## Global Constraints

- Não editar o corpo de `applyCanvasFrom` (linhas 325-333).
- Sem dependência nova, sem chamada paga, sem `.gitignore`.
- `git add` só dos arquivos deste plano.

---

### Task 1: Erro não-CAS assenta `error`; GET retoma pending

**Files:**
- Modify: `apps/cli/src/app/assembly/routes.ts` (`publishCorrection`, `alignCorrectionJob`, handler `GET /project`)
- Test: `apps/cli/src/app/assembly/routes.test.ts` (final do arquivo)

`publishCorrection` e `blankProject` já são exportados. `startApp` já é usado no teste da preparação órfã.

**Step 1: Escrever os testes que falham**

No final de `routes.test.ts` (imports `createProject`, `loadProject`, `blankProject`, `publishCorrection`, `startApp`, `fixtureAssembly` já existem):

```ts
it("publishCorrection assenta error quando o save não é conflito de revisão", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-corr-err-"));
  const p = blankProject("p1");
  p.assembly.sources.push({ ...fixtureAssembly().sources[0]!, id: "src1" });
  p.corrections.push({
    id: "corr-1", sourceId: "src1", start: 0, end: 1, text: "certa", status: "pending", words: [],
  });
  await createProject(dir, p);
  await publishCorrection(dir, 0, "corr-1", {
    words: [{ text: "certa", start: 0, end: 1, confidence: 0.95, cutStart: -1, cutEnd: 1 }],
  });
  const final = await loadProject(dir);
  const corr = final.corrections.find((c) => c.id === "corr-1");
  expect(corr?.status).toBe("error");
  expect(corr?.error?.length).toBeGreaterThan(0);
});

it("GET /project relança pending órfão e assenta error se a fonte falhar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decupa-corr-resume-"));
  const p = blankProject("p1");
  p.assembly.sources.push({ ...fixtureAssembly().sources[0]!, id: "src1" });
  p.corrections.push({
    id: "corr-stale", sourceId: "src1", start: 0, end: 1, text: "certa", status: "pending", words: [],
  });
  await createProject(dir, p);
  const app = await startApp({ projectDir: dir, port: 0 });
  stop = app.close;
  await fetch(`http://127.0.0.1:${app.port}/project`);
  let settled: { status?: string } | undefined;
  for (let i = 0; i < 50 && !settled; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const body = await (await fetch(`http://127.0.0.1:${app.port}/project`)).json() as {
      project: { corrections: { id: string; status: string }[] };
    };
    const corr = body.project.corrections.find((c) => c.id === "corr-stale");
    if (corr && corr.status !== "pending") settled = corr;
  }
  expect(settled?.status).toBe("error");
});
```

O primeiro teste usa `cutStart: -1`, que `validateWord` recusa: hoje o `saveProject` lança, o catch engole, status segue `pending`.

**Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/routes.test.ts -t "pending órfão|save não é conflito"`

Expected: FAIL — status continua `"pending"`.

**Step 3: Implementar**

1. Perto do topo de `routes.ts` (após imports), um Set de jobs vivos:

```ts
const alignActive = new Set<string>();
function alignKey(dir: string, correctionId: string): string {
  return `${dir}\0${correctionId}`;
}
```

2. Substituir o `catch` interno de `publishCorrection` (hoje `return` se não for CAS) e o aviso após 3 tentativas:

```ts
export async function publishCorrection(
  dir: string,
  _expectedRevision: number,
  correctionId: string,
  outcome: AlignmentOutcome,
): Promise<void> {
  const settleError = async (message: string) => {
    const fresh = await loadProject(dir);
    const pending = fresh.corrections.find((item) => item.id === correctionId);
    if (!pending || pending.status !== "pending") return;
    await saveProject(dir, fresh.revision, (current) => {
      const correction = current.corrections.find((item) => item.id === correctionId);
      if (!correction || correction.status !== "pending") return current;
      return settleCorrection(current, correctionId, { error: message });
    });
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fresh = await loadProject(dir);
      const correction = fresh.corrections.find((item) => item.id === correctionId);
      if (!correction || correction.status !== "pending") return;
      await saveProject(dir, fresh.revision, (current) => {
        try {
          return settleCorrection(current, correctionId, outcome);
        } catch (err) {
          return settleCorrection(current, correctionId, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      return;
    } catch (err) {
      if (err instanceof Error && /revisão desatualizada/.test(err.message)) continue;
      await settleError(err instanceof Error ? err.message : String(err)).catch(() => undefined);
      return;
    }
  }
  await settleError("correção não aplicada após 3 tentativas de rebase concorrente").catch(() => undefined);
}
```

3. Em `alignCorrectionJob`, envolver o corpo com o Set e **não** engolir o erro de publicação:

```ts
async function alignCorrectionJob(
  dir: string,
  correctionId: string,
  expectedRevision: number,
): Promise<void> {
  const key = alignKey(dir, correctionId);
  if (alignActive.has(key)) return;
  alignActive.add(key);
  try {
    // ... corpo atual inalterado até o último publishCorrection ...
  } catch (err) {
    await publishCorrection(dir, expectedRevision, correctionId, {
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => undefined);
  } finally {
    alignActive.delete(key);
  }
}
```

Manter o `try/catch` do `alignText` que já publica `error`. Trocar só o `catch {}` externo.

4. No handler `GET /project`, **depois** do bloco de preparação órfã e **antes** de `sendJson`, sem mexer em `applyCanvasFrom`:

```ts
        for (const correction of project.corrections) {
          if (correction.status === "pending" && !alignActive.has(alignKey(dir, correction.id))) {
            void alignCorrectionJob(dir, correction.id, project.revision);
          }
        }
```

**Step 4: Rodar os testes de routes**

Run: `npx vitest run apps/cli/src/app/assembly/routes.test.ts`

Expected: PASS, inclusive o rebase já existente e a preparação órfã.

**Step 5: Typecheck e commit**

Run: `pnpm run typecheck`

```bash
git add apps/cli/src/app/assembly/routes.ts apps/cli/src/app/assembly/routes.test.ts
git commit -m "fix: resume orphan pending corrections and surface non-CAS publish errors"
```
