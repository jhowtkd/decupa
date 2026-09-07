# Endurecimento do Decupa — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tirar do Decupa as dez fragilidades que hoje moram no ambiente e não no algoritmo — a começar pela mais cara: o suporte a PT-BR do motor de condense existe só como modificação não commitada dentro de um clone que está no `.gitignore`.

**Architecture:** Dez tarefas independentes, cada uma com seu ciclo de teste e seu commit. Nenhuma muda o comportamento editorial do corte: o keep-list produzido antes e depois deste plano é o mesmo. O que muda é o que acontece quando o ambiente falha — patch perdido, rede pendurada, cwd errado, chave ausente, processo reiniciado. Quatro tarefas criam módulos novos (`app/session.ts`, `http/origin.ts`, `triage/provider.ts`, `condense/run.ts`) porque a lógica que elas adicionam precisa ser testável sem subir servidor nem chamar rede — o mesmo padrão que `review.ts`, `edl.ts` e `keeplist.ts` já seguem.

**Tech Stack:** TypeScript ESM rodado com `node --experimental-strip-types`, vitest 4, pnpm workspaces, Python 3.11/3.12 nos sidecars via uv, GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-09-04-app-limpeza-design.md](../specs/2026-09-04-app-limpeza-design.md) e [docs/superpowers/specs/2026-09-04-triagem-semantica-design.md](../specs/2026-09-04-triagem-semantica-design.md). Estas tarefas não alteram nenhuma decisão daqueles designs; três delas fecham dívidas que os próprios designs registraram como deliberadas. A origem das dez está na seção **Origem** abaixo, e é o que faz este plano se sustentar sozinho.

## Global Constraints

- **Node >= 22** (`package.json:engines`). O CLI roda com `--experimental-strip-types`, que é *strip-only*: nada de `enum`, `namespace`, decorator ou parameter property (`constructor(private x: T)`). O vitest transpila com esbuild e aceita todas elas — a suíte fica verde enquanto `decupa limpar` morre no import. A guarda é [apps/cli/src/strip-types.test.ts](../../../apps/cli/src/strip-types.test.ts) e ela **tem** que continuar passando.
- **pnpm 10.32.1** (`packageManager`). Nada de `npm install`.
- **Comentários, mensagens de erro e texto de tela em português**, como o resto do repo. Comentário explica *por quê*, não *o quê*.
- **Testes ao lado do fonte** como `<módulo>.test.ts`, rodados com `pnpm test`. Teste de integração que precisa do motor vai em `tests/`.
- **Nenhuma etapa falha em silêncio devolvendo resultado vazio.** É o modo de falha que a triagem já expôs: resposta vazia lida como "nada a cortar" é indistinguível de análise que rodou e não achou problema.
- **O modelo nunca emite tempo.** Nada neste plano toca nessa fronteira, e nada deve passar a tocar.
- **Não mexer no comportamento do corte.** Se `pnpm test` acusar diferença em `packages/triage/src/mechanical.gold.test.ts`, a mudança está errada — esse teste congela o keep-list do material do ritmo.
- **Um commit por tarefa**, mensagem em conventional commits com escopo (`feat(app):`, `fix(triage):`, `chore(ci):`, `test(engine):`). Commit feito por agente leva o trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Rodar `pnpm test` e `pnpm typecheck` antes de cada commit.** Linha de base atual: 46 arquivos, 428 testes, ~16 s, typecheck limpo.

## Origem

Levantamento ICE de 2026-09-06 sobre o repositório inteiro. Cada linha é evidência verificada no código, não impressão:

| # | Problema | Evidência |
|---|---|---|
| 1 | O suporte PT-BR do motor é uma modificação não commitada num clone gitignorado | `git -C work/video-agent-kit-plugin status` → ` M mcp/ve_tools/condense_lang.py`, 110 inserções |
| 2 | O keep-list — a única parte cara e humana — só existe em memória | `JobStore` é `Map` em memória; `server.ts` só escreve `corte.edl` |
| 3 | Nada roda a suíte automaticamente | não existe `.github/` |
| 4 | O pipeline invoca o motor por caminho relativo ao cwd | `pipeline.ts:134` `join("services","vision")`, `:157` `"scripts/condense.py"` |
| 5 | Chamada de LLM sem teto de tempo | `zai.ts:199` e `:269`, `fetch` sem `AbortSignal` |
| 6 | Default `gemini` num projeto que usa Z.ai | `index.ts:236` e `server.ts:110`, `?? "gemini"` |
| 7 | O gold roda sobre índice congelado; produção pode degradar com a suíte verde | comentário de `enginePatchError`, `pipeline.ts:277-306` |
| 8 | `transcribe()` aceita `language`, o CLI nunca passa | `index.ts:159-218` expõe só `--input/--out/--model/--no-trim` |
| 9 | Bind em 127.0.0.1 protege da rede, não do navegador | `server.ts`, nenhuma checagem de `Origin` |
| 10 | Etapa longa sem sinal de vida | lacuna registrada no plano do app: "`runRender` não reporta progresso" |

## Estrutura de arquivos

| Arquivo | Responsabilidade | Tarefa |
|---|---|---|
| `scripts/engine/pt-br-lexicon.patch` | O patch de léxico PT-BR do motor, versionado. Artefato, não código. | 1 |
| `scripts/setup-engine.sh` | Instala o motor no commit pinado com o patch aplicado. Idempotente. | 1 |
| `apps/cli/src/app/session.ts` | Keep-list em disco: ler, gravar, escolher o inicial. Puro sobre string + fs. | 2 |
| `.github/workflows/ci.yml` | typecheck + suíte em cada push e PR. | 3 |
| `packages/triage/src/provider.ts` | Qual provedor responde, resolvido pela chave presente. Puro. | 6 |
| `tests/engine-gold.test.ts` | Roda o motor de verdade e congela o que o patch entrega. Pula sem motor. | 7 |
| `apps/cli/src/condense/run.ts` | O comando `condense-prep` como função com dependências injetadas. | 8 |
| `apps/cli/src/http/origin.ts` | Predicado de origem aceita. Puro. | 9 |

Modificados: `apps/cli/src/app/pipeline.ts` (tarefas 1, 4, 6, 10), `apps/cli/src/app/server.ts` (2, 6, 9, 10), `apps/cli/src/app/jobs.ts` (10), `apps/cli/src/app/page.html` (10), `apps/cli/src/index.ts` (6, 8), `apps/cli/src/triage.ts` (6), `packages/triage/src/zai.ts` (5), `packages/triage/src/index.ts` (6).

---

## Task 1: Versionar o patch PT-BR do motor

O patch tem 110 linhas em `mcp/ve_tools/condense_lang.py`: adiciona o ponto ASCII a `_TERMINAL_PUNCT`, ensina `guess_language` a devolver `"pt"`, e traz sete léxicos novos (`FILLERS_HARD_PT`, `FILLERS_SOFT_PT`, `CONNECTIVE_OPENERS_PT`, `ANAPHORA_PT`, `ENUM_*_PT`, `QUESTION_MARKERS_PT`, `VISUAL_REFERENCE_PT`, `_STOP_PT`). Ele existe em um lugar só: o working tree de um clone dentro de `work/`, que está no `.gitignore`. Um `git checkout` nesse clone apaga o projeto.

O `enginePatchError` de hoje confere **uma** das quinze mudanças. Um clone onde alguém restaurou só a pontuação passa no check e continua decidindo por léxico inglês — `né`, `tipo` e `tá` deixam de contar como soft filler, e a triagem perde exatamente o sinal que o passe mecânico consome.

**Files:**
- Create: `scripts/engine/pt-br-lexicon.patch`
- Create: `scripts/setup-engine.sh`
- Modify: `apps/cli/src/app/pipeline.ts:277-306` (`enginePatchError`)
- Test: `apps/cli/src/app/pipeline.test.ts:33-45` (`writeFakeEngine`) e o bloco `describe("enginePatchError")`

**Interfaces:**
- Consumes: nada.
- Produces: `scripts/setup-engine.sh` (executável, idempotente); `enginePatchError(engine: string): Promise<string | null>` com a mesma assinatura e uma condição a mais.

- [ ] **Step 1: Extrair o patch do clone vivo, antes de qualquer outra coisa**

```bash
mkdir -p scripts/engine
git -C "${VE_PLUGIN_ROOT:-work/video-agent-kit-plugin}" diff -- mcp/ve_tools/condense_lang.py \
  > scripts/engine/pt-br-lexicon.patch
wc -l scripts/engine/pt-br-lexicon.patch
```

Esperado: ~140 linhas. **Se sair 0, pare e avise** — significa que o clone já perdeu o patch, e nenhuma das etapas seguintes tem o que versionar. Nesse caso o conteúdo precisa ser reconstruído a partir de outro clone ou de backup antes de seguir.

- [ ] **Step 2: Escrever o instalador**

Criar `scripts/setup-engine.sh`:

```bash
#!/usr/bin/env bash
# Instala o motor de condense no estado exato que o Decupa exige: clone no
# commit pinado, com o patch de léxico PT-BR aplicado.
#
# O patch não está upstream. Sem ele o motor lê o material como inglês: o ponto
# final deixa de fechar frase (quase toda unidade vira "frase inacabada", a
# escolha de retake vira ruído) e "né"/"tipo"/"tá" deixam de ser soft filler.
# Rodar duas vezes não duplica nem falha.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="${VE_PLUGIN_ROOT:-$REPO_ROOT/work/video-agent-kit-plugin}"
REMOTE="https://github.com/jhowtkd/video-agent-kit-plugin.git"
PINNED="d9fe30076c00ce2968d570622dd22ba068337568"
PATCH="$REPO_ROOT/scripts/engine/pt-br-lexicon.patch"

if [ ! -d "$ENGINE/.git" ]; then
  echo "clonando o motor em $ENGINE"
  git clone "$REMOTE" "$ENGINE"
fi

# --force só é seguro porque o patch é reaplicado logo abaixo; é o que torna o
# script idempotente mesmo com o working tree sujo da execução anterior.
if [ "$(git -C "$ENGINE" rev-parse HEAD)" != "$PINNED" ]; then
  git -C "$ENGINE" fetch --quiet origin
  git -C "$ENGINE" checkout --quiet --force "$PINNED"
fi

if git -C "$ENGINE" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "patch PT-BR já aplicado"
else
  git -C "$ENGINE" apply "$PATCH"
  echo "patch PT-BR aplicado"
fi

echo "motor pronto em $ENGINE ($PINNED)"
```

```bash
chmod +x scripts/setup-engine.sh
```

- [ ] **Step 3: Provar que o instalador reconstrói o motor do zero**

```bash
VE_PLUGIN_ROOT=/tmp/motor-teste bash scripts/setup-engine.sh
grep -c "FILLERS_SOFT_PT" /tmp/motor-teste/mcp/ve_tools/condense_lang.py
bash -c 'VE_PLUGIN_ROOT=/tmp/motor-teste bash scripts/setup-engine.sh'
```

Esperado: primeira rodada imprime "patch PT-BR aplicado", `grep -c` devolve pelo menos `2`, segunda rodada imprime "patch PT-BR já aplicado" e sai 0.

- [ ] **Step 4: Escrever o teste que falha — motor com o ponto e sem o léxico**

Em `apps/cli/src/app/pipeline.test.ts`, trocar `writeFakeEngine` por uma versão com o léxico opcional (as chamadas existentes continuam valendo, porque o default é o motor bom):

```ts
/** Motor mínimo: só o que o preflight abre, com o léxico que o teste pede. */
async function writeFakeEngine(
  terminalPunct: string,
  opts: { lexicon?: boolean } = {},
): Promise<string> {
  const engine = await mkdtemp(join(tmpdir(), "motor-"));
  const tools = join(engine, "mcp", "ve_tools");
  await mkdir(tools, { recursive: true });
  await writeFile(join(tools, "condense.py"), "# motor de mentira\n", "utf8");
  const lexicon = opts.lexicon === false
    ? ""
    : 'FILLERS_SOFT_PT = ["tipo", "né", "tá"]\n';
  await writeFile(
    join(tools, "condense_lang.py"),
    `_TERMINAL_PUNCT = "${terminalPunct}"\n_CLAUSE_PUNCT = "，,、；;：:"\n${lexicon}`,
    "utf8",
  );
  return engine;
}
```

E, dentro de `describe("enginePatchError")`, o teste novo:

```ts
it("recusa motor com o ponto mas sem o léxico PT-BR", async () => {
  // O patch são 110 linhas, não uma. Conferir só `_TERMINAL_PUNCT` deixa
  // passar um clone onde alguém restaurou a pontuação e perdeu o resto: o
  // motor volta a decidir por léxico inglês, "né"/"tipo"/"tá" deixam de ser
  // soft filler, e o passe mecânico fica sem o sinal que ele consome.
  const engine = await writeFakeEngine("。．！？!?….", { lexicon: false });
  expect(await enginePatchError(engine)).toMatch(/léxico PT-BR/);
});
```

- [ ] **Step 5: Rodar o teste e ver falhar**

Run: `npx vitest run apps/cli/src/app/pipeline.test.ts -t "sem o léxico"`
Expected: FAIL — `enginePatchError` devolve `null` (o check atual só olha a pontuação), e `expect(null).toMatch(...)` estoura.

- [ ] **Step 6: Implementar a segunda condição**

Em `apps/cli/src/app/pipeline.ts`, dentro de `enginePatchError`, depois do bloco que confere o ponto ASCII e antes do `return null`:

```ts
  // Segunda metade do patch: sem os léxicos, o motor roda o caminho inglês
  // mesmo com a pontuação certa, e a diferença não aparece em nenhum erro —
  // só num corte pior.
  if (!src.includes("FILLERS_SOFT_PT")) {
    return (
      `o motor em ${engine} está sem o léxico PT-BR: falta \`FILLERS_SOFT_PT\` em ` +
      "`mcp/ve_tools/condense_lang.py`. Rode `bash scripts/setup-engine.sh` para " +
      "reinstalar o motor no commit pinado com o patch aplicado."
    );
  }
```

E, na mensagem que já existe para a pontuação, trocar o fim por instrução acionável:

```ts
    return (
      `o motor em ${engine} está sem o patch de pontuação PT-BR: falta o ponto ASCII ` +
      "em `_TERMINAL_PUNCT` (mcp/ve_tools/condense_lang.py). Sem ele o índice marca " +
      "frase inacabada demais e o corte degrada em silêncio. Rode " +
      "`bash scripts/setup-engine.sh` para reinstalar o motor."
    );
```

- [ ] **Step 7: Rodar a suíte inteira**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, com um teste a mais que a linha de base (429).

- [ ] **Step 8: Commit**

```bash
git add scripts/engine/pt-br-lexicon.patch scripts/setup-engine.sh apps/cli/src/app/pipeline.ts apps/cli/src/app/pipeline.test.ts
git commit -m "feat(engine): versiona o patch PT-BR e confere o léxico no preflight"
```

---

## Task 2: Persistir o keep-list e retomar a sessão

Transcrição e índice já ficam em cache no `workDir`; o keep-list, que é o julgamento editorial de quem leu a prosa inteira, some com o processo. Fechar a aba por engano custa a parte que a máquina não refaz.

**Files:**
- Create: `apps/cli/src/app/session.ts`
- Test: `apps/cli/src/app/session.test.ts`
- Modify: `apps/cli/src/app/server.ts` (dentro de `replan` e de `ingest`)
- Test: `apps/cli/src/app/server.test.ts` (um caso novo)

**Interfaces:**
- Consumes: nada de tarefas anteriores.
- Produces: `readKeepList(workDir: string): Promise<string | null>`, `writeKeepList(workDir: string, keepList: string): Promise<void>`, `initialKeepList(saved: string | null, unitIds: string[]): string`, `keepPath(workDir: string): string`.

- [ ] **Step 1: Escrever os testes que falham**

Criar `apps/cli/src/app/session.test.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialKeepList, keepPath, readKeepList, writeKeepList } from "./session.ts";

describe("readKeepList", () => {
  it("devolve null quando não há sessão gravada", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-sess-"));
    expect(await readKeepList(dir)).toBeNull();
  });

  it("faz ida e volta da mesma string que o --keep consome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-sess-"));
    await writeKeepList(dir, "u001-u003 u005");
    expect(await readKeepList(dir)).toBe("u001-u003 u005");
  });

  it("trata arquivo em branco como ausência", async () => {
    // Um keep vazio não é "nada fica": é arquivo truncado. Devolvê-lo faria o
    // ingest planejar com --keep sem faixa nenhuma, e o motor estouraria numa
    // mensagem que não descreve o problema real.
    const dir = await mkdtemp(join(tmpdir(), "decupa-sess-"));
    await writeFile(keepPath(dir), "  \n", "utf8");
    expect(await readKeepList(dir)).toBeNull();
  });
});

describe("initialKeepList", () => {
  it("usa a sessão gravada quando ela existe", () => {
    expect(initialKeepList("u002-u003", ["u001", "u002", "u003"])).toBe("u002-u003");
  });

  it("sem sessão, começa com tudo, da primeira à última unidade", () => {
    expect(initialKeepList(null, ["u001", "u002", "u003"])).toBe("u001-u003");
  });

  it("estoura quando o índice não tem unidade nenhuma", () => {
    expect(() => initialKeepList(null, [])).toThrow(/unidade/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/session.test.ts`
Expected: FAIL — `Cannot find module './session.ts'`.

- [ ] **Step 3: Implementar o módulo**

Criar `apps/cli/src/app/session.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Uma linha, no mesmo formato que o `--keep` do motor consome. */
export const keepPath = (workDir: string) => join(workDir, "keep.txt");

/**
 * O keep-list é a única parte do trabalho que a máquina não refaz. Transcrição
 * e índice ficam em cache no workDir; o julgamento de quem leu a prosa some com
 * o processo. Gravar a string a cada replan custa um write e devolve a sessão
 * inteira ao reabrir o mesmo vídeo.
 */
export async function readKeepList(workDir: string): Promise<string | null> {
  const raw = await readFile(keepPath(workDir), "utf8").catch(() => null);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function writeKeepList(workDir: string, keepList: string): Promise<void> {
  await writeFile(keepPath(workDir), `${keepList.trim()}\n`, "utf8");
}

/** O keep-list com que o job começa: a sessão gravada, ou o vídeo inteiro. */
export function initialKeepList(saved: string | null, unitIds: string[]): string {
  if (saved !== null) return saved;
  if (unitIds.length === 0) {
    throw new Error("índice sem unidade nenhuma — rode `condense.py index` antes");
  }
  return `${unitIds[0]}-${unitIds[unitIds.length - 1]}`;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run apps/cli/src/app/session.test.ts`
Expected: PASS (6 testes).

- [ ] **Step 5: Escrever o teste do servidor**

Em `apps/cli/src/app/server.test.ts`, importar `readFile` de `node:fs/promises` (junto dos imports que já existem) e acrescentar dentro de `describe("startApp")`:

```ts
it("grava keep.txt a cada replan, para a sessão sobreviver ao reinício", async () => {
  const { base, app, dir } = await bootComPlano();
  await fetch(`${base}/jobs/${app.jobId}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keepList: "u002-u003" }),
  });
  expect((await readFile(join(dir, "keep.txt"), "utf8")).trim()).toBe("u002-u003");
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/server.test.ts -t "keep.txt"`
Expected: FAIL com `ENOENT` — o arquivo não existe.

- [ ] **Step 7: Ligar no servidor**

Em `apps/cli/src/app/server.ts`, no import block:

```ts
import { initialKeepList, readKeepList, writeKeepList } from "./session.ts";
```

Dentro de `replan`, logo depois de `store.setReview(job.id, review, keepList);`:

```ts
        // Falhar aqui não pode derrubar o corte que já está na tela: o review
        // é o produto, a sessão em disco é conveniência. Mas também não some
        // em silêncio — vai pelo mesmo canal de aviso que o ingest usa.
        await writeKeepList(workDir, keepList).catch(() => {
          store.setWarning(job.id, "não consegui gravar keep.txt; esta sessão não será retomada");
        });
```

E, em `ingest`, trocar as duas linhas que montam o keep inicial:

```ts
      const index = await readJson(indexPath(pipelineJob)) as { units: { id: string }[] };
      const saved = await readKeepList(workDir);
      await replan(initialKeepList(saved, index.units.map((u) => u.id)));
```

- [ ] **Step 8: Rodar tudo e commitar**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

```bash
git add apps/cli/src/app/session.ts apps/cli/src/app/session.test.ts apps/cli/src/app/server.ts apps/cli/src/app/server.test.ts
git commit -m "feat(app): keep-list em disco, para a sessão sobreviver ao reinício"
```

---

## Task 3: CI que roda typecheck e a suíte

A suíte roda em 16 segundos e está verde; nada a executa automaticamente. Runner tem que ser macOS: `tests/fixtures/global-setup.ts` gera o fixture de fala com `say -v Luciana`, que não existe em Linux. `ffmpeg` não vem instalado no runner e é usado por dez arquivos de teste. Nenhum teste chama `uv` ou WhisperX, então o sidecar não precisa existir no CI.

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `pnpm typecheck` e `pnpm test`, que já existem em `package.json:scripts`.
- Produces: nada que outra tarefa consuma.

- [ ] **Step 1: Confirmar que a suíte não depende de nada além de ffmpeg e say**

```bash
grep -rn '"uv"' --include="*.test.ts" packages apps tests
```

Expected: nenhuma saída. Se aparecer alguma, esse teste precisa de `it.skipIf` antes de o CI existir, senão o workflow nasce vermelho.

- [ ] **Step 2: Escrever o workflow**

Criar `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    # macOS não é preferência: `tests/fixtures/global-setup.ts` gera o fixture
    # de fala com `say`, que só existe aqui. O motor de condense não é clonado
    # no CI — os testes de preflight usam motor falso em tmpdir, e o gold do
    # motor (tests/engine-gold.test.ts) se pula sozinho quando ele falta.
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - name: instalar ffmpeg
        run: brew install ffmpeg

      - uses: pnpm/action-setup@v4
        with:
          version: 10.32.1

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 3: Rodar localmente a mesma sequência, num clone limpo**

```bash
rm -rf /tmp/decupa-ci && git clone . /tmp/decupa-ci && cd /tmp/decupa-ci \
  && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test
```

Expected: PASS. É o que prova que a lista de comandos do workflow está certa e que o lockfile está em dia — `--frozen-lockfile` falha se não estiver. Um clone limpo não tem `work/`, então o gold do motor da Task 7 vai aparecer como pulado, que é o comportamento desejado.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "chore(ci): roda typecheck e a suíte em cada push e PR"
```

---

## Task 4: Pipeline independente do cwd

`pipeline.ts` chama `python3 scripts/condense.py` e `uv run` com `cwd: "services/vision"` — ambos relativos ao `process.cwd()`. O SKILL manda isolar trabalho em `work/<pasta>` exportando `CLAUDE_PROJECT_DIR`; quem rodar `decupa limpar` de dentro dessa pasta recebe um erro de arquivo Python não encontrado, sem relação visível com o que fez. `packages/transcript/src/transcribe.ts` já resolve o seu sidecar por `import.meta.url`; esta tarefa aplica o mesmo padrão.

**Files:**
- Modify: `apps/cli/src/app/pipeline.ts:130-136` (constantes) e todas as chamadas que usam caminho relativo
- Test: `apps/cli/src/app/pipeline.test.ts` (ajustar um caso, acrescentar dois)

**Interfaces:**
- Consumes: `enginePatchError` da Task 1 (sem mudança de assinatura).
- Produces: nenhuma assinatura nova. `ExecCall.cwd` passa a vir absoluto nas chamadas de `pnpm` e do sidecar de visão.

- [ ] **Step 1: Escrever os testes que falham**

Em `apps/cli/src/app/pipeline.test.ts`, acrescentar `isAbsolute` ao import de `node:path` e trocar a asserção de cwd do sidecar dentro do caso "tenta o sidecar de visão com cwd em services/vision":

```ts
    expect(isAbsolute(vis!.cwd!)).toBe(true);
    expect(vis!.cwd!.endsWith(join("services", "vision"))).toBe(true);
```

E acrescentar dois casos em `describe("runPlan")` e `describe("runIngest")`:

```ts
  it("chama o motor por caminho absoluto, não relativo ao cwd", async () => {
    // O SKILL manda rodar de dentro de work/<trabalho> com CLAUDE_PROJECT_DIR
    // apontando pra lá. Caminho relativo transforma isso num ENOENT de Python
    // que não descreve o que a pessoa fez de errado.
    const exec = new FakeExecutor();
    await runPlan(job, "u001-u003", exec);
    const script = exec.calls.at(-1)!.args[0]!;
    expect(isAbsolute(script)).toBe(true);
    expect(script.endsWith(join("scripts", "condense.py"))).toBe(true);
  });
```

```ts
  it("roda o pnpm na raiz do repo, não no cwd de quem chamou", async () => {
    const exec = new FakeExecutor();
    await runIngest(job, exec, () => {});
    const prep = exec.calls.find((c) => c.args.includes("condense-prep"))!;
    expect(prep.cwd).toBeDefined();
    expect(isAbsolute(prep.cwd!)).toBe(true);
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/pipeline.test.ts`
Expected: FAIL em três casos — o script vem como `"scripts/condense.py"`, o cwd do `pnpm` é `undefined` e o do sidecar é relativo.

- [ ] **Step 3: Implementar**

Em `apps/cli/src/app/pipeline.ts`, trocar o import de path e as constantes:

```ts
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
```

```ts
/**
 * apps/cli/src/app -> raiz do repo. O motor, o wrapper e os sidecars são
 * invocados por caminho absoluto porque o cwd do processo não é nosso: o SKILL
 * manda rodar de dentro de work/<trabalho>, e o motor grava onde
 * CLAUDE_PROJECT_DIR aponta. Mesmo padrão de packages/transcript.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CONDENSE = join(REPO_ROOT, "scripts", "condense.py");
const VISION_CWD = join(REPO_ROOT, "services", "vision");
const VISION_SCRIPT = join(VISION_CWD, "visual_index.py");
const SPEECH_SCRIPT = join(REPO_ROOT, "services", "speech", "transcribe.py");
```

Trocar as três ocorrências de `"scripts/condense.py"` (em `runIngest`, `runPlan` e `runRender`) por `CONDENSE`; em `preflight`, trocar `const speechScript = join("services", "speech", "transcribe.py");` por `SPEECH_SCRIPT`. E acrescentar `cwd: REPO_ROOT` às duas chamadas de `pnpm` (`condense-prep` em `runIngest` e `triage` em `runTriage`):

```ts
    await must(exec, {
      command: "pnpm",
      args: ["decupa", "condense-prep", "--input", job.videoPath, "--out", transcriptPath(job)],
      env: envFor(job),
      cwd: REPO_ROOT,
    }, "a transcrição");
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Provar o conserto fora da raiz**

```bash
cd /tmp && node --experimental-strip-types "$OLDPWD/apps/cli/src/index.ts" limpar --input /tmp/nao-existe.mp4; cd -
```

Expected: a mensagem `erro: não consegui ler o vídeo em /tmp/nao-existe.mp4` — o preflight chegou até a checagem do vídeo. Antes desta tarefa, o erro seria sobre `scripts/condense.py` ou `services/speech/transcribe.py` não existirem.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/pipeline.ts apps/cli/src/app/pipeline.test.ts
git commit -m "fix(app): invoca motor e sidecars por caminho absoluto"
```

---

## Task 5: Teto de tempo e um retry nas chamadas da Z.ai

`zai.ts` chama `fetch` sem `AbortSignal` em dois lugares. Conexão pendurada trava a triagem para sempre — e no CLI não existe o `cancel` que o app tem. Os dois métodos de POST são idênticos exceto pelo array de `content`, então o conserto começa unificando-os: um lugar para o timeout, um lugar para o retry.

**Files:**
- Modify: `packages/triage/src/zai.ts:141-300`
- Test: `packages/triage/src/zai.test.ts`

**Interfaces:**
- Consumes: nada de tarefas anteriores.
- Produces: `isRetryable(error: Error): boolean` exportado de `zai.ts`; `ZaiTriageModel` ganha as opções `timeoutMs?: number` (default `120_000`) e `retries?: number` (default `1`).

- [ ] **Step 1: Escrever os testes que falham**

Em `packages/triage/src/zai.test.ts`, acrescentar aos imports `isRetryable` e `ZaiTriageModel`, mais `mkdtemp`/`writeFile`/`tmpdir`/`join`, e escrever:

```ts
/** O adaptador lê o vídeo do disco antes de postar; um arquivo de 3 bytes basta. */
async function videoFalso(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "decupa-zai-"));
  const path = join(dir, "proxy.mp4");
  await writeFile(path, "abc");
  return path;
}

describe("isRetryable", () => {
  it("repete em 429 e em 5xx", () => {
    expect(isRetryable(new Error("HTTP 429 da Z.ai: rate limit"))).toBe(true);
    expect(isRetryable(new Error("HTTP 503 da Z.ai: upstream"))).toBe(true);
  });

  it("repete em timeout e em falha de rede", () => {
    expect(isRetryable(new Error("tempo esgotado depois de 120s esperando a Z.ai"))).toBe(true);
    expect(isRetryable(new Error("fetch failed"))).toBe(true);
  });

  it("não repete o que repetir não conserta", () => {
    // 400 é corpo malformado e 1113 é endpoint errado: tentar de novo só gasta
    // o dobro do tempo para chegar na mesma mensagem.
    expect(isRetryable(new Error("HTTP 400 da Z.ai: bad request"))).toBe(false);
    expect(isRetryable(new Error("a Z.ai recusou a chamada (1113): Insufficient balance"))).toBe(false);
  });
});

describe("ZaiTriageModel — rede", () => {
  it("tenta de novo depois de um 503 e devolve a segunda resposta", async () => {
    let chamadas = 0;
    const fetchImpl = (async () => {
      chamadas += 1;
      if (chamadas === 1) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify(body({ content: '{"claims":[]}' })), { status: 200 });
    }) as unknown as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl });
    await expect(model.structure({ unitsBlock: "u001 oi", videoPath: await videoFalso() }))
      .resolves.toEqual([]);
    expect(chamadas).toBe(2);
  });

  it("estoura dizendo que o tempo esgotou, em vez de esperar para sempre", async () => {
    // Sem teto, uma conexão pendurada trava a triagem inteira — e no CLI não
    // existe o cancel que o app tem.
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      })) as unknown as typeof fetch;
    const model = new ZaiTriageModel({ apiKey: "k", fetchImpl, timeoutMs: 20, retries: 0 });
    await expect(model.structure({ unitsBlock: "u001 oi", videoPath: await videoFalso() }))
      .rejects.toThrow(/tempo esgotado/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run packages/triage/src/zai.test.ts`
Expected: FAIL — `isRetryable` não existe; o teste de 503 recebe o erro do primeiro POST; o de timeout não termina até o `testTimeout` de 60 s.

- [ ] **Step 3: Implementar**

Em `packages/triage/src/zai.ts`, acrescentar perto das outras constantes do topo:

```ts
/**
 * A rede é a única parte deste adaptador que não é determinística. Sem teto, a
 * triagem espera para sempre por uma conexão pendurada; 120 s é folgado para um
 * modelo que pensa antes de responder e curto o suficiente para virar erro
 * enquanto a pessoa ainda está na frente da tela.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Um retry: 429 e 5xx passam, corpo malformado e endpoint errado não. */
export function isRetryable(error: Error): boolean {
  return /HTTP (429|5\d\d)|tempo esgotado|fetch failed|network/i.test(error.message);
}
```

Nos campos da classe, acrescentar `private readonly timeoutMs: number;` e `private readonly retries: number;`, aceitar `timeoutMs?: number` e `retries?: number` nas opções do construtor e atribuir:

```ts
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries ?? 1;
```

Substituir os métodos `post` e `postImages` por um só, e apontar os três chamadores para ele:

```ts
  /** Um POST, com teto de tempo. Sem retry: quem repete é `send`. */
  private async once(content: unknown[]): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content }],
          response_format: { type: "json_object" },
          max_tokens: this.maxTokens,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if ((err as Error)?.name === "TimeoutError") {
        throw new Error(
          `tempo esgotado depois de ${(this.timeoutMs / 1000).toFixed(0)}s esperando a Z.ai`,
        );
      }
      throw err;
    }

    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`HTTP ${res.status} da Z.ai, corpo não-JSON: ${raw.slice(0, 200)}`);
    }
    // readChoice cobre o corpo de erro; o status entra no texto quando não há.
    if (!res.ok && !(parsed as any)?.error) {
      throw new Error(`HTTP ${res.status} da Z.ai: ${raw.slice(0, 200)}`);
    }
    return readChoice(parsed);
  }

  private async send(content: unknown[]): Promise<string> {
    let last: Error | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await this.once(content);
      } catch (err) {
        last = err instanceof Error ? err : new Error(String(err));
        if (!isRetryable(last)) throw last;
      }
    }
    throw last!;
  }
```

`ask` passa a montar o `content` e chamar `send` (o cálculo de `payloadMb` e a dica de corpo grande ficam como estão):

```ts
      return await this.send([
        { type: "video_url", video_url: { url: dataUrl } },
        { type: "text", text: `${instructions}\n\n---\n\n${text}` },
      ]);
```

E `inspect` troca `this.postImages(images, ...)` por:

```ts
    const text = await this.send([
      ...images,
      { type: "text", text: `${INSPECT_INSTRUCTIONS}\n\n${INSPECT_SHAPE}\n\n---\n\nunidade: ${req.unitId}` },
    ]);
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. O teste de timeout deve terminar em menos de um segundo.

- [ ] **Step 5: Commit**

```bash
git add packages/triage/src/zai.ts packages/triage/src/zai.test.ts
git commit -m "fix(triage): teto de tempo e um retry nas chamadas da Z.ai"
```

---

## Task 6: Provedor resolvido pela chave que existe

O default é `gemini` em dois lugares, mas quem responde na prática é a Z.ai. Quem tem só `ZAI_API_KEY` recebe "GEMINI_API_KEY não está setada" — um erro que descreve um provedor que a pessoa nunca escolheu.

**Files:**
- Create: `packages/triage/src/provider.ts`
- Test: `packages/triage/src/provider.test.ts`
- Modify: `packages/triage/src/index.ts` (re-export)
- Modify: `apps/cli/src/index.ts:220-256` (comando `triage`)
- Modify: `apps/cli/src/app/server.ts:110` e a chamada de `runTriage`
- Modify: `apps/cli/src/app/pipeline.ts` (`runTriage`)
- Test: `apps/cli/src/app/pipeline.test.ts`

**Interfaces:**
- Consumes: `REPO_ROOT`/`CONDENSE` da Task 4 (só por conviverem no mesmo arquivo).
- Produces: `type Provider = "gemini" | "zai"`, `resolveProvider(explicit: string | undefined, env?: Record<string, string | undefined>): Provider`. `runTriage(job, exec, provider?: string)` passa a aceitar `provider` opcional.

- [ ] **Step 1: Escrever o teste que falha**

Criar `packages/triage/src/provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveProvider } from "./provider.ts";

describe("resolveProvider", () => {
  it("respeita a escolha explícita mesmo com a outra chave no ambiente", () => {
    expect(resolveProvider("gemini", { ZAI_API_KEY: "z" })).toBe("gemini");
  });

  it("sem flag, quem manda é a chave que existe", () => {
    expect(resolveProvider(undefined, { ZAI_API_KEY: "z" })).toBe("zai");
    expect(resolveProvider(undefined, { GEMINI_API_KEY: "g" })).toBe("gemini");
  });

  it("com as duas chaves, prefere a Z.ai", () => {
    // É a que o projeto usa: o proxy de triagem e os números do SKILL foram
    // medidos nela. Empate resolvido pelo uso real, não por ordem alfabética.
    expect(resolveProvider(undefined, { ZAI_API_KEY: "z", GEMINI_API_KEY: "g" })).toBe("zai");
  });

  it("sem chave nenhuma, nomeia as duas variáveis e o caminho manual", () => {
    expect(() => resolveProvider(undefined, {})).toThrow(/ZAI_API_KEY.*GEMINI_API_KEY/s);
    expect(() => resolveProvider(undefined, {})).toThrow(/na mão/);
  });

  it("recusa provedor que não existe", () => {
    expect(() => resolveProvider("openai", {})).toThrow(/"gemini" ou "zai"/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run packages/triage/src/provider.test.ts`
Expected: FAIL — `Cannot find module './provider.ts'`.

- [ ] **Step 3: Implementar o módulo e re-exportar**

Criar `packages/triage/src/provider.ts`:

```ts
export type Provider = "gemini" | "zai";

/**
 * Qual motor responde. Explícito ganha sempre; sem flag, quem manda é a chave
 * presente no ambiente.
 *
 * O default fixo em "gemini" fazia quem só tem ZAI_API_KEY receber
 * "GEMINI_API_KEY não está setada" — um erro que descreve um provedor que a
 * pessoa nunca escolheu, e que manda investigar a conta errada.
 */
export function resolveProvider(
  explicit: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Provider {
  if (explicit !== undefined) {
    if (explicit !== "gemini" && explicit !== "zai") {
      throw new Error(`--provider aceita "gemini" ou "zai", não "${explicit}"`);
    }
    return explicit;
  }
  if (env.ZAI_API_KEY) return "zai";
  if (env.GEMINI_API_KEY) return "gemini";
  throw new Error(
    "nenhuma chave de triagem no ambiente: sete ZAI_API_KEY ou GEMINI_API_KEY. " +
    "Sem chave a triagem não roda — monte o keep-list na mão e passe direto " +
    "pro `condense.py plan`, que é o caminho que o SKILL documenta.",
  );
}
```

Em `packages/triage/src/index.ts`, acrescentar duas linhas, cada uma no seu
bloco — o arquivo separa `export type` de `export` e essa separação é o que
mantém o import de tipo apagável pelo strip-types:

```ts
export type { Provider } from "./provider.ts";
```

```ts
export { resolveProvider } from "./provider.ts";
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run packages/triage/src/provider.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Escrever o teste do pipeline**

Em `apps/cli/src/app/pipeline.test.ts`, acrescentar `runTriage` ao import de `./pipeline.ts` e escrever um `describe` novo:

```ts
describe("runTriage", () => {
  it("omite --provider quando ninguém escolheu, para o CLI resolver pela chave", async () => {
    // O app tem que subir sem chave nenhuma: triagem é acelerador, não
    // pré-requisito. Fixar "gemini" aqui obrigaria quem usa Z.ai a passar a
    // flag toda vez.
    const exec = new FakeExecutor({ stdout: "keep-list: u001-u003\n" });
    await runTriage(job, exec, undefined);
    const call = exec.calls.find((c) => c.args.includes("triage"))!;
    expect(call.args).not.toContain("--provider");
  });

  it("passa --provider quando a pessoa escolheu", async () => {
    const exec = new FakeExecutor({ stdout: "keep-list: u001-u003\n" });
    await runTriage(job, exec, "zai");
    const call = exec.calls.find((c) => c.args.includes("triage"))!;
    expect(call.args.slice(call.args.indexOf("--provider"))).toEqual(["--provider", "zai"]);
  });
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/pipeline.test.ts -t "runTriage"`
Expected: FAIL — hoje `--provider` entra sempre, com `"gemini"` quando ninguém escolheu.

- [ ] **Step 7: Ligar nas três bordas**

Em `apps/cli/src/app/pipeline.ts`, `runTriage`:

```ts
export async function runTriage(job: PipelineJob, exec: Executor, provider?: string): Promise<string> {
  const proxy = await makeTriageProxy(job, exec);
  const result = await must(exec, {
    command: "pnpm",
    args: [
      "decupa", "triage",
      "--index", indexPath(job), "--video", proxy,
      "--out", join(job.workDir, "out"),
      // Sem escolha explícita, quem resolve é o CLI, pela chave que existe.
      ...(provider ? ["--provider", provider] : []),
    ],
    env: envFor(job),
    cwd: REPO_ROOT,
  }, "a triagem");

  // Daqui para baixo nada muda: o parse do `keep-list:` na saída continua
  // igual, e é ele que devolve a string para a prévia da tela.
  const match = /keep-list:\s*(.+)/.exec(result.stdout);
  if (!match) throw new Error(`a triagem não devolveu keep-list: ${result.stdout.slice(0, 300)}`);
  return match[1]!.trim();
}
```

Em `apps/cli/src/app/server.ts`, trocar a linha 110 por `const provider = opts.provider;` e manter a chamada `runTriage(pipelineJob, exec, provider)` como está.

Em `apps/cli/src/index.ts`, no comando `triage`, substituir o bloco de validação manual:

```ts
    const { resolveProvider } = await import("@decupa/triage");
    let provider;
    try {
      provider = resolveProvider(values.provider);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
```

(o `import` dinâmico segue o que `index.ts` já faz com `./triage.ts`, para quem não usa triagem não precisar do `@google/genai` instalado — a guarda de `strip-types.test.ts` cobre isso.)

- [ ] **Step 8: Rodar tudo e commitar**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

```bash
git add packages/triage/src/provider.ts packages/triage/src/provider.test.ts packages/triage/src/index.ts apps/cli/src/index.ts apps/cli/src/app/server.ts apps/cli/src/app/pipeline.ts apps/cli/src/app/pipeline.test.ts
git commit -m "fix(triage): provedor vem da chave presente, não de um default fixo"
```

---

## Task 7: Gold do motor, rodando o motor de verdade

O `mechanical.gold.test.ts` prova o passe mecânico sobre um `speech_index.json` congelado. Ele não tocaria no chão se o motor voltasse a ler o material como inglês — foi exatamente por isso que a checagem de patch virou preflight, e não teste. Este teste fecha o buraco pelo outro lado: roda `condense.py index` de verdade sobre um transcript sintético e congela três propriedades que **só existem com o patch aplicado**.

**Files:**
- Create: `tests/engine-gold.test.ts`

**Interfaces:**
- Consumes: `scripts/setup-engine.sh` da Task 1 (para reproduzir o estado sem patch), `FIXTURES` de `tests/fixtures/global-setup.ts`.
- Produces: nada que outra tarefa consuma.

- [ ] **Step 1: Escrever o teste**

Criar `tests/engine-gold.test.ts`:

```ts
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "./fixtures/global-setup.ts";

const run = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = process.env.VE_PLUGIN_ROOT ?? join(REPO_ROOT, "work", "video-agent-kit-plugin");
const temMotor = await access(join(ENGINE, "mcp", "ve_tools", "condense.py"))
  .then(() => true, () => false);

/**
 * Fala PT-BR sintética dentro dos 3 s do clip.mp4. Três propriedades de
 * propósito: ponto final (só é terminal com o patch), acento (é o que faz
 * `guess_language` devolver "pt"), e um "tá" solto (só é soft filler no léxico
 * PT). O motor lê qualquer JSON com segments[].words[].{text,start,end}.
 */
const TRANSCRIPT = {
  segments: [
    {
      start: 0.1, end: 1.2,
      text: "Então a gente começa a gravação hoje.",
      words: [
        { text: "Então", start: 0.10, end: 0.35 },
        { text: "a", start: 0.36, end: 0.42 },
        { text: "gente", start: 0.43, end: 0.62 },
        { text: "começa", start: 0.63, end: 0.88 },
        { text: "a", start: 0.89, end: 0.94 },
        { text: "gravação", start: 0.95, end: 1.12 },
        { text: "hoje.", start: 1.13, end: 1.20 },
      ],
    },
    {
      start: 1.6, end: 2.9,
      text: "Tá, então é a informação que a gente precisa, né?",
      words: [
        { text: "Tá,", start: 1.60, end: 1.72 },
        { text: "então", start: 1.73, end: 1.92 },
        { text: "é", start: 1.93, end: 1.98 },
        { text: "a", start: 1.99, end: 2.04 },
        { text: "informação", start: 2.05, end: 2.35 },
        { text: "que", start: 2.36, end: 2.45 },
        { text: "a", start: 2.46, end: 2.51 },
        { text: "gente", start: 2.52, end: 2.68 },
        { text: "precisa,", start: 2.69, end: 2.82 },
        { text: "né?", start: 2.83, end: 2.90 },
      ],
    },
  ],
};

describe.skipIf(!temMotor)("motor de condense — gold do léxico PT-BR", () => {
  it("lê como pt, fecha a frase no ponto e enxerga o soft filler", async () => {
    // Sem o patch: language "en", has_terminal_punct false no ponto ASCII, e
    // disfluency.soft vazio. Os três voltam juntos, e nenhum deles aparece como
    // erro — só como corte pior. É por isso que este teste existe.
    const dir = await mkdtemp(join(tmpdir(), "decupa-motor-"));
    await writeFile(join(dir, "transcript.json"), JSON.stringify(TRANSCRIPT), "utf8");

    await run("python3", [
      join(REPO_ROOT, "scripts", "condense.py"), "index",
      join(FIXTURES, "clip.mp4"), join(dir, "transcript.json"),
    ], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

    const index = JSON.parse(
      await readFile(join(dir, "out", "speech_index.json"), "utf8"),
    ) as {
      language: string;
      units: { text: string; has_terminal_punct: boolean; disfluency: { soft: { phrase: string }[] } }[];
    };

    expect(index.language).toBe("pt");
    expect(index.units[0]!.has_terminal_punct).toBe(true);
    const soft = index.units.flatMap((u) => u.disfluency.soft.map((s) => s.phrase));
    expect(soft.length).toBeGreaterThan(0);
  }, 120_000);
});
```

- [ ] **Step 2: Rodar contra o motor patchado**

Run: `npx vitest run tests/engine-gold.test.ts`
Expected: PASS. Se falhar em `disfluency.soft`, imprima o índice (`cat "$TMPDIR"/decupa-motor-*/out/speech_index.json | python3 -m json.tool | head -80`) e ajuste **apenas essa** asserção para o campo que a saída real mostra — `language` e `has_terminal_punct` são invariantes verificadas na fixture do ritmo e não devem ser afrouxadas.

- [ ] **Step 3: Provar que ele falha sem o patch — que é a razão de existir**

```bash
rm -rf /tmp/motor-sem-patch
git clone https://github.com/jhowtkd/video-agent-kit-plugin.git /tmp/motor-sem-patch
git -C /tmp/motor-sem-patch checkout --quiet d9fe30076c00ce2968d570622dd22ba068337568
VE_PLUGIN_ROOT=/tmp/motor-sem-patch npx vitest run tests/engine-gold.test.ts
```

Expected: FAIL, com `language` vindo `"en"`. Um teste de regressão que nunca foi visto falhando não prova nada.

- [ ] **Step 4: Confirmar que ele se pula sem motor nenhum**

```bash
VE_PLUGIN_ROOT=/tmp/motor-que-nao-existe npx vitest run tests/engine-gold.test.ts
```

Expected: 1 teste pulado, saída verde. É o que mantém o CI da Task 3 utilizável.

- [ ] **Step 5: Commit**

```bash
git add tests/engine-gold.test.ts
git commit -m "test(engine): gold ponta a ponta do léxico PT-BR contra o motor real"
```

---

## Task 8: `--language` no `condense-prep`

`transcribe()` aceita `language`, e o comando nunca passa: o `"pt"` fica cravado no default da ponte. Material em inglês transcreve no idioma errado sem aviso nenhum. Para poder testar isso sem rodar WhisperX, o corpo do comando sai de `index.ts` — que é um `main()` de 310 linhas sem teste — e vira função com dependências injetadas, o mesmo padrão de `pipeline.ts`.

**Files:**
- Create: `apps/cli/src/condense/run.ts`
- Test: `apps/cli/src/condense/run.test.ts`
- Modify: `apps/cli/src/index.ts:159-218` (bloco `condense-prep`) e o texto de `USAGE`

**Interfaces:**
- Consumes: `writeCondenseTranscript` de `./prepare.ts` (já existe).
- Produces: `runCondensePrep(opts: { input: string; out: string; language?: string; model?: string; trim?: boolean }, deps?: CondensePrepDeps): Promise<CondensePrepResult>` com `CondensePrepResult = { segments: number; words: number; trimmedSeconds: number }`.

- [ ] **Step 1: Escrever os testes que falham**

Criar `apps/cli/src/condense/run.test.ts`:

```ts
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Transcript } from "@decupa/transcript";
import { runCondensePrep } from "./run.ts";

const TRANSCRIPT: Transcript = {
  language: "pt",
  tokens: [
    { id: "t0", text: "oi", startMs: 0, endMs: 200, confidence: 0.9, sentenceIndex: 0 },
    { id: "t1", text: "tudo bem?", startMs: 220, endMs: 800, confidence: 0.9, sentenceIndex: 0 },
  ],
};

function deps(capturado: { language?: string; silences: number }) {
  return {
    transcribe: async (o: { input: string; language?: string; model?: string }) => {
      capturado.language = o.language;
      return TRANSCRIPT;
    },
    detectSilence: async () => {
      capturado.silences += 1;
      return [];
    },
  };
}

describe("runCondensePrep", () => {
  it("transcreve em pt quando ninguém pede outra coisa", async () => {
    const capturado = { silences: 0 };
    const out = join(await mkdtemp(join(tmpdir(), "decupa-prep-")), "transcript.json");
    await runCondensePrep({ input: "/vid/aula.mp4", out }, deps(capturado));
    expect(capturado.language).toBe("pt");
  });

  it("passa o idioma pedido adiante", async () => {
    // O motor trata inglês e chinês nativamente; o que é PT-BR é o léxico.
    // Transcrever em pt um material em inglês erra antes de o motor começar.
    const capturado = { silences: 0 };
    const out = join(await mkdtemp(join(tmpdir(), "decupa-prep-")), "transcript.json");
    await runCondensePrep({ input: "/vid/talk.mp4", out, language: "en" }, deps(capturado));
    expect(capturado.language).toBe("en");
  });

  it("--no-trim não chama o detector de silêncio", async () => {
    const capturado = { silences: 0 };
    const out = join(await mkdtemp(join(tmpdir(), "decupa-prep-")), "transcript.json");
    await runCondensePrep({ input: "/vid/aula.mp4", out, trim: false }, deps(capturado));
    expect(capturado.silences).toBe(0);
  });

  it("conta segmentos e palavras do que gravou", async () => {
    const capturado = { silences: 0 };
    const out = join(await mkdtemp(join(tmpdir(), "decupa-prep-")), "transcript.json");
    const result = await runCondensePrep({ input: "/vid/aula.mp4", out }, deps(capturado));
    expect(result.segments).toBe(1);
    expect(result.words).toBe(2);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/condense/run.test.ts`
Expected: FAIL — `Cannot find module './run.ts'`.

- [ ] **Step 3: Implementar**

Criar `apps/cli/src/condense/run.ts`:

```ts
import { detectSilence } from "@decupa/acoustics";
import type { Interval } from "@decupa/core";
import { transcribe, type Transcript } from "@decupa/transcript";
import { writeCondenseTranscript } from "./prepare.ts";

export interface CondensePrepDeps {
  transcribe: (o: { input: string; language?: string; model?: string }) => Promise<Transcript>;
  detectSilence: (o: { input: string; thresholdDb: number; minDurationMs: number }) => Promise<Interval[]>;
}

export interface CondensePrepResult {
  segments: number;
  words: number;
  /** Silêncio devolvido como pausa ao aparar o fim de palavra. */
  trimmedSeconds: number;
}

/**
 * O comando `condense-prep` como função: transcreve, apara o fim de palavra que
 * o alinhador esticou sobre o silêncio, e grava no formato do motor.
 *
 * Dependências injetadas porque o valor de teste está na fiação — idioma que
 * passa adiante, `--no-trim` que realmente pula o detector — e não em rodar
 * WhisperX de novo.
 */
export async function runCondensePrep(
  opts: { input: string; out: string; language?: string; model?: string; trim?: boolean },
  deps: CondensePrepDeps = { transcribe, detectSilence },
): Promise<CondensePrepResult> {
  const transcript = await deps.transcribe({
    input: opts.input,
    language: opts.language ?? "pt",
    model: opts.model,
  });

  // O alinhador estica a última palavra de um segmento sobre o silêncio que vem
  // depois. Sem consertar isso, o motor de corte fica cego para essas pausas e
  // elas sobrevivem inteiras dentro do clipe.
  const silences = opts.trim === false
    ? undefined
    : await deps.detectSilence({ input: opts.input, thresholdDb: -35, minDurationMs: 150 });

  const before = transcript.tokens.reduce((n, t) => n + (t.endMs - t.startMs), 0);
  const converted = await writeCondenseTranscript(transcript, opts.out, { silences });
  const after = converted.segments.reduce(
    (n, s) => n + s.words.reduce((m, w) => m + (w.end - w.start) * 1000, 0),
    0,
  );

  return {
    segments: converted.segments.length,
    words: converted.segments.reduce((n, s) => n + s.words.length, 0),
    trimmedSeconds: silences ? (before - after) / 1000 : 0,
  };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run apps/cli/src/condense/run.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Trocar o bloco do CLI**

Em `apps/cli/src/index.ts`, substituir o corpo do `if (command === "condense-prep")` por:

```ts
    const { values } = parseArgs({
      args: rest,
      options: {
        input: { type: "string" },
        out: { type: "string" },
        model: { type: "string" },
        language: { type: "string" },
        "no-trim": { type: "boolean" },
      },
    });
    if (!values.input || !values.out) {
      console.error("condense-prep precisa de --input e --out");
      return 1;
    }
    const { runCondensePrep } = await import("./condense/run.ts");
    const result = await runCondensePrep({
      input: values.input,
      out: values.out,
      model: values.model,
      language: values.language,
      trim: !values["no-trim"],
    });
    console.log(`${result.segments} segmentos, ${result.words} palavras -> ${values.out}`);
    if (result.trimmedSeconds > 0) {
      console.log(
        `fim de palavra aparado: ${result.trimmedSeconds.toFixed(1)}s de silêncio devolvidos como pausa`,
      );
    }
    return 0;
```

Os imports de `detectSilence`, `transcribe` e `writeCondenseTranscript` no topo de `index.ts` ficam sem uso — remover os três (o `typecheck` não reclama de import morto, mas `strip-types.test.ts` importa o arquivo de verdade e carregar o pacote de transcrição à toa é custo por nada).

Na string `USAGE`, atualizar a linha do comando:

```
  decupa condense-prep --input <video|wav> --out <transcript.json> [--model small] [--language pt] [--no-trim]
```

- [ ] **Step 6: Rodar tudo e commitar**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

```bash
git add apps/cli/src/condense/run.ts apps/cli/src/condense/run.test.ts apps/cli/src/index.ts
git commit -m "feat(cli): --language no condense-prep, com o comando testável"
```

---

## Task 9: Recusar POST de origem que não é a própria página

Bind em `127.0.0.1` protege da rede, não do navegador: qualquer página aberta na mesma máquina pode fazer POST em `http://127.0.0.1:7788` e disparar render, export ou cancel. O navegador manda `Origin` em toda requisição não-GET, inclusive same-origin — então recusar o que não vem da própria página fecha isso sem UI nova, e cliente de linha de comando, que não manda `Origin` nenhum, continua passando.

**Files:**
- Create: `apps/cli/src/http/origin.ts`
- Test: `apps/cli/src/http/origin.test.ts`
- Modify: `apps/cli/src/app/server.ts` (início do `handle`)
- Test: `apps/cli/src/app/server.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `originAllowed(origin: string | undefined, port: number): boolean`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `apps/cli/src/http/origin.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { originAllowed } from "./origin.ts";

describe("originAllowed", () => {
  it("aceita a própria página, nas duas formas de escrever o host", () => {
    expect(originAllowed("http://127.0.0.1:7788", 7788)).toBe(true);
    expect(originAllowed("http://localhost:7788", 7788)).toBe(true);
  });

  it("aceita quem não manda Origin — curl, fetch de script, o SKILL", () => {
    expect(originAllowed(undefined, 7788)).toBe(true);
  });

  it("recusa outra página aberta na mesma máquina", () => {
    // É a única superfície de ataque real de um servidor em 127.0.0.1: o
    // navegador da própria pessoa, com um site qualquer aberto noutra aba.
    expect(originAllowed("https://exemplo.invalido", 7788)).toBe(false);
    expect(originAllowed("http://127.0.0.1:9999", 7788)).toBe(false);
  });

  it("recusa origem opaca", () => {
    // "null" chega de iframe sandbox e de file://; é origem sem dono.
    expect(originAllowed("null", 7788)).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/http/origin.test.ts`
Expected: FAIL — `Cannot find module './origin.ts'`.

- [ ] **Step 3: Implementar**

Criar `apps/cli/src/http/origin.ts`:

```ts
/**
 * Bind em 127.0.0.1 protege da rede, não do navegador: qualquer página aberta
 * na mesma máquina pode fazer POST em http://127.0.0.1:7788 e disparar render,
 * export ou cancel no material do cliente.
 *
 * O navegador manda `Origin` em toda requisição não-GET, inclusive same-origin,
 * então basta recusar o que não veio da própria página. Ausência de `Origin` é
 * cliente que não é navegador (curl, script) e continua passando — o SKILL
 * documenta chamar estas rotas na mão.
 */
export function originAllowed(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run apps/cli/src/http/origin.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Escrever o teste do servidor**

Em `apps/cli/src/app/server.test.ts`, dentro de `describe("startApp")`:

```ts
it("recusa POST de outra origem, e aceita o da própria página", async () => {
  const { base, app } = await boot();
  const alheio = await fetch(`${base}/jobs/${app.jobId}/cancel`, {
    method: "POST",
    headers: { origin: "https://exemplo.invalido" },
  });
  expect(alheio.status).toBe(403);

  const proprio = await fetch(`${base}/jobs/${app.jobId}/cancel`, {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${app.port}` },
  });
  expect(proprio.status).toBe(200);
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/server.test.ts -t "outra origem"`
Expected: FAIL — o POST alheio devolve 200.

- [ ] **Step 7: Ligar no servidor**

Em `apps/cli/src/app/server.ts`, importar o predicado:

```ts
import { originAllowed } from "../http/origin.ts";
```

Declarar a porta ligada antes do `createServer` (ela só é conhecida depois do `listen`, e o handler só roda depois disso):

```ts
  let boundPort = opts.port ?? 7788;
```

No começo de `handle`, antes de qualquer rota:

```ts
      if (req.method !== "GET" && !originAllowed(req.headers.origin, boundPort)) {
        sendJson(res, { error: "origem não permitida" }, 403);
        return;
      }
```

E, depois do `listen`, onde `port` já é calculado, acrescentar `boundPort = port;` — antes do `if (opts.autoStart !== false) void ingest();`.

- [ ] **Step 8: Rodar tudo e commitar**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

```bash
git add apps/cli/src/http/origin.ts apps/cli/src/http/origin.test.ts apps/cli/src/app/server.ts apps/cli/src/app/server.test.ts
git commit -m "fix(app): recusa POST de origem que não é a própria página"
```

---

## Task 10: Sinal de vida nas etapas longas

A transcrição leva minutos e o render de vídeo longo também. A tela mostra o nome do estágio e nada mais: "travou" e "está trabalhando" são indistinguíveis exatamente nos minutos que importam. O `SpawnExecutor` já acumula stdout e stderr — falta deixá-los passar enquanto acontecem.

**Files:**
- Modify: `apps/cli/src/app/pipeline.ts` (`ExecCall`, `SpawnExecutor`, `FakeExecutor`, `must`, `runIngest`)
- Test: `apps/cli/src/app/pipeline.test.ts`
- Modify: `apps/cli/src/app/jobs.ts` (`Job`, `setStage`, `setProgress`)
- Test: `apps/cli/src/app/jobs.test.ts`
- Modify: `apps/cli/src/app/server.ts` (chamada de `runIngest` e corpo do `GET /jobs/:id`)
- Modify: `apps/cli/src/app/page.html` (`renderProcessing` e o `poll`)
- Test: `apps/cli/src/app/server.test.ts`

**Interfaces:**
- Consumes: `REPO_ROOT` (Task 4) e a assinatura de `runTriage` (Task 6).
- Produces: `ExecCall.onLine?: (line: string) => void`; `FakeExecutor` ganha `lines: string[]`; `runIngest(job, exec, onStage, onLine?)`; `JobStore.setProgress(id: string, line: string): void` e `Job.progress?: string`.

- [ ] **Step 1: Escrever os testes que falham**

Em `apps/cli/src/app/jobs.test.ts`:

```ts
it("mudar de estágio limpa o progresso do estágio anterior", () => {
  // A última linha do WhisperX não descreve o que o índice está fazendo. Deixar
  // ali é pior que não mostrar nada: parece informação atual.
  const store = new JobStore();
  const job = store.create({ videoPath: "/v.mp4", workDir: "/w" });
  store.setProgress(job.id, "97%|=====> | 58/60");
  expect(store.get(job.id)!.progress).toBe("97%|=====> | 58/60");
  store.setStage(job.id, "indexing");
  expect(store.get(job.id)!.progress).toBeUndefined();
});
```

Em `apps/cli/src/app/pipeline.test.ts`, dentro de `describe("runIngest")`:

```ts
it("repassa as linhas do motor para quem quiser mostrar progresso", async () => {
  const exec = new FakeExecutor();
  exec.lines = ["Detectando idioma…", "97%|=====> | 58/60"];
  const linhas: string[] = [];
  await runIngest(job, exec, () => {}, (line) => linhas.push(line));
  expect(linhas).toContain("97%|=====> | 58/60");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/jobs.test.ts apps/cli/src/app/pipeline.test.ts`
Expected: FAIL — `setProgress` não existe; `runIngest` aceita três argumentos.

- [ ] **Step 3: Implementar no executor e no pipeline**

Em `apps/cli/src/app/pipeline.ts`, acrescentar o campo à interface:

```ts
export interface ExecCall {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Chamada a cada linha de stdout/stderr, enquanto o processo roda. É o
   *  único sinal de vida que WhisperX e ffmpeg dão de uma etapa de minutos. */
  onLine?: (line: string) => void;
}
```

No `SpawnExecutor.run`, trocar os dois handlers de dados por versões que quebram em linha:

```ts
      // Buffer por stream: uma linha pode chegar partida em dois chunks, e
      // metade de uma barra de progresso na tela é pior que nenhuma.
      let outRest = "";
      let errRest = "";
      const feed = (chunk: string, rest: string): string => {
        const parts = (rest + chunk).split(/\r?\n|\r/);
        const tail = parts.pop() ?? "";
        for (const line of parts) {
          const clean = line.trim();
          if (clean) call.onLine?.(clean);
        }
        return tail;
      };
      child.stdout?.on("data", (d) => { stdout += String(d); outRest = feed(String(d), outRest); });
      child.stderr?.on("data", (d) => { stderr += String(d); errRest = feed(String(d), errRest); });
```

No `FakeExecutor`, acrescentar o campo e emiti-lo:

```ts
  /** Linhas roteirizadas, emitidas em `onLine` antes de a chamada terminar. */
  lines: string[] = [];
```

```ts
  async run(call: ExecCall): Promise<ExecResult> {
    this.calls.push(call);
    for (const line of this.lines) call.onLine?.(line);
    this.inFlight += 1;
```

Em `must`, repassar o campo — ele já recebe o `ExecCall` inteiro, então nada muda. Em `runIngest`, aceitar e propagar:

```ts
export async function runIngest(
  job: PipelineJob,
  exec: Executor,
  onStage: (stage: "transcribing" | "indexing" | "visual") => void,
  onLine?: (line: string) => void,
): Promise<{ warning?: string }> {
```

e acrescentar `onLine,` às três chamadas dentro dela (`condense-prep`, `index`, e as duas de `runVisualIndex`, que também recebe o parâmetro).

- [ ] **Step 4: Implementar no job store**

Em `apps/cli/src/app/jobs.ts`, acrescentar `progress?: string;` à interface `Job`, e:

```ts
  setStage(id: string, stage: Stage): void {
    // Progresso pertence ao estágio que o produziu: carregá-lo adiante mostra
    // a linha de uma etapa que já acabou como se fosse a atual.
    this.mutate(id, { stage, progress: undefined });
  }

  setProgress(id: string, progress: string): void {
    this.mutate(id, { progress: progress.slice(0, 120) });
  }
```

- [ ] **Step 5: Rodar e ver passar**

Run: `npx vitest run apps/cli/src/app/jobs.test.ts apps/cli/src/app/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 6: Ligar no servidor e na página**

Em `apps/cli/src/app/server.ts`, na chamada dentro de `ingest`:

```ts
      const ingestResult = await runIngest(
        pipelineJob,
        exec,
        (stage) => store.setStage(job.id, stage),
        (line) => store.setProgress(job.id, line),
      );
```

E no corpo do `GET /jobs/:id`, acrescentar o campo:

```ts
          sendJson(res, {
            stage: current.stage, error: current.error, warning: current.warning,
            progress: current.progress,
            keepList: current.keepList, review: current.review,
          });
```

Em `apps/cli/src/app/page.html`, `renderProcessing` passa a receber a linha e mostrá-la abaixo da lista de etapas:

```js
function renderProcessing(stage, progress) {
  setMode("process");
  el("stage").textContent = "";
  const idx = STEPS.findIndex((s) => s[0] === stage);
  const ol = document.createElement("ol");
  ol.className = "steps";
  for (let i = 0; i < STEPS.length; i++) {
    const li = document.createElement("li");
    li.textContent = STEPS[i][1];
    li.className = i < idx ? "done" : i === idx ? "current" : "pending";
    ol.append(li);
  }
  const hint = document.createElement("p");
  hint.className = "process-hint";
  hint.textContent = stage === "transcribing"
    ? "a transcrição leva alguns minutos"
    : "aguardando o motor…";
  const nodes = [ol, hint];
  if (progress) {
    // A última linha do processo, verbatim. Não é barra de progresso: é prova
    // de que ainda está andando, que é a pergunta que a pessoa tem.
    const live = document.createElement("p");
    live.className = "process-hint";
    live.style.fontFamily = "ui-monospace, Menlo, monospace";
    live.textContent = progress;
    nodes.push(live);
  }
  el("prosa").replaceChildren(...nodes);
}
```

E no `poll`, a última linha antes do `setTimeout`:

```js
  renderProcessing(j.stage, j.progress);
```

- [ ] **Step 7: Teste da borda e verificação na tela**

Em `apps/cli/src/app/server.test.ts`, acrescentar ao caso que já confere o conteúdo da página (`"a página mostra aviso do job e separa vai cair de olhe isto"`):

```ts
    expect(html).toContain("j.progress");
```

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

Verificação manual, com material de verdade:

```bash
pnpm decupa limpar --input work/ritmo/proxy.mp4
```

Expected: durante "transcrevendo", a linha do WhisperX aparece embaixo da lista e muda sozinha; ao passar para "medindo", ela some em vez de congelar.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/app/pipeline.ts apps/cli/src/app/pipeline.test.ts apps/cli/src/app/jobs.ts apps/cli/src/app/jobs.test.ts apps/cli/src/app/server.ts apps/cli/src/app/server.test.ts apps/cli/src/app/page.html
git commit -m "feat(app): última linha do processo na tela durante as etapas longas"
```

---

## Verificação final

Depois das dez tarefas, com o motor instalado:

```bash
pnpm typecheck && pnpm test
```

Expected: verde, com aproximadamente 462 testes (428 da linha de base + 34 novos).

```bash
rm -rf /tmp/decupa-fresh && git clone . /tmp/decupa-fresh && cd /tmp/decupa-fresh \
  && pnpm install --frozen-lockfile && bash scripts/setup-engine.sh && pnpm test
```

Expected: verde, **incluindo** `tests/engine-gold.test.ts` — que é a prova de que um clone novo do repositório reconstrói o motor no estado certo sem depender da máquina de ninguém. Era exatamente isso que não existia antes deste plano.
