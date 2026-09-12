# ICE-2 #06 — Exportação não engole falha de loadProject

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Se `project.json` estiver ausente ou ilegível no meio da exportação, `exportApproved` falha; não entrega snapshot em memória.

**Architecture:** `export.ts:125-133` relança só `revisão mudou durante`; qualquer outro erro do `loadProject` (ENOENT, JSON, validação) é engolido. `projectWithMedia` nos testes **não** grava `project.json`, então o caminho feliz atual depende desse swallow.

**Tech Stack:** TypeScript, vitest, helper `projectWithMedia` já em `export.test.ts`.

**Base:** `403bcf8`. **Donos:** `export.ts` (catch), `export.test.ts`.

## Global Constraints

- Não mudar o restante da exportação (tmp/rename R4).
- Sem dependência nova. `git add` só destes arquivos.

---

### Task 1: Relançar erro de loadProject

**Files:**
- Modify: `apps/cli/src/app/assembly/export.ts:125-133`
- Test: `apps/cli/src/app/assembly/export.test.ts`

**Step 1: Escrever o teste que falha**

`createProject` está em `./store.ts`. Importar no topo de `export.test.ts`. No final do arquivo:

```ts
import { createProject } from "./store.ts";

it("recusa export se o projeto em disco estiver ausente ou ilegível", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 10);
  await expect(exportApproved(project, dir)).rejects.toThrow();
});

it("exporta quando o project.json da mesma revisão está íntegro", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 10);
  await createProject(dir, project);
  const dest = await exportApproved(project, dir);
  expect(dest).toContain("exports");
});
```

Junte o import de `createProject` no topo, não no meio.

O primeiro teste reproduz o estado atual dos outros testes (sem `project.json`): hoje a exportação **passa**. Depois da correção, os testes antigos que chamam `exportApproved` **sem** `createProject` também vão falhar — atualize **somente esses** para gravar o projeto com `createProject(dir, project)` antes de exportar. Não altere asserts de conteúdo.

**Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/export.test.ts -t "ausente ou ilegível"`

Expected: FAIL — a exportação resolve em vez de rejeitar.

**Step 3: Relançar**

Substituir o `catch` em `export.ts:131-133`:

```ts
  try {
    const fresh = await loadProject(dir);
    if (fresh.revision !== project.revision) {
      throw new Error(`revisão mudou durante a exportação: base ${project.revision}, atual ${fresh.revision}`);
    }
  } catch (err) {
    if (err instanceof Error && /mudou durante/.test(err.message)) throw err;
    throw err instanceof Error ? err : new Error(String(err));
  }
```

Equivalente e mais claro:

```ts
  const fresh = await loadProject(dir);
  if (fresh.revision !== project.revision) {
    throw new Error(`revisão mudou durante a exportação: base ${project.revision}, atual ${fresh.revision}`);
  }
```

(o try/catch deixa de existir; `loadProject` propaga.)

**Step 4: Ajustar testes pré-existentes e passar**

Run: `npx vitest run apps/cli/src/app/assembly/export.test.ts`

Expected: os casos antigos de sucesso falham com ENOENT/`project.json`. Em cada um que chama `exportApproved` com sucesso, acrescente `await createProject(dir, project)` (ou `saveProject` se o projeto já existir) **depois** de montar `project` e **antes** do export. Casos que já esperam throw (mídia ausente, hash divergente) não precisam de `project.json` se o throw acontece **antes** do `loadProject` — confira a ordem no código: `loadProject` é depois de `verifySourceIdentity`. Mídia ausente estoura antes; esses testes ficam iguais.

**Step 5: Typecheck e commit**

Run: `pnpm run typecheck`

```bash
git add apps/cli/src/app/assembly/export.ts apps/cli/src/app/assembly/export.test.ts
git commit -m "fix: fail export when on-disk project cannot be reloaded"
```
