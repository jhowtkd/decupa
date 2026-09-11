# Editor texto-centrado da montagem — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir a tela de montagem (`decupa montar`) pelo editor texto-centrado do spec: rail de projeto permanente, texto como timeline com gestos de edição no ponto, contexto à direita e faixa de sequência-bússola.

**Architecture:** Os motores e rotas continuam; a UI atual (`assembly/page.html|css|js`, 1200 linhas monolíticas) migra incrementalmente para módulos ES vanilla servidos por `/editor/*.js`. O bug bloqueante de recompilação (`/edit` não atualiza o assembly que preview/export renderizam) é corrigido primeiro, na camada de transição de revisão. Lógica pura de montagem ganha módulo próprio com teste de paridade TS↔JS.

**Tech Stack:** Node 22+ com `--experimental-strip-types`, http nativo (sem framework, sem build), vitest, ffmpeg via executor injetado. Testes: `pnpm vitest run <arquivo>`; typecheck: `pnpm typecheck`.

**Spec:** `docs/superpowers/specs/2026-09-11-editor-texto-centrado-design.md` — ler antes de executar qualquer tarefa. O plano argumenta a partir do spec; em caso de dúvida, o spec vence.

## Global Constraints

- Sem framework, sem build step, sem novas dependências (spec, "Organização técnica").
- `decupa limpar` e `apps/cli/src/app/{page.html,server.ts,review.ts,keeplist.js}` não são tocados (spec, "Fora de escopo"). Os testes existentes desses arquivos seguem verdes.
- Todas as strings visíveis ao usuário em pt-BR (padrão do repo).
- Nenhuma chamada paga dispara sem confirmação explícita no lote; 402 por chamada sem permissão segue testado (spec, "Pagos e privacidade").
- Correções de bug e features novas nascem com teste falhando primeiro (TDD).
- Mensagens de commit em inglês no padrão do repo (`feat:`, `fix:`, `docs:`, `test:`).
- Cada tarefa termina com `pnpm vitest run` verde no escopo tocado e commit próprio.

## Mapa dos arquivos

**Back-end (existentes, modificados):**
- `apps/cli/src/app/assembly/revisions.ts` — ganha `applyEdit` (edição + recompilação na mesma revisão).
- `apps/cli/src/app/assembly/routes.ts` — rota `/edit` usa `applyEdit`; serve `/editor/*.js`; ganha rota de peaks.
- `apps/cli/src/app/assembly/preparation.ts` — geração best-effort de peaks na etapa media.
- `apps/cli/src/app/assembly/words.ts`, `types.ts` — intocados, exceto leitura.

**Front-end (novos módulos em `apps/cli/src/app/assembly/editor/`, servidos sem build):**
- `montage.js` — lógica pura de montagem (sem DOM): espelhos testados de `effectiveWords`/`retainedRanges` + `timelineBlocks`.
- `state.js` — store assinável por região.
- `api.js` — cliente HTTP com contagem de ações em voo.
- `rail.js`, `texto.js`, `contexto.js`, `sequencia.js` — as quatro regiões.
- `*.test.ts` — os testes de paridade/lógica pura rodam no vitest como `keeplist.test.ts` já roda.

**Front-end (reescritos):**
- `apps/cli/src/app/assembly/page.html`, `page.css`, `page.js` — a casca de 4 regiões; `page.js` vira bootstrap que importa os módulos.

---

### Task 1: `/edit` recompila o assembly (bug bloqueante)

**Files:**
- Modify: `apps/cli/src/app/assembly/revisions.ts`
- Modify: `apps/cli/src/app/assembly/routes.ts:27` (import) e rota `/edit` (~linha 865)
- Test: `apps/cli/src/app/assembly/revisions.test.ts` (existe; acrescentar caso)
- Test: `tests/assembly-flow.test.ts` (acrescentar fluxo edit→preview→export)

**Interfaces:**
- Consumes: `applyTextEdit(project, action)` de `./words.ts`; `compileScenes(project, scenes)` de `./scenes.ts`; fixture de `./fixture.ts`.
- Produces: `applyEdit(project: Project, action: EditAction): Project` — aplica a ação, bumpa revisão via `invalidatePreview` interno e **recompila** `assembly` com a revisão nova. Exceção: `correct` não move mídia e segue pelo caminho atual (`invalidatePreview` sem recompilar).

- [ ] **Step 1: escrever o teste unitário falhando**

Em `revisions.test.ts`, acrescentar (seguindo o estilo do arquivo; importar `fixtureAssembly` de `./fixture.ts`, tipos de `./types.ts` e `applyEdit` de `./revisions.ts` — se o arquivo já tiver um builder de projeto, reutilize-o no lugar deste inline):

```ts
import { applyEdit } from "./revisions.ts";

function projectWithTake() {
  const assembly = fixtureAssembly();
  const words = [0.1, 0.42, 0.72, 1.0].map((start, i) => ({
    id: `w${i + 1}`, sourceId: "a", text: `p${i + 1}`,
    confidence: null, start, end: start + 0.2,
  }));
  return {
    version: 2 as const, id: "p1", revision: 1,
    input: { kind: "brief" as const, text: "tema", targetSeconds: 2 },
    assembly,
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema", speechIds: ["a:u001"],
      takes: [{ id: "t1", sourceId: "a", speechId: "a:u001", start: 0, end: 2, removed: [], protected: [] }],
      visualEvidenceIds: [], support: [], gaps: [],
    }],
    analyses: [{
      sourceId: "a", key: "k",
      speech: [{ id: "a:u001", sourceId: "a", start: 0, end: 2, text: "fala" }],
      visual: [], status: "ready" as const, words, wordsStatus: "ready" as const,
      visualCoverage: { requested: [], returned: [], missing: [] },
    }],
    proposal: null, previewRevision: null, finalApprovedRevision: null,
    corrections: [], preparation: null,
    permissions: { model: false, visual: false }, previewArtifact: null,
  };
}

it("applyEdit recompila o assembly: remove encurta os clips da revisão nova", () => {
  const before = projectWithTake();
  const audioBefore = before.assembly.tracks.find((t) => t.kind === "Audio")!.clips;
  const after = applyEdit(before, { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1", "w2"] });
  expect(after.revision).toBe(2);
  expect(after.assembly.revision).toBe(2);
  const audioAfter = after.assembly.tracks.find((t) => t.kind === "Audio")!.clips;
  const dur = (clips: { durationFrames: number }[]) => clips.reduce((n, c) => n + c.durationFrames, 0);
  expect(dur(audioAfter)).toBeLessThan(dur(audioBefore));
});

it("applyEdit de move-scene troca a ordem dos clips", () => {
  // monte um projeto com duas cenas s1/s2 (duplique a cena e o take no builder),
  // aplique move-scene down em s1 e ordene os clips por startFrame:
  // o primeiro clip da pista de vídeo agora é da cena s2.
  const p = twoSceneProject(); // helper local no mesmo estilo do builder acima
  const after = applyEdit(p, { type: "move-scene", sceneId: "s1", direction: "down" });
  const v1 = after.assembly.tracks.find((t) => t.kind === "Video")!.clips
    .slice().sort((a, b) => a.startFrame - b.startFrame);
  expect(v1[0]!.sceneId).toBe("s2");
});
```

- [ ] **Step 2: rodar e ver falhar**

Run: `pnpm vitest run apps/cli/src/app/assembly/revisions.test.ts`
Expected: FAIL — `applyEdit` não existe (import quebra) e, após existir, durações iguais às de antes (o assembly fica stale).

- [ ] **Step 3: implementar `applyEdit` em `revisions.ts`**

```ts
import { applyTextEdit, type EditAction } from "./words.ts";

/**
 * Edição aprovada como transição de revisão: aplica a ação por palavra e
 * recompila o assembly na mesma revisão — o texto editado e a timeline que
 * preview/export renderizam nunca divergem. `correct` é overlay de grafia
 * e não move mídia: segue só invalidando a prévia.
 */
export function applyEdit(p: Project, action: EditAction): Project {
  const next = applyTextEdit(p, action);
  if (action.type === "correct") return next;
  return { ...next, assembly: { ...compileScenes(next, next.scenes), revision: next.revision } };
}
```

(Se o arquivo ainda não importa `EditAction`, acrescente ao import de tipos. `compileScenes` já é importado ali.)

- [ ] **Step 4: rodar o teste unitário e ver passar**

Run: `pnpm vitest run apps/cli/src/app/assembly/revisions.test.ts`
Expected: PASS

- [ ] **Step 5: trocar a rota `/edit` para usar `applyEdit`**

Em `routes.ts`, importe `applyEdit` junto de `revisions.ts` e troque **as duas** chamadas de `applyTextEdit` dentro do handler `/edit` (a prévia pura de descoberta do correctionId e o `mutate`) por `applyEdit`. O import atual de `applyTextEdit` de `./words.ts` pode sair se não houver outro uso.

- [ ] **Step 6: teste de contrato HTTP edit→preview→export**

Em `tests/assembly-flow.test.ts`, novo `it` no estilo do fluxo existente (reutilize `indexingAndRender()` e o builder de proposta local; para ter palavras, a análise fake precisa retornar `words` — acrescente ao `INDEX`/analyze do executor fake um `analyses[].words` com ids no formato `a:<sha>:w000001`... simplificação: o teste pode montar takes via proposal com `selections` do `propose` local — se o caminho de proposal não expuser words, construa o take diretamente no body da proposal como o fluxo atual faz com `speechIds`, e depois aplique `/edit remove` usando os wordIds que o `GET /project` reporta em `analyses[].words`; se o executor fake não os produzir, estenda o fake para gravar `words` no speech_index.json que o analysis lê — siga como `analysis.ts` constrói `analyses` a partir do índice). Asserções:

```ts
// após apply da proposta e ANTES de preview:
const before = await (await fetch(`${base}/project`)).json();
const w = before.project.analyses[0].words[0]; // primeira palavra do take aplicado
const edited = await fetch(`${base}/project/edit`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    baseRevision: before.project.revision,
    action: { type: "remove", sceneId: "s1", takeId: before.project.scenes[0].takes[0].id, wordIds: [w.id] },
  }),
});
expect(edited.status).toBe(200);
const after = await edited.json();
// o assembly da resposta já reflete o corte (não espera o preview):
expect(after.project.assembly.tracks.some((t) => t.clips.reduce((n, c) => n + c.durationFrames, 0)
  < before.project.assembly.tracks.find((k) => k.kind === "Video")!.clips.reduce((n, c) => n + c.durationFrames, 0)))
  .toBe(true);
// preview e export da revisão editada usam esse assembly:
expect((await fetch(`${base}/project/preview`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ baseRevision: after.project.revision }) })).status).toBe(200);
expect((await fetch(`${base}/project/export`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ baseRevision: after.project.revision }) })).status).toBe(200);
```

- [ ] **Step 7: rodar o fluxo inteiro**

Run: `pnpm vitest run tests/assembly-flow.test.ts`
Expected: PASS (o teste novo e os existentes)

- [ ] **Step 8: commit**

```bash
git add apps/cli/src/app/assembly/revisions.ts apps/cli/src/app/assembly/revisions.test.ts \
  apps/cli/src/app/assembly/routes.ts tests/assembly-flow.test.ts
git commit -m "fix: edit recompiles the assembly preview and export render"
```

---

### Task 2: servidor entrega os módulos `/editor/*.js`

**Files:**
- Modify: `apps/cli/src/app/assembly/routes.ts` (bloco que serve `page.html|css|js`, ~linhas 490-530)
- Test: `apps/cli/src/app/assembly/routes.test.ts` (padrão existente do arquivo)

**Interfaces:**
- Produces: `GET /editor/<nome>.js` → 200 `text/javascript` para qualquer arquivo `nome.js` (kebab-case) dentro de `apps/cli/src/app/assembly/editor/`; 404 fora do padrão. Mesmo mecanismo de cache em memória do `page.js` (leitura única com `readFile` no startup do handler — siga como `pageCss`/`pageJs` fazem: leitura única no `createAssemblyRuntime`, servida por route).

- [ ] **Step 1: teste de contrato falhando**

Em `routes.test.ts`, no estilo das asserções de página existentes:

```ts
it("serve módulos editor sem build", async () => {
  // app = runtime de teste já usado no arquivo para GET /page.js
  const res = await fetch(`${base}/editor/state.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/javascript");
  const bad = await fetch(`${base}/editor/..%2F..%2Fwords.ts`);
  expect([403, 404]).toContain(bad.status);
});
```

(O caminho exato de montagem do app de teste está no arquivo; siga o teste de `/page.js` existente.)

- [ ] **Step 2: rodar e ver falhar** — `pnpm vitest run apps/cli/src/app/assembly/routes.test.ts` → FAIL 404.

- [ ] **Step 3: implementar**

No `createAssemblyRuntime`, ao lado de `pageJs`:

```ts
const editorFiles = new Map<string, string>();
const serveEditor = (res: ServerResponse, name: string): boolean => {
  if (!/^[a-z0-9-]+\.js$/.test(name)) return false;
  let body = editorFiles.get(name);
  if (body === undefined) {
    try {
      body = readFileSync(join(HERE, "editor", name), "utf8");
    } catch {
      return false;
    }
    editorFiles.set(name, body);
  }
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
  return true;
};
```

E no roteador, antes do 404: `if (parts[1] === "editor" && req.method === "GET" && serveEditor(res, parts[2] ?? "")) return true;` — use `readFile`/async no estilo do arquivo se ele for todo async (`readFileSync` só se o handler já for síncrono nesses pontos; siga o padrão local). O nome do módulo `state.js` ainda não existe — crie um stub para o teste passar:

```js
// apps/cli/src/app/assembly/editor/state.js
export const EDITOR_STUB = true;
```

- [ ] **Step 4: rodar e ver passar** — `pnpm vitest run apps/cli/src/app/assembly/routes.test.ts` → PASS.

- [ ] **Step 5: commit**

```bash
git add apps/cli/src/app/assembly/routes.ts apps/cli/src/app/assembly/routes.test.ts apps/cli/src/app/assembly/editor/state.js
git commit -m "feat: serve editor ES modules without build"
```

---

### Task 3: `montage.js` — lógica pura de montagem com paridade TS↔JS

**Files:**
- Create: `apps/cli/src/app/assembly/editor/montage.js`
- Test: `apps/cli/src/app/assembly/editor/montage.test.ts`

**Interfaces:**
- Produces (usado pelas tarefas 5-8; nomes estáveis):
  - `effectiveWords(project, sourceId): Word[]`
  - `retainedOfTake(take): SourceRange[]` · `retainedDuration(take): number`
  - `takeWords(project, scene, take): {id, sourceId, text, start, end, removed, protected, corrected, takeId, sceneId}[]`
  - `montageTimeOfWord(project, sceneId, takeId, word): number | null`
  - `omittedWords(project, scene, sourceId): Word[]`
  - `timelineBlocks(project): {kind: "scene"|"support", sceneId, label, start, end}[]` + `montageDuration(project): number` (segundos de montagem, falas + apoios: apoio `end = start + offset/duration` em segundos convertidos por fps do assembly)

- [ ] **Step 1: escrever os testes de paridade (falham: módulo vazio)**

`montage.test.ts` importa o módulo JS **e** as funções TS e compara saídas no mesmo fixture (reutilize o builder de `words.test.ts` copiado como helper local — autocontido, sem import de testes):

```ts
import { expect, it } from "vitest";
import { effectiveWords as tsEffective, retainedRanges as tsRetained } from "../words.ts";
import { effectiveWords, retainedOfTake, montageTimeOfWord, timelineBlocks, montageDuration } from "./montage.js";

// builders idênticos aos de words.test.ts (project com 1 cena/1 take/4 palavras)

it("paridade retainedOfTake ↔ retainedRanges (TS)", () => {
  const take = { id: "t1", sourceId: "a", speechId: null, start: 0, end: 2,
    removed: [{ start: 0.4, end: 0.8 }], protected: [] };
  expect(retainedOfTake(take)).toEqual(tsRetained(take));
});

it("paridade effectiveWords (TS)", () => {
  expect(effectiveWords(project(), "a").map((w) => w.id))
    .toEqual(tsEffective(project(), "a").map((w) => w.id));
});

it("montageTimeOfWord soma retidos anteriores", () => {
  // cena s1 take t1 palavra w3 (0.72-0.8) com w1..w2 removidos:
  // t = 0 (retidos anteriores) + (0.72 - 0.7) = 0.02
  expect(montageTimeOfWord(p, "s1", "t1", w3)).toBeCloseTo(0.02, 5);
});

it("timelineBlocks: cena + apoio com tempos de montagem", () => {
  // projeto com 2 cenas; apoio em s2 com offsetFrames 12, durationFrames 50, fps 25/1
  const blocks = timelineBlocks(p2);
  expect(blocks.map((b) => b.kind)).toEqual(["scene", "scene", "support"]);
  const support = blocks[2]!;
  expect(support.start).toBeCloseTo(montageDurationWithoutSupport(p2), 5);
  expect(support.end - support.start).toBeCloseTo(2, 5); // 50 frames / 25 fps
});
```

- [ ] **Step 2: rodar e ver falhar** — `pnpm vitest run apps/cli/src/app/assembly/editor/montage.test.ts` → FAIL (exports indefinidos).

- [ ] **Step 3: implementar `montage.js`**

Mova as funções puras do `page.js` atual (linhas 264-357: `effectiveWords`, `normalizeRanges`, `retainedOfTake`, `retainedDuration`, `montageTimeOfWord`, `omittedWords`, `takeWords` sem DOM) para `montage.js` com `export function ...`, mudando a assinatura para receber `project` como argumento (hoje é closure sobre a global). Acrescente `timelineBlocks`/`montageDuration`:

```js
export function timelineBlocks(project) {
  const blocks = [];
  let cursor = 0;
  for (const scene of project.scenes) {
    let sceneEnd = cursor;
    for (const take of scene.takes) {
      const dur = retainedDuration(take);
      sceneEnd += dur;
    }
    blocks.push({ kind: "scene", sceneId: scene.id,
      label: scene.objective || scene.id, start: cursor, end: sceneEnd });
    const fps = project.assembly.fps.num / project.assembly.fps.den;
    for (const sup of scene.support) {
      const start = cursor + sup.offsetFrames / fps;
      blocks.push({ kind: "support", sceneId: scene.id, label: sup.visualId,
        start, end: start + sup.durationFrames / fps });
    }
    cursor = sceneEnd;
  }
  return blocks;
}
export function montageDuration(project) {
  const blocks = timelineBlocks(project);
  return blocks.reduce((max, b) => Math.max(max, b.end), 0);
}
```

- [ ] **Step 4: rodar e ver passar** — PASS.

- [ ] **Step 5: commit**

```bash
git add apps/cli/src/app/assembly/editor/montage.js apps/cli/src/app/assembly/editor/montage.test.ts
git commit -m "feat: pure montage logic module with TS parity tests"
```

---

### Task 4: `state.js` + `api.js`

**Files:**
- Create: `apps/cli/src/app/assembly/editor/state.js`, `apps/cli/src/app/assembly/editor/api.js`
- Test: `apps/cli/src/app/assembly/editor/state.test.ts`

**Interfaces:**
- `createState(initial)` → `{ get(key), set(key, value), subscribe(key, fn) }`; `set` notifica só os assinantes daquela chave. Chaves canônicas (a UI toda usa estas): `"project"`, `"operation"`, `"selection"` (Set de `sceneId\0takeId\0wordId`), `"playhead"` (segundos na montagem ou null), `"watched"` (`{revision, ended}` — tarefa 9).
- `createApi({ onStatus })` → `async call(path, opts)` → `{res, body}`; injeta `content-type: application/json`, chama `onStatus({busy, label?, error?})` em início/fim/erro. Sem DOM — `onStatus` é injetado pela página.

- [ ] **Step 1: teste falhando**

```ts
import { createState } from "./state.js";

it("set notifica só a chave inscrita", () => {
  const s = createState({ project: null });
  const seen = [];
  s.subscribe("project", (p) => seen.push(p));
  s.subscribe("operation", () => seen.push("nunca"));
  s.set("project", { revision: 1 });
  expect(seen).toEqual([{ revision: 1 }]);
  expect(s.get("project")).toEqual({ revision: 1 });
});
```

- [ ] **Step 2: rodar e ver falhar** → FAIL.

- [ ] **Step 3: implementar os dois módulos** (state ~15 linhas; api ~25: `fetch` + `res.json().catch(()=>({}))` + contagem de em-voo; portar o espírito de `trackStart/trackEnd` do page.js sem tocar DOM).

- [ ] **Step 4: rodar e ver passar** → PASS.

- [ ] **Step 5: commit**

```bash
git add apps/cli/src/app/assembly/editor/state.js apps/cli/src/app/assembly/editor/state.test.ts apps/cli/src/app/assembly/editor/api.js
git commit -m "feat: subscribable editor state and api client modules"
```

---

### Task 5: casca de 4 regiões — rail herda o fluxo, texto vira o centro

Esta é a tarefa de migração maior. Ela NÃO adiciona gestos novos: entrega a shell com o comportamento atual funcionando (import, preparação, revisão por seleção, prévia V4, undo), já no leiaute do spec. Os comportamentos críticos a preservar estão mapeados: auto-prévia com debounce (`scheduleAutoPreview`), polling de correção (`watchCorrections`), prévia anterior durante render (bloco V4 de `renderReview`), reconciliação 409 (R2), preservação de foco/seleção (V6/V8), import por stream com `x-file-size`.

**Files:**
- Rewrite: `apps/cli/src/app/assembly/page.html`, `page.css`, `page.js`
- Create: `apps/cli/src/app/assembly/editor/rail.js`, `editor/contexto.js`
- Modify: `apps/cli/src/app/assembly/editor/state.js` (remove o stub da Task 2)

**Interfaces:**
- `page.html`: `<div id="rail">`, `<main id="texto">`, `<aside id="contexto">`, `<footer id="faixa">` numa grid `grid-template: "rail texto contexto" 1fr "faixa faixa faixa" auto / 240px 1fr 300px`; sem `<header>` (spec: "não existe header global").
- `rail.js`: `mountRail({ state, api, player })` — renderiza materiais (com categoria/incluir-excluir/relink/ver original, portados de `renderSources`), briefing, preparação (tabela atual virando lista com estado por arquivo e erro + retomar), e o cartão de entrega (downloads atuais; o cadeado vem na Task 9).
- `contexto.js`: `mountContexto({ state, api, player })` — player da prévia com a nota V4 ("Prévia anterior…"), meta de entrega, pedido em linguagem natural (textarea + botão "propor mudanças", portado do `adjust` atual com rótulo "(modelo pago)"), e as ações de briefing que hoje ficam espalhadas.
- `page.js` (bootstrap, <120 linhas): importa módulos, cria `state`/`api`, mantém **textualmente portados** `scheduleAutoPreview`, `watchCorrections`, `watchPreparation`, `importFiles` (agora disparados pela dropzone do centro no estado vazio) e o loop `api("/project")` inicial; conecta `api.onStatus` ao texto de estado no rail.

- [ ] **Step 1: escrever page.html/page.css** — grid das 4 regiões com o tema atual (variáveis de cor do `page.css` vigente), dropzone cobrindo `#texto` quando `project.assembly.sources.length === 0`, e `<script type="module" src="/page.js">`. Esqueleto exato:

```html
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>decupa · montagem</title>
<link rel="stylesheet" href="/page.css">
</head>
<body>
<div id="rail" aria-label="Projeto"></div>
<main id="texto" aria-label="Montagem"></main>
<aside id="contexto" aria-label="Contexto"></aside>
<footer id="faixa" aria-label="Sequência"></footer>
<div id="dropzone" hidden tabindex="0" role="button" aria-label="Enviar arquivos de mídia">
  Arraste arquivos para cá ou clique para escolher
  <input type="file" id="filePicker" accept="video/*,audio/*" multiple hidden>
</div>
<script type="module" src="/page.js"></script>
</body>
</html>
```

```css
/* page.css — base da grid; o resto migra do css atual */
body { margin: 0; display: grid; height: 100dvh;
  grid-template: "rail texto contexto" 1fr "faixa faixa faixa" auto / 240px 1fr 300px; }
#rail { grid-area: rail; overflow-y: auto; }
#texto { grid-area: texto; overflow-y: auto; }
#contexto { grid-area: contexto; overflow-y: auto; }
#faixa { grid-area: faixa; }
#dropzone { position: fixed; inset: 0; z-index: 10; display: grid;
  place-items: center; background: var(--bg, #12171a); }
.riscado { text-decoration: line-through; opacity: .55; }
```

- [ ] **Step 2: portar módulo a módulo** — rail.js primeiro (matéria+preparação+briefing+entrega), contexto.js depois (player+pedido). Cada `render*` existente vira assinante de `state.subscribe("project", ...)`. Regra de ouro da migração: cada bloco portado mantém o comentário de comportamento original (V2/R2/V3/V4) para o revisor conferir paridade.

- [ ] **Step 3: centro com os dois documentos do spec** — `page.js` renderiza no `#texto`, conforme o estado: (a) sem fontes → dropzone (esconde `#texto`); (b) com fontes mas sem cenas → **transcrição por fonte** com `effectiveWords` de `montage.js`, título por fonte com status da análise e marca "parcial" quando `preparation.status === "running"` (spec, "Centro com dois documentos"); (c) com cenas → prosa de montagem com `takeWords`, `removed` com classe `.riscado`. Ainda sem interação (Task 6) — mas os dois documentos já aparecem.

- [ ] **Step 4: verificação de regressão**

Run: `pnpm vitest run tests/assembly-flow.test.ts apps/cli/src/app/assembly/routes.test.ts` → PASS (o fluxo HTTP não mudou; a página continuando carregando é coberta pela prova manual abaixo).
Manual (com mídia real do repo de testes ou clip.mp4 dos fixtures):
`node --experimental-strip-types apps/cli/src/index.ts montar --project /tmp/decupa-plano --input tests/fixtures/clip.mp4` → import, briefing, preparar, proposta local, edição e prévia funcionam na shell nova; o texto aparece no centro com riscados; player à direita; faixa presente (vazia até a Task 7).

- [ ] **Step 5: typecheck + commits granulares**

Um commit por módulo portado: `feat: rail region with materials, preparation and delivery`, `feat: context region with preview player and paid request`, `refactor: page.js becomes the four-region shell bootstrap`.

---

### Task 6: `texto.js` — gestos e menu no ponto

**Files:**
- Create: `apps/cli/src/app/assembly/editor/texto.js`
- Test: `apps/cli/src/app/assembly/editor/texto.test.ts` (lógica de menu, sem DOM)
- Modify: `apps/cli/src/app/assembly/page.js` (monta a região)

**Interfaces:**
- `menuActionsFor(selection): {action, label, danger?}[]` — pura, testável. Regras (spec, Interações 2): base `[ouvir, tirar, preservar, corrigir]`; `tirar` vira `restaurar` quando toda a seleção está `removed`; `preservar` vira `liberar` quando toda a seleção está `protected`; seleção em zona omitida (takeId `""`) vira `[ouvir, incluir]`.
- Gestos no DOM: `click` em palavra mantida → `seek(montageTimeOfWord(...))` (usa `state.set("playhead", ...)` e o seek do player — sem alternar seleção); `pointerdown→pointerup` com deslocamento (arraste sobre ≥1 palavra) → abre o menu flutuante ancorado na seleção; `click` em `.riscado` → `restore` imediato (POST `/project/edit`), sem seek. "Ouvir" no menu toca `/project/media/<sourceId>?view=playback#t=<start-padrão>` com 0.7s de contexto antes (padrão `JOIN_PAD` da tela de limpeza).
- Cabeçalho de cena: `↥ ↧` → POST `/edit move-scene` (a UI antiga usava propose+apply — troque pela rota direta, que existe) e `✕` → POST `/edit delete-scene`; lacunas da cena (`scene.gaps`) aparecem como aviso no cabeçalho (spec/rail: lacunas visíveis).
- **Chip de apoio inline** (spec, Interação 5): para cada `scene.support`, insira um chip `🎬 <nome> · <duração>s` entre as palavras cujos `montageTimeOfWord` cercam `offsetFrames/fps + início da cena` na montagem. Chip é **localizador, não alça** — clique seleciona a cena no contexto (que mostra posição/duração como leitura); mudança de apoio é pelo pedido NL, nunca por edição direta do chip.

- [ ] **Step 1: teste da lógica de menu** (`menuActionsFor`) — casos: mantida, removida, protegida, mista ( throwing: seleção mista mantida+removida não oferece `tirar`; documente no teste), omitida. FAIL primeiro, PASS depois.
- [ ] **Step 2: teste do cabeçalho** — `sceneHeaderActions(index, total)` → `[{move:"up",disabled:index===0},...]` puro.
- [ ] **Step 3: DOM** — portar `takeWords`/`selectionKey`/`pruneSelection`/`selectedTake` do page.js usando `state`, implementar os listeners de gesto (um `click` handler delegado no `#texto`; o arraste usa `selectionchange`/`pointermove` com limiar de 6px).
- [ ] **Step 4: verificação manual** — clicar palavra busca no player; arrastar abre menu; ações do menu alteram o texto e o riscado restaura; preservar sem liberar trava `tirar` (erro do servidor aparece no status do rail, como hoje).
- [ ] **Step 5: commit** — `feat: text-center editing gestures with inline action menu`.

---

### Task 7: `sequencia.js` — faixa-bússola

**Files:**
- Create: `apps/cli/src/app/assembly/editor/sequencia.js`
- Test: `apps/cli/src/app/assembly/editor/sequencia.test.ts`
- Modify: `apps/cli/src/app/assembly/page.js`

**Interfaces:**
- Puras (testadas): `blocksAt(project, seconds): {sceneId, kind} | null` (bloco sob o playhead), `seekFromRatio(project, ratio): number` (`ratio∈[0,1]` → segundos), `activeScene(project, seconds): string | null`.
- DOM: `mountSequencia({ state, api, player })` — blocos proporcionais com `timelineBlocks(project)` (apoio com classe própria, `title` com nome+tempo), clique → seek pelo ratio do clique, `pointerdown+move` → scrub (throttle 60ms), `state.subscribe("playhead")` → linha de playhead + bloco aceso (classe `.ativa`). Sem waveform até a Task 8 (reserva `div.wave` vazio).

- [ ] **Step 1: testes das puras** (fixture do montage.test.ts): FAIL → PASS.
- [ ] **Step 2: DOM + ligação com o playhead** — o player já emite tempo via `timeupdate`; `page.js` encadeia `player.on timeupdate → state.set("playhead", currentTime)`.
- [ ] **Step 3: verificação manual** — play acende o bloco da cena atual; clicar/arrastar busca; bloco de apoio não busca áudio diferente (seek é na montagem toda).
- [ ] **Step 4: commit** — `feat: sequence strip as navigation compass`.

---

### Task 8: peaks de waveform (best-effort, do proxy) + composição na faixa

**Files:**
- Modify: `apps/cli/src/app/assembly/preparation.ts` (etapa media), `routes.ts` (GET `/project/waveform/:sourceId`)
- Create: `apps/cli/src/app/assembly/waveform.ts`, `waveform.test.ts`
- Modify: `apps/cli/src/app/assembly/editor/sequencia.js` (desenha), `montage.js` (novo export `retainedSegments(project): {sourceId, srcStart, srcEnd, montageStart, montageEnd}[]` com teste)

**Interfaces:**
- `waveform.ts`: `buildPeaks(exec, { proxyPath, sha256, outPath, buckets = 1000 }): Promise<{ path, buckets, count } | null>` — roda ffmpeg no proxy (mono, 8kHz, PCM s16le → amostras → min/max por bucket), grava JSON ao lado do proxy como `<sha>.peaks.json`; **toda falha vira `null`** (best-effort: nunca derruba a etapa media nem bloqueia transcrição/proposta/prévia — spec). ` peaksPath(dir, sha256)` resolve o cache; a invalidação é por sha (arquivo por hash).
- Rota: `GET /project/waveform/:sourceId` → lê o peaks do sha da fonte; sem peaks → `204 No Content` (a faixa desenha sem waveform).
- `sequencia.js`: no `subscribe("project")`, para cada cena busca `/project/waveform/<sourceId>` (cache em Map), desenha com `<canvas>` os trechos de `retainedSegments` — o comprimento de cada segmento no canvas segue a proporção do `timelineBlocks`; apoio não entra no waveform (não tem áudio próprio).
- Testes: `waveform.test.ts` com executor fake que grava PCM determinístico → peaks com N buckets; falha do executor → `null`. `retainedSegments` puro no montage.test.ts.

- [ ] **Step 1: teste de peaks** — `waveform.test.ts`: executor fake que grava PCM determinístico (silêncio + senoide) → `buildPeaks` resolve com N buckets min/max; executor que falha (code 1) → `null`. FAIL → PASS.
- [ ] **Step 2: implementar `waveform.ts`** — ffmpeg no proxy (mono 8kHz s16le → min/max por bucket), JSON `<sha>.peaks.json` ao lado do proxy; toda exceção vira `null`.
- [ ] **Step 3: chamar na etapa media** — em `preparation.ts`, logo após o proxy da fonte existir: `await buildPeaks(...).catch(() => null)` sem entrar no caminho crítico (falha não marca a fonte com erro).
- [ ] **Step 4: teste da rota** — `routes.test.ts`: `GET /project/waveform/<id>` → 200 JSON com peaks; fonte sem peaks → 204.
- [ ] **Step 5: teste de `retainedSegments`** — puro, em `montage.test.ts`: take com remoção no meio vira 2 segmentos com `montageStart` correto.
- [ ] **Step 6: canvas na faixa** — `sequencia.js` busca peaks por fonte (cache em Map), desenha segmentos por `retainedSegments` na proporção de `timelineBlocks`; apoio fora do waveform.
- [ ] **Step 7: verificação manual** — faixa com waveform no projeto de prova; sem peaks a faixa segue usável (só blocos).
- [ ] **Step 8: commit** — `feat: best-effort source waveform peaks composed on the strip`.

---

### Task 9: assistido de verdade, chip de frescor, entrega trancada

**Files:**
- Modify: `apps/cli/src/app/assembly/editor/contexto.js`, `rail.js`, `state.js`
- Test: `apps/cli/src/app/assembly/editor/watched.test.ts`

**Interfaces:**
- `watchedState({ previewRevision, revision }, { watchedRevision, ended }): {fresh: boolean, watched: boolean, canApprove: boolean, label: string}` — pura, testável: `fresh = previewRevision === revision`; `watched = ended && watchedRevision === previewRevision && fresh`; `canApprove = fresh && watched`; `label` cobre os 4 estados ("prévia atualizada ✓", "desatualizada — atualizar", "assistida ✓", "renderizando…").
- Player emite `timeupdate` (progresso) e `ended` → `state.set("watched", { revision: project.previewRevision, ended: true })` **só** quando `currentTime >= duration - 0.05` ou `ended`. Trocar de `src`, `seek` para trás ou editar (qualquer `set("project")` com revisão nova) reseta `watched`.
- `approveFinal` envia `watchedRevision: state.get("watched").revision` **apenas** se `canApprove`; o back-end já rejeita `watchedRevision !== revision` (verificado em `approveFinal` de revisions.ts) — o teste de paridade garante que o front nunca mais mente.
- Rail: cartão de entrega com cadeado até `finalApprovedRevision != null`; downloads atuais migram para lá (já portados na Task 5); chip de frescor no contexto junto ao player.

- [ ] **Steps**: teste `watchedState` (6 casos) FAIL→PASS; fiação do player; chip + cadeado; teste manual: aprovar sem assistir até o fim é impossível (botão desabilitado e o POST não parte); commit `feat: real watched-through tracking gates approval and delivery`.

---

### Task 10: pagos por lote no disparo

**Files:**
- Modify: `apps/cli/src/app/assembly/editor/rail.js` (botão preparar), `contexto.js` (pedido NL)
- Test: manual + existentes (o 402 já é testado no assembly-flow; nenhum contrato novo)

**Interfaces:**
- Botão "Preparar montagem" abre confirmação inline (não `confirm()` nativo): "Vai analisar N arquivo(s) — custo estimado do modelo visual + envio das mídias ao provedor. Continuar?" com [Preparar agora] [Cancelar]. Se `project.permissions.visual === true` já concedido, mostra "já autorizado (persistente)" em vez da pergunta (honestidade do spec: permissão é monotônica).
- Pedido NL mostra "(modelo pago)" no botão quando `!permissions.model` e "já autorizado" quando concedido; envio segue passando `modelOptIn/visualOptIn` atuais nas flags de `/project/prepare|adjust` (o contrato do servidor não muda).
- Os checkboxes `modelOptIn`/`visualOptIn` do header morrem com o header.

- [ ] **Step 1: teste de preservação do caminho NL (spec, Testes)** — em `revisions.test.ts`: `applyProposal` com proposta que altera uma cena **fora** de `changedSceneIds` lança `"proposta reescreve cena ... fora do escopo"`; e uma proposta válida que muda só `s2` deixa `s1` byte-a-byte igual (`expect(next.scenes[0]).toEqual(before.scenes[0])`). Se já existir caso equivalente no arquivo, confira e siga — o objetivo é o teste existir travando a preservação.

- [ ] **Step 2: implementar confirmação inline + rótulos** — botão "Preparar montagem" abre confirmação inline (não `confirm()` nativo): "Vai analisar N arquivo(s) — custo estimado do modelo visual + envio das mídias ao provedor. Continuar?" com [Preparar agora] [Cancelar]. Se `project.permissions.visual === true` já concedido, mostra "já autorizado (persistente)" em vez da pergunta (honestidade do spec: permissão é monotônica).

- [ ] **Step 3: pedido NL com rótulo de custo** — botão mostra "(modelo pago)" quando `!permissions.model` e "já autorizado" quando concedido; envio segue passando `modelOptIn/visualOptIn` atuais nas flags de `/project/prepare|adjust` (o contrato do servidor não muda). Os checkboxes `modelOptIn`/`visualOptIn` do header morrem com o header.

- [ ] **Step 4: verificação** — `pnpm vitest run tests/assembly-flow.test.ts apps/cli/src/app/assembly/revisions.test.ts` (402 e preservação verdes); manual: prepare sem permissão mostra o lote; segunda vez mostra "já autorizado".

- [ ] **Step 5: commit** — `feat: paid consent at batch dispatch with honest granted state`.

---

### Task 11: edição concorrente à preparação resolve sem perder trabalho

**Files:**
- Modify: `apps/cli/src/app/assembly/preparation.ts` (save final do percurso)
- Test: `apps/cli/src/app/assembly/preparation.test.ts` + `tests/assembly-flow.test.ts`

**Interfaces:**
- Semântica escolhida (spec, "Falhas"): quando o save do percurso encontra revisão avançada (edição passou na frente), ele **não** falha com 409 genérico: salva as análises/preparação produzidas com rebase sobre a revisão atual (o `saveProject(dir, expected, (current) => ...)` com callback já recebe `current` — aplique as mutações de análise sobre `current`, não sobre a revisão capturada no início) e o `preparation.status` termina `ready`. A preparação nunca sobrescreve `scenes`/`corrections` — só acrescenta `analyses`/`preparation`.
- Se o rebase for impossível (ex.: fonte removida durante a preparação), o percurso termina `interrupted` com o erro por fonte — retomável, sem perder o que as outras fontes produziram (comportamento de barreira que já existe).

- [ ] **Step 1: teste falhando** — em `assembly-flow.test.ts`: dispara `/project/analyze` (executor fake lento via promise controlada), faz `/project/edit` (remove palavra) durante, solta o executor, espera o poll terminar; hoje o save do analyze/prepare falha 409; esperado: 200 com `analyses` presentes **e** a edição preservada (`scenes[0].takes[0].removed.length === 1`, `revision` avançou 2x).

Run: `pnpm vitest run tests/assembly-flow.test.ts` → FAIL antes, PASS depois.

- [ ] **Step 2: implementar o rebase no save do percurso** (preparation.ts; o ponto exato é o `saveProject` pós-etapas — aplique sobre `current` as partes produzidas: `analyses` merge via `mergeAnalyses` já importado em routes.ts/store.ts).

- [ ] **Step 3: commit** — `fix: preparation saves rebase over concurrent edits instead of 409`.

---

### Task 12: prova visual com mídia real + evidência

**Files:**
- Create: `docs/superpowers/evidence/2026-09-11-editor-texto-centrado.md`

**Steps:**
- [ ] Rodar o fluxo completo com mídia real do projeto (2 falas + 1 apoio): import → lote pago (confirmação) → preparação → proposta local → edição por gesto (cortar/preservar/liberar/restaurar/reordenar/corrigir) → prévia → assistir até o fim → aprovar → exportar OTIO+MP4 → conferir que o OTIO abre com os cortes da edição (mesma revisão).
- [ ] Gravar screenshots das quatro regiões nos estados vazio/preparando/editando/entrega e anexar no doc de evidência com a revisão e o sha do commit.
- [ ] Rodar `pnpm vitest run` completo (tudo verde, incluindo limpeza: `apps/cli/src/app/keeplist.test.ts`, `review.test.ts`) e `pnpm typecheck`.
- [ ] Commit: `docs: visual evidence for the text-centered editor`.

---

## Riscos e notas para o executor

- **Task 5 é a mais delicada** (migração das máquinas V2/R2/V3/V4/V6/V8). Se um comportamento listado não sobreviver à migração, pare e restaure do page.js antigo — o git history o guarda inteiro.
- `montage.js` é a única fonte de lógica de montagem no cliente a partir da Task 3; **nunca** reimplemente `effectiveWords`/`retained*` em outro módulo — a paridade TS↔JS do montage.test.ts é o guardião.
- A UI antiga usava propose+apply para reordenar/excluir cena; o caminho novo é `/edit move-scene|delete-scene` (mais barato, sem proposta). Não misture os dois.
- `assembly-flow.test.ts` não pode usar chaves live (a asserção no topo do arquivo garante); executores fake sempre.
- Se algum teste exigir `analyses[].words` e o executor fake não os produzir, estenda o fake para gravar `words` no `speech_index.json` — siga como `analysis.ts` deriva palavras do índice.
