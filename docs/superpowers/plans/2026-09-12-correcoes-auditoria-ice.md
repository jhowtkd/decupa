# Correções da Auditoria ICE — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os 10 problemas confirmados pela auditoria ICE de 2026-09-12 (B-roll descartado, micro-slivers de corte textual, rates mistos no OTIO, correção travada em `pending`, I/O duplicado, fps fracionário no `decupa limpar`, `pnpm test` quebrado por env, preparação órfã em `running`, waveform achatado) e fechar o Gate G6 com harness de importação real no DaVinci Resolve.

**Architecture:** Doze correções independentes, cada uma com ciclo TDD próprio, no monorepo `decupa` (Node ≥ 22, TypeScript strict executado direto por `node --experimental-strip-types`, sem build). A ordem segue a recomendação da auditoria: primeiro destravar `pnpm test`, depois os bugs de maior ICE, depois I/O e fps fracionário, por fim recuperação de falha e o harness externo do DaVinci.

**Tech Stack:** TypeScript (vitest, node:test runner via vitest), FFmpeg/ffprobe via `@decupa/media`, Python 3 stdlib para a API de scripting do DaVinci Resolve.

**Spec:** `docs/superpowers/specs/2026-09-12-auditoria-ice-decupa.md`

## Global Constraints

- Node ≥ 22; execução direta via `node --experimental-strip-types` — **sem etapa de build**; sem arquivos `.js` compilados.
- `pnpm test` (vitest run) e `pnpm run typecheck` devem terminar verdes ao **fim de cada tarefa**.
- Comentários, mensagens de erro e nomes de teste em **português do Brasil** (convenção do repo).
- **Nenhuma dependência nova** (package.json permanece intacto) e **nenhuma chamada a modelo pago** (Z.ai/GLM) — nenhuma tarefa aqui precisa de LLM.
- Commits atômicos por tarefa com `git add` **apenas dos arquivos listados na tarefa**. O `.gitignore` tem uma mudança não commitada do usuário (linha `.foglamp/`) — **nunca incluí-la** nos commits.
- Intervalos de tempo são semiabertos `[start, end)` em segundos; frame rates são racionais `{ num, den }`.
- Rodar os testes de um único arquivo com `npx vitest run <caminho>`; a suíte completa é `pnpm test`.

---

### Task 1: Isolar chaves de modelo do ambiente no Vitest (auditoria #7)

`pnpm test` falha no teste `não usa chave live nos testes de modelo` quando o ambiente do usuário exporta `ZAI_API_KEY`. O vitest precisa sanitizar essas chaves por configuração, não por prefixo `env -u`.

**Files:**
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: teste existente `tests/assembly-flow.test.ts:35-38` (afirma `Boolean(process.env.ZAI_API_KEY) === false`).
- Produces: `test.env` no config do vitest zerando `ZAI_API_KEY` e `OPENAI_API_KEY` para todos os testes.

- [ ] **Step 1: Demonstrar a falha com a chave presente no ambiente**

Run: `ZAI_API_KEY=fake-key npx vitest run tests/assembly-flow.test.ts`
Expected: FAIL em `não usa chave live nos testes de modelo` (esperava `false`, recebeu `true`).

- [ ] **Step 2: Aplicar o isolamento no config**

Substitua o conteúdo de `vitest.config.ts` por:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/fixtures/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    // Chaves live do ambiente nunca vazam para os testes: o doctor exige
    // ZAI_API_KEY no shell do usuário, e isso não pode quebrar o `pnpm test`.
    env: {
      ZAI_API_KEY: "",
      OPENAI_API_KEY: "",
    },
  },
});
```

- [ ] **Step 3: Verificar o teste que antes falhava**

Run: `ZAI_API_KEY=fake-key npx vitest run tests/assembly-flow.test.ts`
Expected: PASS (todos os testes do arquivo).

- [ ] **Step 4: Suíte completa**

Run: `pnpm test`
Expected: PASS em todos os arquivos (a auditoria contou 698 testes; 1 falhava por este motivo).

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts
git commit -m "test: isola chaves de modelo do ambiente no vitest"
```

---

### Task 2: Apoio visual entra pelo início do span da fonte (auditoria #1, ICE 810)

Em `compileScenes`, `srcStartSeconds` soma `item.offsetFrames` (posição na **cena**) ao início do span da **fonte** de apoio. Apoio inserido no meio da cena avança a fonte além do próprio span e é descartado com "sem duração na cena". A correção desvincula as duas coisas: o clipe de apoio sempre entra em `span.start` e dura o mínimo entre o pedido, o espaço na cena e o tamanho do span.

**Files:**
- Modify: `apps/cli/src/app/assembly/scenes.ts:367-389` (bloco `for (const item of scene.support)`)
- Test: `apps/cli/src/app/assembly/scenes.test.ts`

**Interfaces:**
- Consumes: `Scene["support"]` (`{ visualId, offsetFrames, durationFrames }`), catálogo visual (`visualCatalog`), helpers `toFrames`/`toSeconds` locais de `compileScenes`.
- Produces: `Clip` de V2 com `sourceStartSeconds = span.start` (sem dependência de `offsetFrames`). Nenhuma assinatura muda.

- [ ] **Step 1: Escrever o teste que falha**

Adicione ao final de `apps/cli/src/app/assembly/scenes.test.ts` (mesmo estilo do teste `apoio além da cena é limitado com nota na explicação`; o helper `project()` e os imports `compileScenes`/`validateProposal` já existem no arquivo):

```ts
it("apoio no meio da cena entra pelo início do span da fonte", () => {
  const p = project();
  // Cena de 3 s (75 frames a 25 fps); apoio com span de só 1 s, entrando aos 2 s.
  p.analyses[0]!.speech[0] = { id: "a:u001", sourceId: "a", start: 0, end: 3, text: "olá tema" };
  p.analyses[0]!.visual.push({
    id: "b:v0", sourceId: "b", start: 0, end: 1, text: "apoio", confidence: "observed", tags: [],
  });
  const proposal = validateProposal({
    id: "p2",
    baseRevision: 1,
    changedSceneIds: ["s1"],
    explanation: "meio",
    scenes: [{
      id: "s1",
      objective: "abrir",
      rationale: "tema",
      speechIds: ["a:u001"],
      support: [{ visualId: "b:v0", offsetFrames: 50, durationFrames: 25 }],
      gaps: [],
    }],
  }, p);
  const compiled = compileScenes(p, proposal.scenes);
  const v2 = compiled.tracks.find((t) => t.name === "V2")!.clips;
  // Antes: offset 50 avançava a fonte para 2 s num span de 1 s → descarte.
  expect(v2).toHaveLength(1);
  expect(v2[0]!.sourceStartSeconds).toBe(0);
  expect(v2[0]!.startFrame).toBe(50);
  expect(v2[0]!.durationFrames).toBe(25);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/scenes.test.ts`
Expected: FAIL — o novo teste recebe `v2` vazio (apoio descartado).

- [ ] **Step 3: Corrigir o cálculo em `compileScenes`**

Em `apps/cli/src/app/assembly/scenes.ts`, substitua o corpo do laço de support (linhas 367-389, de `for (const item of scene.support) {` até o `}` antes de `return validateAssembly`) por:

```ts
    for (const item of scene.support) {
      const span = visual.get(item.visualId);
      if (!span) throw new Error(`referência visual inexistente: ${item.visualId}`);
      const source = bySource.get(span.sourceId);
      if (!source) throw new Error(`apoio ${item.visualId} referencia fonte ausente ${span.sourceId}`);
      if (!source.hasVideo) continue;
      const sceneBounds = bounds.get(scene.id)!;
      const available = sceneBounds.end - (sceneBounds.start + item.offsetFrames);
      // O offset posiciona o apoio na CENA, não dentro da fonte: o clipe
      // entra pelo início do span e dura o que pedido, cena e fonte permitem.
      const srcAvailable = toFrames(span.end) - toFrames(span.start);
      const durationFrames = Math.min(item.durationFrames, available, srcAvailable);
      // Apoio sem duração na cena é descartado aqui e anotado na validação;
      // nunca atravessa outra cena silenciosamente.
      if (durationFrames <= 0) continue;
      v2.push({
        id: `${scene.id}-${item.visualId}`,
        sceneId: scene.id,
        sourceId: span.sourceId,
        sourceStartSeconds: toSeconds(toFrames(span.start)),
        startFrame: sceneBounds.start + item.offsetFrames,
        durationFrames,
      });
    }
```

(A mudança efetiva: `srcAvailable` agora é `toFrames(span.end) - toFrames(span.start)` e `sourceStartSeconds` é `toSeconds(toFrames(span.start))`; a variável `srcStartSeconds` deixa de existir.)

- [ ] **Step 4: Rodar os testes de scenes**

Run: `npx vitest run apps/cli/src/app/assembly/scenes.test.ts`
Expected: PASS — incluindo o teste pré-existente `apoio além da cena é limitado com nota na explicação` (offset 40, span 2 s: o resultado continua 10 frames) e o novo teste.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/assembly/scenes.ts apps/cli/src/app/assembly/scenes.test.ts
git commit -m "fix: apoio visual entra pelo início do span e não é descartado no meio da cena"
```

---

### Task 3: Palavras contíguas viram um único intervalo de corte (auditoria #3, ICE 720)

Ao remover `w1` [0.1, 0.4] e `w2` [0.42, 0.7], o `removed` guarda dois intervalos e a pausa de 20 ms entre eles sobrevive na mídia como micro-fragmento (estalo de áudio / flash de 1 quadro). A correção agrupa seleções de palavras vizinhas no catálogo em um único intervalo do limite acústico da primeira ao da última. O helper é compartilhado por remove/restore/protect/unprotect — a semântica de "frase selecionada inclui suas pausas internas" vale para os quatro.

**Files:**
- Modify: `apps/cli/src/app/assembly/words.ts:153-167` (função `wordIntervalsInTake`)
- Test: `apps/cli/src/app/assembly/words.test.ts`

**Interfaces:**
- Consumes: `wordCutInterval(word, prev?, next?)` (já existente, linhas 113-124), `Word`, `SpeechTake`, `SourceRange`.
- Produces: `wordIntervalsInTake(words, ordered, take): SourceRange[]` com a mesma assinatura — agora com runs de índices consecutivos fundidos. `normalizeRanges` no chamador continua fundindo sobreposições.

- [ ] **Step 1: Atualizar o teste existente que pina o comportamento bugado**

Em `apps/cli/src/app/assembly/words.test.ts`, no teste `remove corta a mídia e restore devolve a seleção anterior`, troque a asserção dos dois intervalos separados:

```ts
  expect(removed.scenes[0]!.takes[0]!.removed).toEqual([
    { start: 0.1, end: 0.4 }, { start: 0.42, end: 0.7 },
  ]);
```

por:

```ts
  expect(removed.scenes[0]!.takes[0]!.removed).toEqual([
    { start: 0.1, end: 0.7 },
  ]);
```

(o restante do teste — catálogo intacto e restore devolvendo `[]` — permanece.)

- [ ] **Step 2: Escrever os novos testes**

Adicione ao final de `apps/cli/src/app/assembly/words.test.ts`:

```ts
it("remove palavras vizinhas num só intervalo que engole a pausa intermediária", () => {
  const removed = applyTextEdit(project(), {
    type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1", "w2"],
  });
  expect(removed.scenes[0]!.takes[0]!.removed).toEqual([{ start: 0.1, end: 0.7 }]);
  // Nenhum trecho retido sub-frame sobra na emenda.
  expect(retainedRanges(removed.scenes[0]!.takes[0]!)).toEqual([{ start: 0, end: 0.1 }, { start: 0.7, end: 2 }]);
});

it("restore de uma palavra no meio do corte fundido divide o intervalo", () => {
  const removed = applyTextEdit(project(), {
    type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1", "w2"],
  });
  const restored = applyTextEdit(removed, {
    type: "restore", sceneId: "s1", takeId: "t1", wordIds: ["w2"],
  });
  expect(restored.scenes[0]!.takes[0]!.removed).toEqual([{ start: 0.1, end: 0.42 }]);
});

it("palavras não vizinhas continuam em intervalos separados", () => {
  const removed = applyTextEdit(project(), {
    type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w1", "w4"],
  });
  expect(removed.scenes[0]!.takes[0]!.removed).toEqual([
    { start: 0.1, end: 0.4 }, { start: 1.0, end: 1.3 },
  ]);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/words.test.ts`
Expected: FAIL nos testes novos/editados (o `removed` ainda vem com dois intervalos para vizinhas).

- [ ] **Step 4: Implementar a fusão de runs em `wordIntervalsInTake`**

Em `apps/cli/src/app/assembly/words.ts`, substitua a função `wordIntervalsInTake` (linhas 153-167) por:

```ts
function wordIntervalsInTake(
  words: Word[],
  ordered: Word[],
  take: SpeechTake,
): SourceRange[] {
  const byId = new Map(ordered.map((word, i) => [word.id, i]));
  // Palavras vizinhas no catálogo formam um único intervalo do limite
  // acústico da primeira ao da última: sem isso, cada pausa intermediária
  // sobrevive na mídia como micro-fragmento de milissegundos.
  const indices = words.map((word) => byId.get(word.id)!).sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const i of indices) {
    const last = runs[runs.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else runs.push([i, i]);
  }
  return runs.map(([first, last]) => {
    const start = wordCutInterval(ordered[first]!, ordered[first - 1], ordered[first + 1]).start;
    const end = wordCutInterval(ordered[last]!, ordered[last - 1], ordered[last + 1]).end;
    const offender = start < take.start ? ordered[first]! : ordered[last]!;
    if (start < take.start || end > take.end) {
      throw new Error(`palavra ${offender.id} fora do take ${take.id}`);
    }
    return { start, end };
  });
}
```

(`ordered[first - 1]` com `first === 0` é `undefined`, exatamente o `prev?` opcional que `wordCutInterval` aceita.)

- [ ] **Step 5: Rodar os testes de words**

Run: `npx vitest run apps/cli/src/app/assembly/words.test.ts`
Expected: PASS em todos (incluindo os de `snapWordCuts` e `settleCorrection`, que não mudaram).

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/assembly/words.ts apps/cli/src/app/assembly/words.test.ts
git commit -m "fix: cortar palavras vizinhas engloba as pausas intermediárias"
```

---

### Task 4: OTIO com taxa única da timeline (auditoria #2, ICE 729)

`clipItem` emite `source_range.start_time` com `rate: 1` (segundos fracionários) e `duration` com `rate: fps` — rates mistos no mesmo `TimeRange` são fonte clássica de rejeição/desalinho em importadores C++ como o do Resolve. A correção expressa o início em **frames na taxa da timeline** (os clipes da montagem já são alinhados por quadro em `compileScenes`, então a conversão é sem perda).

**Files:**
- Modify: `apps/cli/src/app/assembly/otio.ts:58-69` (função `clipItem`)
- Test: `apps/cli/src/app/assembly/otio.test.ts:57-73`

**Interfaces:**
- Consumes: `time(value, rate)` e `fpsNumber(assembly)` já existentes em `otio.ts`; `Clip.sourceStartSeconds` e `Clip.durationFrames`.
- Produces: OTIO `Clip.1.source_range.start_time = { value: frames, rate: fps }` — mesma taxa do `duration`. `buildOtio(assembly): string` não muda de assinatura.

- [ ] **Step 1: Reescrever o teste que pina o comportamento antigo**

Em `apps/cli/src/app/assembly/otio.test.ts`, substitua o teste `exporta início fracionário da fonte sem arredondar fps 30000/1001` por:

```ts
it("exporta início em frames na taxa da timeline (sem rates mistos)", () => {
  const a = fixtureAssembly();
  a.fps = { num: 30000, den: 1001 };
  a.tracks[0]!.clips[0]!.sourceStartSeconds = 1.5;
  a.tracks[0]!.clips[0]!.durationFrames = 1;
  a.tracks[1]!.clips = [];
  a.tracks[2]!.clips[0]!.durationFrames = 1;
  const doc = JSON.parse(buildOtio(validateAssembly(a)));
  const clip = doc.tracks.children[0].children[0];
  // 1.5 s × 30000/1001 = 44.955… → 45 frames na taxa da timeline.
  expect(clip.source_range.start_time.value).toBe(45);
  expect(clip.source_range.start_time.rate).toBe(30000 / 1001);
  expect(clip.source_range.start_time.rate).toBe(clip.source_range.duration.rate);
  expect(clip.source_range.duration.value).toBe(1);
  expect(doc.global_start_time.rate).toBe(30000 / 1001);
  expect(doc.global_start_time.rate).not.toBe(29.97);
  expect(doc.global_start_time.value).toBe((30000 / 1001) * 3600);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/otio.test.ts`
Expected: FAIL — `start_time` ainda é `{ value: 1.5, rate: 1 }`.

- [ ] **Step 3: Corrigir `clipItem`**

Em `apps/cli/src/app/assembly/otio.ts`, substitua a função `clipItem` por:

```ts
function clipItem(clip: Clip, source: Source, assembly: Assembly, fps: number) {
  return {
    OTIO_SCHEMA: "Clip.1",
    name: clip.id,
    source_range: {
      OTIO_SCHEMA: "TimeRange.1",
      // Frames na taxa da timeline: rates mistos (início em segundos com
      // rate 1, duração em frames) confundem importadores C++ como o do
      // Resolve. Os clipes da montagem já são alinhados por quadro.
      start_time: time(Math.round(clip.sourceStartSeconds * fps), fps),
      duration: time(clip.durationFrames, fps),
    },
    media_reference: externalReference(source, assembly, fps),
  };
}
```

- [ ] **Step 4: Rodar os testes de otio**

Run: `npx vitest run apps/cli/src/app/assembly/otio.test.ts`
Expected: PASS em todos.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/assembly/otio.ts apps/cli/src/app/assembly/otio.test.ts
git commit -m "fix: OTIO emite início em frames na taxa da timeline para o Resolve"
```

---

### Task 5: Correção alinhada sobrevive a edição concorrente (auditoria #4, ICE 720)

`alignCorrectionJob` retorna cedo se a revisão andou (linha 253) e `publishCorrection` engole o erro de CAS e descarta o resultado — qualquer edição durante os 2-5 s de alinhamento deixa a correção em `pending` para sempre. A correção adota o padrão de rebase da Tarefa 11 (`preparation.ts:234-259`): publicar sobre a revisão **atual** com retry; descartar só quando a correção sumiu ou já foi resolvida.

**Files:**
- Modify: `apps/cli/src/app/assembly/routes.ts:211-315` (`publishCorrection` + `alignCorrectionJob`) e `apps/cli/src/app/assembly/routes.ts:946` (call site)
- Test: `apps/cli/src/app/assembly/routes.test.ts`

**Interfaces:**
- Consumes: `saveProject(dir, expectedRevision, fn)` (erro `revisão desatualizada` no CAS), `settleCorrection` e `AlignmentOutcome` de `./words.ts`, `alignText` de `@decupa/transcript`.
- Produces: `publishCorrection(dir, correctionId, outcome): Promise<void>` (**sem** `expectedRevision`) e `alignCorrectionJob(dir, correctionId): Promise<void>` (idem). `settleCorrection` continua sem criar revisão nova.

- [ ] **Step 1: Adicionar o mock de `alignText` no topo do arquivo de teste**

Em `apps/cli/src/app/assembly/routes.test.ts`, imediatamente após os imports existentes, adicione:

```ts
import { alignText } from "@decupa/transcript";
import type { Project } from "./types.ts";

vi.mock("@decupa/transcript", () => ({ alignText: vi.fn() }));
```

(`vi` já é importado do vitest nesse arquivo.)

- [ ] **Step 2: Escrever o teste de rebase**

Adicione ao final de `apps/cli/src/app/assembly/routes.test.ts`:

```ts
it("edição concorrente durante o alinhamento não descarta a correção (rebase)", async () => {
  const { base, dir } = await boot();
  const opened = await loadProject(dir);
  const sourceId = opened.assembly.sources[0]!.id;
  const withWords: Project = {
    ...opened,
    scenes: [{
      id: "s1", objective: "abrir", rationale: "tema", speechIds: [],
      takes: [{
        id: "t1", sourceId, speechId: null,
        start: 0, end: 2, removed: [], protected: [],
      }],
      visualEvidenceIds: [], support: [], gaps: [],
    }],
    analyses: [{
      sourceId,
      key: opened.assembly.sources[0]!.sha256,
      speech: [], visual: [], status: "ready",
      words: [
        { id: "w1", sourceId, text: "Nilton", confidence: null, start: 0.1, end: 0.4 },
        { id: "w2", sourceId, text: "Pinto", confidence: null, start: 0.42, end: 0.7 },
      ],
      wordsStatus: "ready",
      visualCoverage: { requested: [], returned: [], missing: [] },
    }],
  };
  await writeFile(join(dir, "project.json"), `${JSON.stringify(withWords, null, 2)}\n`, "utf8");

  type Tokens = { tokens: { text: string; startMs: number; endMs: number; confidence: number | null }[] };
  let release!: (value: Tokens) => void;
  const gate = new Promise<Tokens>((resolve) => { release = resolve; });
  vi.mocked(alignText).mockImplementationOnce(() => gate);

  const correct = await fetch(`${base}/project/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: withWords.revision,
      action: { type: "correct", sourceId, start: 0.1, end: 0.7, text: "Nilton Pinto" },
    }),
  });
  expect(correct.status).toBe(202);
  const afterCorrect = await correct.json() as { project: Project };
  expect(afterCorrect.project.corrections[0]!.status).toBe("pending");

  // Edição concorrente enquanto o alinhamento roda em background.
  const removed = await fetch(`${base}/project/edit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseRevision: afterCorrect.project.revision,
      action: { type: "remove", sceneId: "s1", takeId: "t1", wordIds: ["w2"] },
    }),
  });
  expect(removed.status).toBe(200);
  const afterRemove = await removed.json() as { project: Project };
  expect(afterRemove.project.revision).toBe(afterCorrect.project.revision + 1);

  release({
    tokens: [
      { text: "Nilton", startMs: 100, endMs: 400, confidence: 0.9 },
      { text: "Pinto", startMs: 420, endMs: 700, confidence: 0.9 },
    ],
  });

  let final: Project | null = null;
  for (let i = 0; i < 50 && !final; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const body = await (await fetch(`${base}/project`)).json() as { project: Project };
    if (body.project.corrections[0]?.status === "aligned") final = body.project;
  }
  expect(final).not.toBeNull();
  // Assentou sem criar revisão nova: rebasado sobre a edição concorrente.
  expect(final!.revision).toBe(afterRemove.project.revision);
  expect(final!.corrections[0]!.words).toHaveLength(2);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/routes.test.ts`
Expected: FAIL — `final` continua `null` (a correção fica `pending` para sempre porque o job retorna cedo na revisão divergente).

- [ ] **Step 4: Implementar o rebase em `routes.ts`**

Substitua as funções `publishCorrection` e o trecho inicial de `alignCorrectionJob` (linhas 211-255) por:

```ts
/**
 * Publica o resultado do alinhamento sem criar revisão nova: é a conclusão
 * da edição que registrou o pending. Rebase sobre a revisão atual — edição
 * concorrente não descarta o alinhamento; só correção resolvida ou sumida
 * é obsoleta de verdade.
 */
async function publishCorrection(
  dir: string,
  correctionId: string,
  outcome: AlignmentOutcome,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fresh = await loadProject(dir);
    const pending = fresh.corrections.find((item) => item.id === correctionId);
    if (!pending || pending.status !== "pending") return;
    try {
      await saveProject(dir, fresh.revision, (current) => {
        const correction = current.corrections.find((item) => item.id === correctionId);
        if (!correction || correction.status !== "pending") return current;
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
      if (!(err instanceof Error) || !/revisão desatualizada/.test(err.message)) throw err;
      // Revisão andou: rebasa sobre a atual na próxima tentativa.
    }
  }
  // Tentativas esgotadas: o pending segue retomável pelo usuário.
}

/**
 * Alinha uma correção pendente em background: recorta o áudio, roda o
 * sidecar com --text-file (sem ASR), refina os cortes com snapCut e publica
 * com rebase. Nunca derruba o servidor; o pending permite retomada.
 */
async function alignCorrectionJob(
  dir: string,
  correctionId: string,
): Promise<void> {
  try {
    const current = await loadProject(dir);
    const correction = current.corrections.find((item) => item.id === correctionId);
    if (!correction || correction.status !== "pending") return;
    const source = current.assembly.sources.find((item) => item.id === correction.sourceId);
    if (!source) {
      await publishCorrection(dir, correctionId, {
        error: `fonte ausente: ${correction.sourceId}`,
      });
      return;
    }
```

No corpo restante de `alignCorrectionJob`, troque as duas outras chamadas de `publishCorrection(dir, expectedRevision, correctionId, ...)` (blocos de erro do `alignText` e a publicação final `{ words }`) para a nova assinatura `publishCorrection(dir, correctionId, ...)`.

E no handler do `/project/edit` (linha ~946), troque:

```ts
          void alignCorrectionJob(dir, correctionId, project.revision);
```

por:

```ts
          void alignCorrectionJob(dir, correctionId);
```

- [ ] **Step 5: Rodar os testes de routes**

Run: `npx vitest run apps/cli/src/app/assembly/routes.test.ts`
Expected: PASS em todos.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/assembly/routes.ts apps/cli/src/app/assembly/routes.test.ts
git commit -m "fix: publicação de correção rebasa sobre edições concorrentes"
```

---

### Task 6: Prévia confere identidade sem reler a fonte (auditoria #5a)

`renderAssembly` chama `hashFile` (leitura integral) em todas as fontes a cada prévia, ignorando `verifySourceIdentity` (stat size+mtime com fallback a hash) que já existe em `assembly/media.ts`. Para vídeos de vários GB, cada ajuste de prévia relê tudo.

**Files:**
- Modify: `apps/cli/src/app/assembly/render.ts:5` (import) e `:112-117` (laço de verificação)
- Test: `apps/cli/src/app/assembly/render.test.ts:83-96` (regex) + teste novo com spy

**Interfaces:**
- Consumes: `verifySourceIdentity(source: Source): Promise<void>` de `./media.ts` (erros: `mídia ausente: fonte …` e `conteúdo substituído na fonte …`); `absolutePath` local.
- Produces: `renderAssembly(a, outDir, exec): Promise<string>` com a mesma assinatura — agora sem leitura integral quando as sentinelas `size`/`mtimeMs` batem.

- [ ] **Step 1: Atualizar a regex do teste existente**

Em `apps/cli/src/app/assembly/render.test.ts`, teste `recusa fonte substituída antes de renderizar`, troque:

```ts
  await expect(renderAssembly(assembly, dir, exec)).rejects.toThrow(/substituída/);
```

por:

```ts
  await expect(renderAssembly(assembly, dir, exec)).rejects.toThrow(/substituí/);
```

(a nova mensagem é `conteúdo substituído na fonte …` — masculino).

- [ ] **Step 2: Escrever o teste novo com spy em `hashFile`**

No topo de `apps/cli/src/app/assembly/render.test.ts`, logo após os imports, adicione:

```ts
vi.mock("@decupa/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@decupa/media")>();
  return { ...actual, hashFile: vi.fn(actual.hashFile) };
});
```

e acrescente `vi` ao import do vitest (`import { expect, it, vi } from "vitest";`) e `stat` ao import de `node:fs/promises`. Adicione o teste:

```ts
it("confere identidade pelas sentinelas sem reler a fonte inteira", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-render-"));
  const media = join(dir, "fala.mp4");
  await copyFile(join(FIXTURES, "clip.mp4"), media);
  const assembly = fixtureAssembly();
  const { size, mtimeMs } = await stat(media);
  for (const source of assembly.sources) {
    source.path = media;
    source.sha256 = await hashFile(media);
    source.size = size;
    source.mtimeMs = mtimeMs;
  }
  vi.mocked(hashFile).mockClear();
  const exec: Executor = {
    async run(call) {
      const work = call.env?.CLAUDE_PROJECT_DIR ?? call.cwd ?? "";
      await copyFile(join(FIXTURES, "clip.mp4"), join(work, "reference.mp4"));
      return { code: 0, stdout: "ok", stderr: "" };
    },
  };
  await expect(renderAssembly(assembly, dir, exec)).resolves.toBe(
    join(dir, "rev-1", "reference.mp4"),
  );
  expect(vi.mocked(hashFile).mock.calls.filter(([p]) => p === media)).toHaveLength(0);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/render.test.ts`
Expected: FAIL no teste novo — `hashFile` é chamado para `media` (leitura integral) e o render atual nem olha sentinelas.

- [ ] **Step 4: Trocar o hash integral por `verifySourceIdentity`**

Em `apps/cli/src/app/assembly/render.ts`:

1. No import da linha 5, remova `hashFile` (mantenha `probe`): `import { probe } from "@decupa/media";`
2. Adicione aos imports: `import { verifySourceIdentity } from "./media.ts";`
3. Substitua o laço de verificação (linhas 112-117) por:

```ts
  for (const source of valid.sources) {
    // Identidade por stat (size+mtime) com fallback a hash: reler GBs a
    // cada prévia é custo que a edição interativa não paga.
    await verifySourceIdentity({
      ...source,
      path: absolutePath(source.path, `fonte ${source.id}`),
    });
  }
```

- [ ] **Step 5: Rodar os testes de render**

Run: `npx vitest run apps/cli/src/app/assembly/render.test.ts`
Expected: PASS em todos (o teste `recusa fonte substituída` continua falhando corretamente porque as fixtures não têm sentinelas → fallback a hash → divergência detectada).

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/app/assembly/render.ts apps/cli/src/app/assembly/render.test.ts
git commit -m "perf: prévia confere identidade das fontes por stat antes de hash"
```

---

### Task 7: Exportação sem segunda leitura integral das fontes (auditoria #5b)

Em `exportApproved`, as fontes são lidas duas vezes: uma para conferir identidade (linha 121) e outra para o `sourceShas` do manifest (linha 176). Com a identidade verificada (Task 6 introduziu o helper; aqui o importamos), o manifest pode usar o sha **registrado** — que acabou de ser garantido igual ao do disco.

**Files:**
- Modify: `apps/cli/src/app/assembly/export.ts:120-127` (laço de identidade) e `:175-177` (`sourceShas`)
- Test: `apps/cli/src/app/assembly/export.test.ts`

**Interfaces:**
- Consumes: `verifySourceIdentity` de `./media.ts`; helper local `sha256(path)` (mantido — ainda usado por `exportedDirValid`).
- Produces: `exportApproved(project, dir): Promise<string>` inalterada; `manifest.sources` agora vem do `source.sha256` registrado.

- [ ] **Step 1: Escrever o teste do manifest**

Adicione ao final de `apps/cli/src/app/assembly/export.test.ts` (usa o helper `projectWithMedia` já existente no arquivo):

```ts
it("manifest registra o sha registrado das fontes após verificação", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assembly-export-"));
  const project = await projectWithMedia(dir, 10);
  const dest = await exportApproved(project, dir);
  const manifest = JSON.parse(await readFile(join(dest, "manifest.json"), "utf8")) as {
    sources: Record<string, string>;
  };
  for (const source of project.assembly.sources) {
    expect(manifest.sources[source.id]).toBe(source.sha256);
  }
});
```

(confirme que `readFile` já está importado no arquivo; se não, acrescente ao import de `node:fs/promises`.)

- [ ] **Step 2: Implementar**

Em `apps/cli/src/app/assembly/export.ts`:

1. Adicione o import: `import { verifySourceIdentity } from "./media.ts";`
2. Substitua o laço de linhas 120-127 por:

```ts
  for (const source of project.assembly.sources) {
    // Identidade por stat com fallback a hash: a entrega não relê os
    // originais inteiros só para confirmar o que o registro já garante.
    await verifySourceIdentity(source);
  }
```

3. Substitua as linhas 175-177 por:

```ts
    // Identidade verificada acima: o sha registrado é o do conteúdo em
    // disco — reler os originais de novo aqui seria a segunda leitura integral.
    const sourceShas = Object.fromEntries(
      snapshot.sources.map((s) => [s.id, s.sha256]),
    );
```

- [ ] **Step 3: Rodar os testes de export**

Run: `npx vitest run apps/cli/src/app/assembly/export.test.ts`
Expected: PASS em todos — inclusive `recusa fonte cujo hash atual diverge do sha256 aprovado` (o teste reescreve o arquivo, size/mtime mudam, o fallback a hash detecta a divergência; a regex `/substitu|reanalise|relink/` já cobre a mensagem `conteúdo substituído na fonte …`).

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/app/assembly/export.ts apps/cli/src/app/assembly/export.test.ts
git commit -m "perf: exportação verifica fontes por stat e não relê originais para o manifest"
```

---

### Task 8: Exportação OTIO no fluxo `decupa limpar` (auditoria #6a)

O fluxo de limpeza só exporta edl/mp4/srt; para fps fracionário (29,97 de iPhone/câmeras NTSC) o EDL falha e não há alternativa editável. O projeto já tem exportador OTIO racional — falta um adaptador do corte monoarquivo para `Assembly` e a rota nova.

**Files:**
- Create: `apps/cli/src/app/cut-otio.ts`
- Create: `apps/cli/src/app/cut-otio.test.ts`
- Modify: `apps/cli/src/app/server.ts` (import novo, rota `kind === "otio"` após o bloco `kind === "edl"` em ~linha 358, e mapa de downloads em ~linha 411)
- Test: `apps/cli/src/app/server.test.ts`

**Interfaces:**
- Consumes: `buildOtio(assembly): string` de `./assembly/otio.ts` (valida via `validateAssembly`); `probe(path)` de `@decupa/media` (devolve `frameRate: Rate | null`, `durationMs`, `hasVideo/hasAudio`, `width/height`); `hashFile(path)`; `plan.clips` (`{ start, end }` em segundos).
- Produces: `buildCutOtio(opts: { clips: { start: number; end: number }[]; source: CutSourceMeta; title: string }): string` com `CutSourceMeta = { path, sha256, durationSeconds, hasVideo, hasAudio, fps: Rate | null, width: number | null, height: number | null, name }`. Dependência da Task 4: o `start_time` sai em frames na taxa da timeline.

- [ ] **Step 1: Escrever o teste unitário do adaptador**

Crie `apps/cli/src/app/cut-otio.test.ts`:

```ts
import { expect, it } from "vitest";
import { buildCutOtio } from "./cut-otio.ts";

it("gera OTIO do corte com fps fracionário da fonte", () => {
  const text = buildCutOtio({
    clips: [{ start: 0.5, end: 1.5 }, { start: 2, end: 2.5 }],
    source: {
      path: "/tmp/entrevista.mp4",
      sha256: "a".repeat(64),
      durationSeconds: 3,
      hasVideo: true,
      hasAudio: true,
      fps: { num: 30000, den: 1001 },
      width: 320, height: 240,
      name: "entrevista.mp4",
    },
    title: "entrevista",
  });
  const doc = JSON.parse(text) as {
    metadata: { Resolve: { timelineFrameRate: string } };
    tracks: { children: { name: string; children: { name: string; source_range: { start_time: { value: number; rate: number } } }[] }[] };
  };
  expect(doc.metadata.Resolve.timelineFrameRate).toBe(String(30000 / 1001));
  const v1 = doc.tracks.children.find((t) => t.name === "V1")!;
  const a1 = doc.tracks.children.find((t) => t.name === "A1")!;
  // Clipe 2 encosta no 1 na timeline de saída: nenhum gap inserido.
  expect(v1.children).toHaveLength(2);
  expect(a1.children).toHaveLength(2);
  // 0.5 s × 30000/1001 = 14.985… → 15 frames (Task 4: frames na taxa).
  expect(v1.children[0]!.source_range.start_time.value).toBe(15);
  expect(v1.children[0]!.source_range.start_time.rate).toBe(30000 / 1001);
  expect(v1.children[1]!.name).toBe("corte-1");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/cut-otio.test.ts`
Expected: FAIL — módulo `./cut-otio.ts` não existe.

- [ ] **Step 3: Implementar o adaptador**

Crie `apps/cli/src/app/cut-otio.ts`:

```ts
import { buildOtio } from "./assembly/otio.ts";
import type { Assembly, Clip, Rate, Source } from "./assembly/types.ts";

export type CutClip = { start: number; end: number };

export type CutSourceMeta = {
  path: string;
  sha256: string;
  durationSeconds: number;
  hasVideo: boolean;
  hasAudio: boolean;
  fps: Rate | null;
  width: number | null;
  height: number | null;
  name: string;
};

/**
 * OTIO do corte monoarquivo (`decupa limpar`): as mesmas pistas do EDL, mas
 * em taxa racional da fonte — 29,97 incluído — para quem continua a edição
 * no Resolve. Monoarquivo por construção: uma fonte, V1 e A1 coladas.
 */
export function buildCutOtio(opts: {
  clips: CutClip[];
  source: CutSourceMeta;
  title: string;
}): string {
  if (opts.clips.length === 0) throw new Error("nenhum clipe para exportar");
  const fps: Rate = opts.source.fps ?? { num: 25, den: 1 };
  const toFrames = (seconds: number): number => Math.round((seconds * fps.num) / fps.den);
  const clips: Clip[] = opts.clips.map((clip, i) => {
    const start = toFrames(clip.start);
    const end = toFrames(clip.end);
    if (end <= start) throw new Error(`clipe ${i} com duração não positiva`);
    return {
      id: `corte-${i}`,
      sceneId: "corte",
      sourceId: "src",
      sourceStartSeconds: (start * fps.den) / fps.num,
      startFrame: 0,
      durationFrames: end - start,
    };
  });
  let cursor = 0;
  for (const clip of clips) {
    clip.startFrame = cursor;
    cursor += clip.durationFrames;
  }
  const source: Source = {
    id: "src",
    path: opts.source.path,
    sha256: opts.source.sha256,
    durationSeconds: opts.source.durationSeconds,
    hasVideo: opts.source.hasVideo,
    hasAudio: opts.source.hasAudio,
    fps: opts.source.fps,
    width: opts.source.width,
    height: opts.source.height,
    role: "both",
    included: true,
    name: opts.source.name,
  };
  const assembly: Assembly = {
    version: 1,
    revision: 0,
    name: opts.title,
    fps,
    width: opts.source.width ?? 1920,
    height: opts.source.height ?? 1080,
    sources: [source],
    tracks: [
      ...(opts.source.hasVideo ? [{ kind: "Video" as const, name: "V1", clips }] : []),
      ...(opts.source.hasAudio ? [{ kind: "Audio" as const, name: "A1", clips }] : []),
    ],
  };
  return buildOtio(assembly);
}
```

- [ ] **Step 4: Rodar o teste unitário**

Run: `npx vitest run apps/cli/src/app/cut-otio.test.ts`
Expected: PASS.

- [ ] **Step 5: Escrever o teste da rota**

Adicione ao final de `apps/cli/src/app/server.test.ts` (no bloco `describe` onde vive o teste `export srt achata o transcript...`; confira que `copyFile` e `FIXTURES` estão importados no arquivo — se faltarem, acrescente ao import de `node:fs/promises` e importe `FIXTURES` de `"../../../../../tests/fixtures/global-setup.ts"`):

```ts
  it("export otio entrega timeline racional para o fluxo limpar", async () => {
    const { base, app, dir } = await bootComPlano();
    await copyFile(join(FIXTURES, "clip.mp4"), join(dir, "v.mp4"));
    await writeFile(join(dir, "out", "condense_plan.json"), JSON.stringify({
      source_duration: 3, output_duration: 2.5,
      clips: [{ unit_ids: ["u001"], start: 0.5, end: 1.5 }, { unit_ids: ["u002"], start: 2, end: 2.5 }],
      joins: [],
    }), "utf8");
    const res = await fetch(`${base}/jobs/${app.jobId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "otio" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { downloadUrl: string };
    expect(body.downloadUrl).toBe(`/jobs/${app.jobId}/download/otio`);
    const doc = JSON.parse(await readFile(join(dir, "corte.otio"), "utf8")) as {
      metadata: { Resolve: { timelineFrameRate: string } };
      tracks: { children: { name: string; children: unknown[] }[] };
    };
    // clip.mp4 real: 25 fps, 320x240, 3 s.
    expect(doc.metadata.Resolve.timelineFrameRate).toBe("25");
    const v1 = doc.tracks.children.find((t) => t.name === "V1")!;
    const a1 = doc.tracks.children.find((t) => t.name === "A1")!;
    expect(v1.children).toHaveLength(2);
    expect(a1.children).toHaveLength(2);
    const dl = await fetch(`${base}${body.downloadUrl}`);
    expect(dl.status).toBe(200);
  });
```

- [ ] **Step 6: Implementar a rota**

Em `apps/cli/src/app/server.ts`:

1. Adicione aos imports: `import { hashFile, probe } from "@decupa/media";` e `import { buildCutOtio } from "./cut-otio.ts";`
2. Logo após o bloco `if (kind === "edl") { ... }` (por volta da linha 369), adicione:

```ts
          if (kind === "otio") {
            // Taxa racional do arquivo, nunca arredondada: 29,97 sai correto
            // no Resolve sem o erro fatal do EDL non-drop-frame.
            const info = await probe(input);
            const out = join(workDir, "corte.otio");
            await writeFile(out, `${buildCutOtio({
              clips: plan.clips,
              source: {
                path: input,
                sha256: await hashFile(input),
                durationSeconds: Math.max(info.durationMs / 1000, 0.001),
                hasVideo: info.hasVideo,
                hasAudio: info.hasAudio,
                fps: info.frameRate,
                width: info.width,
                height: info.height,
                name: basename(input),
              },
              title: basename(input),
            })}\n`, "utf8");
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/otio` });
            return;
          }
```

3. No mapa de downloads (por volta da linha 411), acrescente a linha:

```ts
            otio: join(workDir, "corte.otio"),
```

- [ ] **Step 7: Rodar os testes do server**

Run: `npx vitest run apps/cli/src/app/server.test.ts`
Expected: PASS em todos.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/app/cut-otio.ts apps/cli/src/app/cut-otio.test.ts apps/cli/src/app/server.ts apps/cli/src/app/server.test.ts
git commit -m "feat: exportação OTIO no fluxo limpar aceita fps fracionário"
```

---

### Task 9: EDL drop-frame 29,97 (auditoria #6b)

`buildEdl` recusa qualquer fps não inteiro. O CMX3600 tem formato drop-frame consagrado para 30000/1001 (`FCM: DROP FRAME`, separador `;`, pulando os frames 0-1 de cada minuto exceto a cada 10 minutos). Outras taxas fracionárias (23,976) continuam recusadas com instrução para o OTIO da Task 8.

**Files:**
- Modify: `apps/cli/src/app/edl.ts` (aceitação de 29,97 + `dropFrameTimecode`)
- Modify: `apps/cli/src/app/pipeline.ts:412-437` (`probeFps` libera 30000/1001)
- Test: `apps/cli/src/app/edl.test.ts` e `apps/cli/src/app/pipeline.test.ts:222-234`

**Interfaces:**
- Consumes: `buildEdl(opts)` existente; `probeFps(job, exec)` existente.
- Produces: `dropFrameTimecode(totalFrames: number): string` (exportado, formato `HH:MM:SS;FF` a 30000/1001). `buildEdl` passa a aceitar `fps === 30000/1001` (tolerância 1e-6) emitindo `FCM: DROP FRAME`.

- [ ] **Step 1: Escrever os testes de timecode drop-frame**

Adicione ao final de `apps/cli/src/app/edl.test.ts` (confira o import de `buildEdl`; acrescente `dropFrameTimecode`):

```ts
import { dropFrameTimecode } from "./edl.ts";
```

```ts
it("drop-frame 29,97 bate nas âncoras SMPTE", () => {
  // Real 30000/1001: pulos de 2 frames por minuto, exceto a cada 10 min.
  expect(dropFrameTimecode(0)).toBe("00:00:00;00");
  expect(dropFrameTimecode(1799)).toBe("00:00:59;29");
  expect(dropFrameTimecode(1800)).toBe("00:01:00;02");
  expect(dropFrameTimecode(17982)).toBe("00:10:00;00");
  expect(dropFrameTimecode(18000)).toBe("00:10:00;18");
  expect(dropFrameTimecode(5395)).toBe("00:01:59;29");
  expect(dropFrameTimecode(5396)).toBe("00:02:00;02");
});

it("buildEdl aceita 29,97 com FCM DROP FRAME", () => {
  const fps = 30000 / 1001;
  const edl = buildEdl({ clips: [{ start: 60, end: 61 }], fps, title: "t" });
  expect(edl).toContain("FCM: DROP FRAME");
  // 60 s → frame 1798 (00:00:59;28); 61 s → frame 1828 (00:01:01;00).
  expect(edl).toContain("00:00:59;28 00:01:01;00 00:00:59;28 00:01:01;00");
});

it("buildEdl recusa 23,976 com instrução de OTIO", () => {
  expect(() => buildEdl({ clips: [{ start: 0, end: 1 }], fps: 24000 / 1001, title: "t" }))
    .toThrow(/OTIO/);
});
```

- [ ] **Step 2: Escrever o teste do `probeFps`**

Em `apps/cli/src/app/pipeline.test.ts`, bloco `describe("probeFps")`: o caso existente que espera `/29\.97/` para fps fracionário deve passar a usar `"24000/1001\n"` no stdout e esperar `/OTIO/` (23,976 segue recusado no EDL). Adicione também:

```ts
  it("aceita 30000/1001 para o EDL drop-frame", async () => {
    const job = { id: "j", videoPath: "/tmp/x.mp4", workDir: "/tmp" };
    expect(await probeFps(job, new FakeExecutor({ stdout: "30000/1001\n" })))
      .toBeCloseTo(30000 / 1001, 9);
  });
```

(confira o formato do `PipelineJob` usado pelos casos vizinhos e alinhe o objeto `job` a eles.)

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/edl.test.ts apps/cli/src/app/pipeline.test.ts`
Expected: FAIL — `dropFrameTimecode` não existe; `buildEdl`/`probeFps` recusam 29,97.

- [ ] **Step 4: Implementar o drop-frame em `edl.ts`**

Substitua o corpo de `buildEdl` e acrescente o helper (mantendo `timecode` e `EdlClip` como estão; atualize o docblock de escopo):

```ts
/** 29,97 drop-frame: frames reais por bloco de 10 min e por minuto com pulo. */
const DF_FRAMES_PER_10_MIN = 17982;
const DF_FRAMES_PER_DROP_MIN = 1798;
const DF_DROP_PER_MINUTE = 2;
const DF_NOMINAL = 30;

/**
 * Timecode CMX3600 drop-frame (30000/1001): soma de volta os frames pulados
 * (2 por minuto, exceto minute 0 de cada decade) e decompõe na taxa nominal
 * de 30 com separador `;`.
 */
export function dropFrameTimecode(totalFrames: number): string {
  const decades = Math.floor(totalFrames / DF_FRAMES_PER_10_MIN);
  const rem = totalFrames % DF_FRAMES_PER_10_MIN;
  const dropMinutes = rem < DF_DROP_PER_MINUTE
    ? 0
    : Math.floor((rem - DF_DROP_PER_MINUTE) / DF_FRAMES_PER_DROP_MIN);
  const nominal = totalFrames + 18 * decades + DF_DROP_PER_MINUTE * dropMinutes;
  const frame = nominal % DF_NOMINAL;
  const whole = Math.floor(nominal / DF_NOMINAL);
  const parts = [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60, frame];
  return parts.map((n) => String(n).padStart(2, "0")).join(";");
}
```

E em `buildEdl`, substitua a validação e a montagem por:

```ts
  const { clips, fps, title } = opts;
  const sourceName = opts.sourceName ?? title;
  if (clips.length === 0) throw new Error("nenhum clipe para exportar");
  const dropFrame = Math.abs(fps - 30000 / 1001) < 1e-6;
  if (!Number.isInteger(fps) && !dropFrame) {
    throw new Error(
      `frame rate ${fps.toFixed(3)} sem suporte no EDL. Use 29,97 (drop-frame) ` +
      "ou exporte OTIO; outras taxas fracionárias sairiam com deriva crescente.",
    );
  }

  const frameToTimecode = dropFrame
    ? dropFrameTimecode
    : (frames: number) => timecode(frames / fps, fps);

  const lines = [`TITLE: ${title}`, dropFrame ? "FCM: DROP FRAME" : "FCM: NON-DROP FRAME", ""];
  let recordFrames = 0;

  clips.forEach((clip, i) => {
    const startFrames = Math.round(clip.start * fps);
    const endFrames = Math.round(clip.end * fps);
    const durationFrames = endFrames - startFrames;
    lines.push(
      `${String(i + 1).padStart(3, "0")}  AX       V     C        ` +
      `${frameToTimecode(startFrames)} ${frameToTimecode(endFrames)} ` +
      `${frameToTimecode(recordFrames)} ${frameToTimecode(recordFrames + durationFrames)}`,
    );
    // `AX` no campo de reel significa "sem reel atribuído", e o campo tem só 8
    // caracteres — não cabe nome de arquivo. `* FROM CLIP NAME:` é como o
    // CMX3600 carrega a origem, e é o que a NLE lê para relinkar. Sem esta
    // linha o EDL abre, mas apontar cada corte para o arquivo é trabalho
    // manual.
    lines.push(`* FROM CLIP NAME: ${sourceName}`);
    recordFrames += durationFrames;
  });

  return `${lines.join("\n")}\n`;
```

(O caminho non-drop-frame passa pela conversão frames→segundos→frames, que é exata em double para durações de vídeo — a saída NDF fica byte a byte igual à anterior.)

- [ ] **Step 5: Liberar 30000/1001 no `probeFps`**

Em `apps/cli/src/app/pipeline.ts`, substitua o cheque de `probeFps` (linhas 428-436) por:

```ts
  const [num, den] = stdout.trim().split("/").map(Number);
  const fps = den ? num! / den! : num!;
  // 29,97 tem EDL drop-frame (edl.ts); o resto fracionário segue recusado
  // em vez de virar timecode com deriva crescente que ninguém percebe.
  if (!Number.isInteger(fps) && Math.abs(fps - 30000 / 1001) > 1e-6) {
    throw new Error(
      `o vídeo tem ${fps.toFixed(2)} fps, sem suporte no EDL. Exporte OTIO ` +
      "(qualquer taxa), EDL drop-frame 29,97, ou converta a fonte para fps inteiro.",
    );
  }
  return fps;
```

(e atualize o docblock da função, que hoje diz "fracionário estoura aqui".)

- [ ] **Step 6: Rodar os testes de edl e pipeline**

Run: `npx vitest run apps/cli/src/app/edl.test.ts apps/cli/src/app/pipeline.test.ts`
Expected: PASS em todos.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/app/edl.ts apps/cli/src/app/edl.test.ts apps/cli/src/app/pipeline.ts apps/cli/src/app/pipeline.test.ts
git commit -m "feat: EDL drop-frame 29,97 no fluxo limpar"
```

---

### Task 10: Preparação órfã em `running` vira `interrupted` (auditoria #8)

Se o servidor morrer durante a preparação, o `project.json` fica com `preparation.status === "running"` para sempre e a UI trava. A reconciliação roda no `GET /project`: status `running` **sem percurso vivo neste processo** (mapa `prepActive`) vira `interrupted` retomável.

**Files:**
- Modify: `apps/cli/src/app/assembly/preparation.ts` (nova função exportada ao final)
- Modify: `apps/cli/src/app/assembly/routes.ts:14` (import) e `:455-459` (handler `GET /project`)
- Test: `apps/cli/src/app/assembly/routes.test.ts`

**Interfaces:**
- Consumes: `prepActive` (mapa module-level já existente em `preparation.ts`), `loadProject`/`saveProject` de `./store.ts`.
- Produces: `reconcileStalePreparation(dir: string): Promise<void>` — exportado de `preparation.ts`.

- [ ] **Step 1: Escrever o teste**

Adicione ao final de `apps/cli/src/app/assembly/routes.test.ts`:

```ts
it("GET do projeto reconcilia preparação órfã de servidor reiniciado", async () => {
  const { base, dir } = await boot();
  const opened = await loadProject(dir);
  await saveProject(dir, opened.revision, (p) => ({
    ...p,
    preparation: {
      id: "prep-x", revision: p.revision, mode: "prepare", request: "r",
      status: "running", stage: "media", sources: {},
    },
  }));
  const body = await (await fetch(`${base}/project`)).json() as {
    project: { preparation: { status: string; error?: string } };
  };
  expect(body.project.preparation.status).toBe("interrupted");
  expect(body.project.preparation.error).toContain("retome");
  // Idempotente: um segundo GET não tenta reconciliar de novo.
  const again = await (await fetch(`${base}/project`)).json() as {
    project: { preparation: { status: string } };
  };
  expect(again.project.preparation.status).toBe("interrupted");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/routes.test.ts`
Expected: FAIL — o status devolvido continua `"running"`.

- [ ] **Step 3: Implementar a reconciliação**

Ao final de `apps/cli/src/app/assembly/preparation.ts`, acrescente:

```ts
/**
 * Recuperação pós-reinício: preparação `running` sem percurso vivo NESTE
 * processo é de um servidor que morreu no meio — vira `interrupted`
 * retomável em vez de travar a interface para sempre.
 */
export async function reconcileStalePreparation(dir: string): Promise<void> {
  let project: Project;
  try {
    project = await loadProject(dir);
  } catch {
    return;
  }
  const prep = project.preparation;
  if (!prep || prep.status !== "running") return;
  if ((prepActive.get(dir) ?? 0) > 0) return;
  try {
    await saveProject(dir, project.revision, (p) =>
      p.preparation?.id === prep.id && p.preparation.status === "running"
        ? {
          ...p,
          preparation: {
            ...p.preparation,
            status: "interrupted",
            error: "servidor reiniciado durante a preparação; retome para prosseguir",
          },
        }
        : p,
    );
  } catch {
    // Corrida com um percurso real: o runner decide o estado final.
  }
}
```

Em `apps/cli/src/app/assembly/routes.ts`, atualize o import da linha 14 para:

```ts
import { reconcileStalePreparation, runPreparation } from "./preparation.ts";
```

e o handler `GET /project` (linhas 455-459) para:

```ts
      if (parts.length === 1 && req.method === "GET") {
        await reconcileStalePreparation(dir);
        const project = await loadProject(dir);
        sendJson(res, { project, ...snapshot() });
        return true;
      }
```

- [ ] **Step 4: Rodar os testes de routes e preparation**

Run: `npx vitest run apps/cli/src/app/assembly/routes.test.ts apps/cli/src/app/assembly/preparation.test.ts`
Expected: PASS em todos (os testes de `runPreparation` não criam status `running` órfão no load, então não são afetados).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/assembly/preparation.ts apps/cli/src/app/assembly/routes.ts apps/cli/src/app/assembly/routes.test.ts
git commit -m "fix: preparação órfã de servidor reiniciado vira interrupted retomável"
```

---

### Task 11: Waveform com resolução dinâmica por duração (auditoria #9)

`buildPeaks` fixa 1000 buckets — 3,6 s/bucket para 1 h de vídeo, achatando a faixa de navegação. A densidade passa a ser ~20 picos/s com piso 500 e teto 10000, derivada do próprio PCM lido (count / taxa de amostragem), sem tocar o chamador. O consumidor da UI (`sequencia.js`) já é agnóstico ao número de buckets (usa `peaks.count / peaks.peaks.length`).

**Files:**
- Modify: `apps/cli/src/app/assembly/waveform.ts:40-46` (nova função + default dinâmico)
- Test: `apps/cli/src/app/assembly/waveform.test.ts`

**Interfaces:**
- Consumes: `PEAKS_SAMPLE_RATE` (8000) já exportado; `opts.buckets` opcional permanece como override explícito.
- Produces: `defaultPeaksBuckets(durationSeconds: number): number` — exportado, `max(500, min(10000, round(duração × 20)))`.

- [ ] **Step 1: Escrever os testes**

Adicione ao final de `apps/cli/src/app/assembly/waveform.test.ts` (acrescente `defaultPeaksBuckets` ao import de `./waveform.ts`):

```ts
it("buckets padrão escalam com a duração (20/s, piso 500, teto 10000)", () => {
  expect(defaultPeaksBuckets(1)).toBe(500);
  expect(defaultPeaksBuckets(400)).toBe(8000);
  expect(defaultPeaksBuckets(600)).toBe(10000);
});

it("buildPeaks sem buckets explícitos usa a densidade dinâmica", async () => {
  const dir = await mkdtemp(join(tmpdir(), "waveform-"));
  const outPath = peaksPath(dir, SHA);
  // PCM determinístico de 1 s a 8 kHz → piso de 500 buckets.
  const result = await buildPeaks(
    pcmExec(deterministicPcm()),
    { proxyPath: join(dir, "proxy.mp4"), sha256: SHA, outPath },
  );
  expect(result!.buckets).toBe(500);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/waveform.test.ts`
Expected: FAIL — `defaultPeaksBuckets` não existe e o default hoje é 1000.

- [ ] **Step 3: Implementar**

Em `apps/cli/src/app/assembly/waveform.ts`:

1. Acrescente antes de `buildPeaks`:

```ts
/** Densidade alvo: ~20 picos/s, com piso e teto para curtos e longos. */
export function defaultPeaksBuckets(durationSeconds: number): number {
  return Math.max(500, Math.min(10000, Math.round(durationSeconds * 20)));
}
```

2. Remova a linha `const buckets = opts.buckets ?? 1000;` do início de `buildPeaks` e, logo após `if (count === 0) return null;`, insira:

```ts
    const buckets = opts.buckets ?? defaultPeaksBuckets(count / PEAKS_SAMPLE_RATE);
    if (!Number.isSafeInteger(buckets) || buckets <= 0) return null;
```

(mantendo a validação existente de `proxyPath`/`sha256`/`outPath` onde está).

- [ ] **Step 4: Rodar os testes de waveform**

Run: `npx vitest run apps/cli/src/app/assembly/waveform.test.ts`
Expected: PASS em todos (os testes com `buckets` explícito não mudam de comportamento).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/app/assembly/waveform.ts apps/cli/src/app/assembly/waveform.test.ts
git commit -m "feat: waveform com densidade de picos dinâmica por duração"
```

---

### Task 12: Harness de importação real no DaVinci Resolve — Gate G6 (auditoria #10)

Nenhum OTIO do decupa foi aberto no Resolve de verdade; a prova atual é decodificação FFmpeg sintética. Este harness importa o OTIO num projeto descartável via API de scripting e confere pistas/clipes/mídias online contra o próprio OTIO. **Caveat conhecido do ambiente** (`otio.ts:123`): `scriptapp(Resolve)` pode devolver `None` neste Mac — o script trata isso com código de saída dedicado (3) e a evidência registra o resultado honesto (pass ou unavailable), sem fingir validação.

**Files:**
- Create: `scripts/davinci-verify.py`
- Create: `docs/superpowers/evidence/2026-09-12-g6-importacao-davinci.md`

**Interfaces:**
- Consumes: OTIO gerado por `scripts/assembly-proof.ts` (escreve `work/assembly-proof/<run>/timeline.otio`); DaVinci Resolve instalado em `/Applications/DaVinci Resolve` (confirmado nesta máquina).
- Produces: `scripts/davinci-verify.py --otio <caminho>` → JSON no stdout; exit 0 = pass, 1 = divergência, 2 = uso, 3 = scripting indisponível.

- [ ] **Step 1: Criar o script Python**

Crie `scripts/davinci-verify.py`:

```python
#!/usr/bin/env python3
"""Prova G6: importa um OTIO do decupa num projeto descartável do DaVinci
Resolve e confere pistas/clipes/mídias online contra o próprio OTIO.

Saída: relatório JSON no stdout.
Códigos de saída: 0 passou · 1 divergência/falha · 2 uso · 3 scripting
indisponível (scriptapp pode devolver None nesta máquina — aí a prova
segue manual pela UI, registrado honestamente na evidência).
"""
import argparse
import json
import os
import sys

RESOLVE_MODULES = "/Applications/DaVinci Resolve/Developer/Scripting/modules"
RESOLVE_LIB = (
    "/Applications/DaVinci Resolve/Libraries/Frameworks/"
    "DaVinciResolve.framework/Versions/Current/MacOS"
)


def report(status, **extra):
    print(json.dumps({"status": status, **extra}, ensure_ascii=False, indent=2))


def expected_from_otio(path):
    """Contagens por tipo de pista: Clip.1 por Track.1, na ordem do arquivo."""
    with open(path, encoding="utf-8") as handle:
        doc = json.load(handle)
    video, audio = [], []
    for track in doc["tracks"]["children"]:
        kind = track.get("kind")
        clips = [c for c in track["children"] if c.get("OTIO_SCHEMA") == "Clip.1"]
        (video if kind == "Video" else audio).append(len(clips))
    return {"video": sorted(video), "audio": sorted(audio)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--otio", required=True, help="caminho do timeline.otio")
    args = ap.parse_args()
    otio = os.path.abspath(args.otio)
    if not os.path.isfile(otio):
        report("fail", error=f"otio ausente: {otio}")
        return 1

    sys.path.insert(0, RESOLVE_MODULES)
    os.environ.setdefault("RESOLVE_SCRIPT_LIB", RESOLVE_LIB)
    try:
        import DaVinciResolveScript as dvr
    except Exception as err:  # noqa: BLE001
        report("unavailable", reason=f"módulo de scripting não importou: {err}")
        return 3
    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        report(
            "unavailable",
            reason="scriptapp(Resolve) devolveu None (Resolve fechado ou API bloqueada)",
        )
        return 3

    expected = expected_from_otio(otio)
    pm = resolve.GetProjectManager()
    name = f"decupa-proof-{os.getpid()}"
    project = pm.CreateProject(name)
    if project is None:
        report("fail", error="não criou projeto temporário")
        return 1
    try:
        timeline = project.ImportTimelineFromFile(otio)
        if timeline is None:
            report("fail", error="ImportTimelineFromFile devolveu None")
            return 1
        actual = {"video": [], "audio": []}
        offline = []
        for kind in ("video", "audio"):
            total = timeline.GetTrackCount(kind)
            for index in range(1, total + 1):
                items = timeline.GetItemListInTrack(kind, index) or []
                actual[kind].append(len(items))
                for item in items:
                    if item.GetClipProperty("Status") != "Online":
                        offline.append(item.GetName())
        ok = (
            sorted(actual["video"]) == expected["video"]
            and sorted(actual["audio"]) == expected["audio"]
            and not offline
        )
        report(
            "pass" if ok else "fail",
            expected=expected,
            actual={k: sorted(v) for k, v in actual.items()},
            offline=offline,
            timeline=timeline.GetName(),
        )
        return 0 if ok else 1
    finally:
        pm.DeleteProject(name)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Checagem de sintaxe**

Run: `python3 -m py_compile scripts/davinci-verify.py && chmod +x scripts/davinci-verify.py`
Expected: sem saída, exit 0.

- [ ] **Step 3: Gerar o OTIO de prova com o fluxo existente**

Run: `node --experimental-strip-types scripts/assembly-proof.ts`
Expected: executa e grava `work/assembly-proof/<run>/timeline.otio` (+ `report.json`). Descubra o run mais recente com `ls -t work/assembly-proof | head -1`.

- [ ] **Step 4: Rodar a verificação e registrar a evidência**

Run (com DaVinci fechado ou aberto — ambos são resultados válidos):

```bash
python3 scripts/davinci-verify.py --otio "work/assembly-proof/<run>/timeline.otio" | tee /tmp/g6.json; echo "exit=$?"
```

Expected: exit 0 com `"status": "pass"`, **ou** exit 3 com `"status": "unavailable"` (scriptapp `None` — caso documentado). Exit 1 é falha real a investigar.

Crie `docs/superpowers/evidence/2026-09-12-g6-importacao-davinci.md` com o conteúdo real da execução:

```markdown
# Gate G6 — Importação real de OTIO no DaVinci Resolve (2026-09-12)

- Comando: `python3 scripts/davinci-verify.py --otio work/assembly-proof/<run>/timeline.otio`
- Saída (colar o JSON do /tmp/g6.json): <status, expected/actual, offline>
- Código de saída: <0 | 3>
- Interpretação: <pass → pistas e clipes batem com o OTIO e mídias online |
  unavailable → scriptapp indisponível nesta máquina; prova pela UI segue
  pendente, agora com harness pronto para reexecutar>
- Pendente pós-harness: execução visual pela UI conforme
  `davinciImportSettings` (procedure em `apps/cli/src/app/assembly/otio.ts`).
```

- [ ] **Step 5: Commit**

```bash
git add scripts/davinci-verify.py docs/superpowers/evidence/2026-09-12-g6-importacao-davinci.md
git commit -m "feat: harness de importação real de OTIO no DaVinci Resolve (G6)"
```

---

## Verificação final (após todas as tarefas)

- [ ] `pnpm test` — suíte completa verde (com e sem `ZAI_API_KEY` no ambiente).
- [ ] `pnpm run typecheck` — sem erros.
- [ ] `git status` limpo exceto a mudança pré-existente do usuário em `.gitignore` (`.foglamp/`), que permanece não commitada.
- [ ] Marcar os checkboxes deste plano conforme as tarefas forem concluídas.

## Mapa auditoria → tarefas

| Auditoria # | Tarefa(s) |
|---|---|
| 1 (B-roll, ICE 810) | Task 2 |
| 2 (OTIO rates) | Task 4 |
| 3 (micro-slivers) | Task 3 |
| 4 (rebase correção) | Task 5 |
| 5 (I/O duplicado) | Task 6 + Task 7 |
| 6 (fps fracionário) | Task 8 + Task 9 |
| 7 (env vitest) | Task 1 |
| 8 (preparação órfã) | Task 10 |
| 9 (waveform) | Task 11 |
| 10 (Gate G6) | Task 12 |
