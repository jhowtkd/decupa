# Análise Visual por Frames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o envio de `video_url` na análise visual do Decupa por lotes de frames JPEG timestampados, preservando a cobertura temporal, retomada e cache por janela.

**Architecture:** O FFmpeg extrairá localmente um frame por segundo de cada janela visual de 20 s, com 1 s de contexto nas janelas seguintes. Um helper isolado converterá os JPEGs temporários em `data:image/jpeg;base64,...`; `model.ts` continuará responsável por prompt, parsing, conversão de tempos, cache e cobertura, mas montará o payload com `image_url` e rótulos de tempo. A versão do cache será incrementada para que análises baseadas em vídeo não sejam reutilizadas como análises baseadas em frames.

**Tech Stack:** TypeScript ESM, Node.js `fs/promises`, Vitest, FFmpeg via o `Executor` existente, cliente OpenAI-compatible já instalado; nenhuma dependência nova.

**Spec:** User request in this conversation; existing visual contract in `docs/superpowers/plans/2026-09-11-montagem-multiarquivo.md` (Tarefa 6) and temporal-coverage requirements in `docs/superpowers/specs/2026-09-12-inspiracao-de-edicao-design.md`.

## Global Constraints

- Manter janelas de 20 s, contexto de 1 s e amostragem inicial de 1 FPS; aumentar a densidade exige uma decisão separada baseada em evidência.
- Preservar intervalos semiabertos `[start, end)`, `visualCoverage`, retomada por janela e o bloqueio quando existir lacuna visual.
- O payload remoto deve conter `image_url`, nunca `video_url`; o texto deve identificar o segundo de cada frame na fonte e o intervalo solicitado.
- Usar apenas o `Executor` existente para FFmpeg; não criar shell strings, subprocessos paralelos ou dependências novas.
- Frames JPEG são temporários e devem ser removidos em `finally`; somente o envelope JSON de análise permanece em cache, publicado por rename atômico.
- Incrementar a versão do prompt/cache; cache antigo de vídeo não pode ser aceito silenciosamente.
- Nenhum teste chama provedor externo, lê chave real ou autoriza cobrança. Endpoint completo `/chat/completions` e modelo compatível com imagens continuam sendo pré-requisitos de runtime.
- Não fabricar spans quando a extração falhar, não marcar visual como pronto por fallback e não alterar automaticamente `/Users/jhonatan/.decupa/credentials`.

---

### Task 1: Extrator de frames temporários

**Files:**
- Create: `apps/cli/src/app/assembly/frames.ts`
- Create: `apps/cli/src/app/assembly/frames.test.ts`

**Interfaces:**
- Consumes: `Source` de `assembly/types.ts`, `Executor` de `app/pipeline.ts` e janelas `{ start, end, fetchStart }` calculadas por `visualWindows`.
- Produces: `VisualWindow`, `VisualFrame` e `extractVisualFrames(source, window, cacheDir, exec)` para o modelo visual.

~~~ts
export type VisualWindow = { start: number; end: number; fetchStart: number };

export type VisualFrame = {
  sourceSecond: number;
  dataUrl: string;
};

export function extractVisualFrames(
  source: Source,
  window: VisualWindow,
  cacheDir: string,
  exec: Executor,
): Promise<VisualFrame[]>;
~~~

- [ ] **Step 1: Write the failing tests**

Add a fake executor that records the FFmpeg call and writes two deterministic files named `frame-001.jpg` and `frame-002.jpg` into the output directory passed as the final argument. Cover the normal result and the non-zero FFmpeg result:

~~~ts
it("extrai JPEGs a 1 FPS e etiqueta cada frame pelo segundo da fonte", async () => {
  const seen: ExecCall[] = [];
  const exec: Executor = {
    async run(call) {
      seen.push(call);
      const pattern = call.args.at(-1)!;
      await mkdir(dirname(pattern), { recursive: true });
      await writeFile(pattern.replace("%03d", "001"), "jpeg-a");
      await writeFile(pattern.replace("%03d", "002"), "jpeg-b");
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const frames = await extractVisualFrames(source, { start: 20, end: 22, fetchStart: 19 }, cacheDir, exec);

  expect(frames.map((frame) => frame.sourceSecond)).toEqual([19, 20]);
  expect(frames[0]?.dataUrl).toBe(
    "data:image/jpeg;base64," + Buffer.from("jpeg-a").toString("base64"),
  );
  expect(seen[0]?.args).toEqual(expect.arrayContaining(["-ss", "19", "-t", "3"]));
  expect(seen[0]?.args.find((arg) => arg.includes("fps=1"))).toContain("fps=1");
});

it("não transforma falha do FFmpeg em análise vazia", async () => {
  const window = { start: 0, end: 2, fetchStart: 0 };
  const exec: Executor = {
    async run() { return { code: 1, stdout: "", stderr: "ffmpeg quebrou" }; },
  };
  await expect(extractVisualFrames(source, window, cacheDir, exec))
    .rejects.toThrow(/extração de frames/);
});
~~~

Use uma `Source` fixture com `id: "a"`, duração suficiente, `hasVideo: true` e um arquivo temporário; crie `cacheDir` antes da chamada. O primeiro teste deve verificar também que o diretório temporário não precisa aparecer no cache final.

- [ ] **Step 2: Run tests to verify they fail**

Run:

~~~bash
pnpm exec vitest run apps/cli/src/app/assembly/frames.test.ts
~~~

Expected: FAIL because `frames.ts` and `extractVisualFrames` do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Implement `extractVisualFrames` in `frames.ts` with `mkdtemp`, `readdir`, `readFile`, `rm` e `join` de `node:fs/promises`/ `node:path`:

~~~ts
const tempDir = await mkdtemp(join(cacheDir, "frames-"));
try {
  const pattern = join(tempDir, "frame-%03d.jpg");
  const result = await exec.run({
    command: "ffmpeg",
    args: [
      "-n", "-i", source.path,
      "-ss", String(window.fetchStart),
      "-t", String(window.end - window.fetchStart),
      "-vf", "fps=1,scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
      "-an", "-q:v", "5", pattern,
    ],
  });
  if (result.code !== 0) {
    throw new Error(
      "extração de frames [" + window.fetchStart + ", " + window.end +
      ") falhou (código " + result.code + "): " +
      (result.stderr || result.stdout).trim().slice(0, 300),
    );
  }

  const names = (await readdir(tempDir))
    .filter((name) => /^frame-\d+\.jpg$/.test(name))
    .sort()
    .filter((_, index) => window.fetchStart + index < window.end);
  if (names.length === 0) {
    throw new Error(
      "extração de frames [" + window.fetchStart + ", " + window.end +
      ") não produziu frames",
    );
  }

  return Promise.all(names.map(async (name, index) => ({
    sourceSecond: window.fetchStart + index,
    dataUrl: "data:image/jpeg;base64," +
      (await readFile(join(tempDir, name))).toString("base64"),
  })));
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
~~~

Filter timestamps at or beyond `window.end` if FFmpeg produces an extra boundary frame. Preserve the output-seek order (`-i` before `-ss`) so frame timestamps remain aligned with the existing visual-window contract. A non-zero FFmpeg result and an empty output directory must both be errors.

- [ ] **Step 4: Run tests to verify they pass**

Run:

~~~bash
pnpm exec vitest run apps/cli/src/app/assembly/frames.test.ts
~~~

Expected: PASS for frame ordering, JPEG data URLs, 1 FPS arguments and explicit FFmpeg failure.

- [ ] **Step 5: Commit**

~~~bash
git add apps/cli/src/app/assembly/frames.ts apps/cli/src/app/assembly/frames.test.ts
git commit -m "feat: extract timestamped visual frames"
~~~

### Task 2: Trocar o payload visual e invalidar o cache antigo

**Files:**
- Modify: `apps/cli/src/app/assembly/model.ts:1-280`
- Modify: `apps/cli/src/app/assembly/model.test.ts:1-300`

**Interfaces:**
- Consumes: `extractVisualFrames`, `VisualFrame` e `VisualWindow` da Task 1; `visualWindows`, `validateVisual`, `mergeAdjacent` e `visualCoverage` permanecem no módulo visual existente.
- Produces: `describeSource` com o mesmo retorno `Promise<VisualSpan[]>`, mas com mensagens contendo apenas frames JPEG e cache `visual-v3-frames`.

- [ ] **Step 1: Write the failing payload test**

Replace the existing fake client assertion that searches for `video_url` with a test that captures all content parts and proves each visual request has `image_url` parts, no `video_url`, and timestamp labels:

~~~ts
it("envia frames JPEG timestampados, nunca video_url", async () => {
  const captured: unknown[][] = [];
  const client = {
    async send(content: unknown[]) {
      captured.push(content);
      return JSON.stringify({
        spans: [{ id: "local-0", start: 0, end: 1, text: "mesa", confidence: "observed", tags: [] }],
      });
    },
  };
  const spans = await describeSource(source, dir, new AbortController().signal, {
    client,
    exec: frameExecutor,
  });

  expect(spans[0]?.text).toBe("mesa");
  const parts = captured[0]!;
  expect(parts.some((part: any) => part.type === "video_url")).toBe(false);
  expect(parts.filter((part: any) => part.type === "image_url").length).toBeGreaterThan(0);
  expect((parts.find((part: any) => part.type === "text") as any).text)
    .toMatch(/frame.*fonte.*0s/i);
});
~~~

Make `frameExecutor` write one JPEG per requested second, based on the output pattern in the FFmpeg args. Keep the existing span-shift, cancellation, complementary-response and cache-resume tests; adapt only their media fake from one MP4 output to numbered JPEG outputs.

- [ ] **Step 2: Run the focused model tests to verify the old contract fails**

Run:

~~~bash
pnpm exec vitest run apps/cli/src/app/assembly/model.test.ts
~~~

Expected: FAIL because the current implementation still emits one `video_url` data URL and the current fake executor writes an MP4-shaped output.

- [ ] **Step 3: Implement the frame payload**

In `model.ts`:

1. Import `extractVisualFrames`, `VisualFrame` and `VisualWindow` from `./frames.ts`.
2. Remove the MP4-specific `windowClip` implementation and its `stat`, `rename` and `unlink` imports that become unused.
3. Change the prompt to state that the model receives timestamped JPEG frames sampled at 1 FPS, not a continuous video. Preserve the JSON schema, confidence values, no-name instruction and explicit `unavailable` rule.
4. Add an internal message builder with this shape:

~~~ts
function frameMessage(frames: VisualFrame[], window: VisualWindow): unknown[] {
  return [
    {
      type: "text",
      text: VISUAL_PROMPT + "\n\n" +
        "intervalo solicitado na fonte: [" + window.start + ", " + window.end + ")\n" +
        "cada imagem abaixo está rotulada pelo segundo da fonte; " +
        "responda usando segundos locais da janela, de 0 a " +
        (window.end - window.fetchStart) + ".",
    },
    ...frames.flatMap((frame) => [
      {
        type: "text",
        text: "FRAME fonte=" + frame.sourceSecond +
          "s local=" + (frame.sourceSecond - window.fetchStart) + "s",
      },
      { type: "image_url", image_url: { url: frame.dataUrl } },
    ]),
  ];
}
~~~

5. Replace the current `readFile(clip)`/`video_url` block with:

~~~ts
const frames = await extractVisualFrames(source, window, cacheDir, exec);
const text = await client.send(frameMessage(frames, window), signal);
~~~

6. Bump `VISUAL_PROMPT_VERSION` from `1` to `2` and `VISUAL_CACHE_VERSION` from `visual-v2` to `visual-v3-frames`. Add `inputMode: "frames"` and `sampleFps: 1` to the cache envelope and reject an envelope missing either field. Keep atomic JSON writes and the existing `windowCovered` gate.
7. Keep `parseLocalSpans` unchanged except for comments that now explain that spans are inferred from timestamped frames. It must still validate local bounds before adding `fetchStart` and must still preserve complementary spans during resume.

- [ ] **Step 4: Run all model tests and fix only regressions caused by the transport change**

Run:

~~~bash
pnpm exec vitest run apps/cli/src/app/assembly/model.test.ts apps/cli/src/app/assembly/frames.test.ts apps/cli/src/app/assembly/visual.test.ts
~~~

Expected: PASS for prompt separation, frame payload shape, source-time remapping, 20-second windows with 1-second context, cancellation, complementary responses, cache reuse and invalidation of old visual envelopes.

- [ ] **Step 5: Commit**

~~~bash
git add apps/cli/src/app/assembly/model.ts apps/cli/src/app/assembly/model.test.ts
git commit -m "feat: send visual analysis as timestamped frames"
~~~

### Task 3: Atualizar onboarding, documentação e gates de verificação

**Files:**
- Modify: `apps/cli/src/app/provider-setup.html:9-11`
- Modify: `docs/setup/GUIA.md:105-116`

**Interfaces:**
- Consumes: o novo contrato de transporte da Task 2.
- Produces: instruções que explicam que o Decupa extrai frames localmente e que o provedor ainda precisa aceitar `image_url` em um endpoint OpenAI-compatible completo.

- [ ] **Step 1: Update the user-facing provider copy**

Change the setup copy from a generic video capability warning to:

~~~html
<p>Para analisar vídeos, o Decupa extrai frames JPEG localmente. Escolha um modelo que aceite imagens no endpoint informado.</p>
~~~

Keep the existing warning that saving does not verify remote key validity, balance or modality support. Do not add a provider call to onboarding.

- [ ] **Step 2: Update the setup guide**

In section 5, state that:

~~~md
Na montagem, o Decupa não envia o vídeo inteiro para a análise visual: extrai localmente frames JPEG a 1 FPS, identifica cada frame pelo segundo da fonte e envia lotes via image_url. O endpoint custom precisa ser um endpoint completo compatível com chat/completions, e o modelo precisa aceitar imagens. Salvar a configuração não verifica saldo, chave ou capacidade remota.
~~~

Also document the intentional limit: 1 FPS is the initial sampling density, so actions shorter than one second can remain uncertain or unavailable; the coverage barrier must prevent unsupported claims from becoming montage evidence.

- [ ] **Step 3: Run the repository checks**

Run from the repository root used to execute the app:

~~~bash
pnpm exec vitest run \
  apps/cli/src/app/assembly/frames.test.ts \
  apps/cli/src/app/assembly/model.test.ts \
  apps/cli/src/app/assembly/visual.test.ts \
  apps/cli/src/app/assembly/preparation.test.ts \
  apps/cli/src/app/assembly/analysis.test.ts \
  apps/cli/src/app/pipeline.test.ts \
  packages/triage/src/openai-compat.test.ts
pnpm typecheck
git diff --check
~~~

Expected: every listed test passes, TypeScript reports no errors, and the diff has no whitespace errors. Do not run a live provider call as part of this check.

- [ ] **Step 4: Commit documentation and verification-ready changes**

~~~bash
git add apps/cli/src/app/provider-setup.html docs/setup/GUIA.md
git commit -m "docs: explain frame-based visual analysis"
~~~

- [ ] **Step 5: Perform the separate runtime gate only with explicit provider authorization**

After the user supplies an endpoint ending in `/chat/completions` and a model confirmed to accept image inputs, start the active project server and use one short authorized video. Confirm all of the following in the project state before retrying the full montage:

~~~text
preparation.stage === "visual" -> "proposal" or "ready"
every included source has visual === "ready"
every included analysis has visualCoverage.missing.length === 0
the saved analysis cache contains inputMode === "frames"
the request payload contains image_url and contains no video_url
~~~

If the provider still rejects the request, preserve the exact remote response and stop; do not retry all 36 sources or invent visual spans. Only after the short sample succeeds should the user authorize `Retomar` for the complete project and then inspect the generated preview manually.

## Self-review

- The existing 20-second window, 1-second context, 1 FPS sampling, timestamp remapping, cache resume and visual coverage barrier are all covered by Tasks 1 and 2.
- The payload contract is explicit: `image_url` is tested and `video_url` is rejected by assertion.
- No test, onboarding path or plan step changes credentials or makes a paid call.
- The old MP4 cache is invalidated by `visual-v3-frames`; no destructive cleanup of existing project data is required.
- The endpoint/model configuration remains a separate runtime gate because frames cannot make an invalid endpoint or non-visual model accept the request.
