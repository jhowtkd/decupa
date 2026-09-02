# Bancada de Medição Decupa — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir a bancada que responde, com número, se a tese do Decupa fica de pé — medindo o erro de fronteira de palavra do alinhamento forçado em PT-BR e derivando gold edits automaticamente a partir de pares bruto/editado que o time já produziu.

**Architecture:** Monorepo pnpm com pacotes TypeScript puros (sem dependência de editor, sem servidor, sem banco) e um sidecar Python para fala. Todo tempo trafega como **milissegundo inteiro**. Todo pacote é testável offline: os fixtures são gerados por `ffmpeg` e por `say` no `globalSetup` do vitest, então nenhum teste depende de footage real nem de rede.

**Tech Stack:** Node 26 · pnpm workspaces · TypeScript (ESM, strict) · vitest · ffmpeg/ffprobe 8 · Python 3.11 via uv · WhisperX (Whisper + forced alignment wav2vec2)

**Spec:**
- Arquitetura (rev. 3): https://claude.ai/code/artifact/772e8ac4-2b31-4467-8d53-f79a4f76f13a
- Plano de fases: https://claude.ai/code/artifact/de100441-fffc-47be-b811-45f2579f90b2

Este plano implementa a **Fase 0, partes 1, 2, 4 e 6** do plano de fases. A parte 3 (linha de base humana) é cronometragem do processo atual do time, não software — não gera tarefa aqui, mas precisa acontecer em paralelo, porque é contra ela que o portão da Fase 1 é medido. A parte 5 (bake-off dos três pipelines A/B/C, que precisa de chave da API do Gemini e do dataset já coletado) é um plano separado que consome tudo o que este entrega.

---

## Global Constraints

Valem para toda tarefa deste plano. Copiadas da spec.

- **R1 — o motor não importa nada de editor.** Nenhum pacote sob `packages/` pode importar OpenCut, React, ou qualquer tipo de UI. Se precisar, o desenho está errado.
- **R2 — modelo nunca devolve segundo.** Nenhuma saída de LLM vira timestamp diretamente. (Não exercitado neste plano, mas as assinaturas já respeitam.)
- **R3 — fase termina em número.** Cada tarefa entrega função medida por teste, não demo.
- **R4 — nada de composição.** Sem overlay, transição, efeito ou legenda queimada.
- **Unidade de tempo:** milissegundo **inteiro** (`number`, sempre `Math.round`) em toda API pública. Nunca segundo fracionário atravessando fronteira de módulo.
- **Áudio de trabalho:** WAV PCM `s16le`, **16000 Hz, mono**. Todo módulo acústico assume isso.
- **Formato de ID de token:** `w_` + índice global com 6 dígitos zero-padded — `w_000318`.
- **Node:** `>=22`. Ambiente de referência: 26.7.0.
- **Python:** fixar **3.11** via uv. Não usar o 3.14 do sistema — `torch`/`ctranslate2` não têm wheels para ele.
- **ffmpeg/ffprobe:** do PATH. Ambiente de referência: 8.1.2 via Homebrew.
- **Idioma:** prosa e mensagens de commit em português; identificadores, tipos e comentários de código em inglês.

## Escopo

**Entra:** `@decupa/core`, `@decupa/media`, `@decupa/acoustics`, `@decupa/goldedit`, `@decupa/metrics`, `@decupa/transcript`, sidecar `services/speech`, CLI com `gold`, `measure` e `report`.

**Fica de fora (outro plano):** chamadas ao Gemini, detecção de candidatos, compilador de cortes, validadores semântico/visual, render, página de revisão, daemon.

---

## Estrutura de Arquivos

```
Video editor/
  package.json                        workspace root, scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.config.ts
  .gitignore
  tests/fixtures/global-setup.ts      gera todos os fixtures com ffmpeg + say
  packages/
    core/          Interval, mergeIntervals, totalDurationMs — primitivas puras
    media/         probe, extractAudio, readPcm, hashFile — tudo que toca ffmpeg
    acoustics/     energyEnvelope, detectSilence, snapCut — análise de PCM
    goldedit/      alignEdited — deriva intervalos removidos de par bruto/editado
    metrics/       scoreIntervals, boundaryError — avaliação
    transcript/    TranscriptToken, ponte para o sidecar Python
  services/
    speech/        pyproject.toml + transcribe.py (WhisperX)
  apps/
    cli/           decupa gold | measure | report
```

Cada pacote tem uma responsabilidade e uma razão para mudar. `core` não depende de ninguém; `media` só de `core`; `acoustics`, `goldedit` e `metrics` de `core` (+ `media` para ler PCM); `transcript` de `core` e `media`; a CLI de todos.

---

### Task 1: Fundação do workspace + `@decupa/core`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `tests/fixtures/global-setup.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/interval.ts`, `packages/core/src/index.ts`
- Test: `packages/core/src/interval.test.ts`

**Interfaces:**
- Consumes: nada (primeira tarefa)
- Produces: `Interval { startMs: number; endMs: number }`, `mergeIntervals(intervals: Interval[], gapToleranceMs?: number): Interval[]`, `totalDurationMs(intervals: Interval[]): number`. Toda tarefa seguinte importa `Interval` de `@decupa/core`. O `globalSetup` exporta `FIXTURES: string` (caminho absoluto do diretório de fixtures gerados) — todos os testes seguintes importam essa constante.

- [ ] **Step 1: Criar o repositório e instalar o workspace**

```bash
cd "/Users/jhonatan/Repos/Video editor"
git init
mkdir -p tests/fixtures packages/core/src
pnpm init
pnpm add -D -w typescript vitest @types/node
```

- [ ] **Step 2: Escrever os arquivos de configuração**

`package.json` (substituir o gerado pelo `pnpm init`, mantendo as versões que ele instalou em `devDependencies`):

```json
{
  "name": "decupa",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --pretty",
    "decupa": "node --experimental-strip-types apps/cli/src/index.ts"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2023"],
    "strict": true,
    "declaration": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./tests/fixtures/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
```

`.gitignore`:

```
node_modules/
dist/
tests/fixtures/generated/
services/speech/.venv/
.DS_Store
*.pcm
```

- [ ] **Step 3: Escrever o gerador de fixtures**

`tests/fixtures/global-setup.ts` — todos os fixtures do plano inteiro nascem aqui. É idempotente: só gera o que falta.

```ts
import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "generated");

/** Verdade absoluta dos fixtures. Os testes comparam contra estes números. */
export const TRUTH = {
  /** tone-gap.wav: silêncio exato entre 1000 ms e 1600 ms, duração total 2600 ms */
  toneGapSilence: { startMs: 1000, endMs: 1600 },
  toneGapDurationMs: 2600,
  /** clip.mp4: 3000 ms, 320x240, 25 fps */
  clipDurationMs: 3000,
  /** par raw.wav (6000 ms) -> edited.wav (4600 ms): estes intervalos foram removidos */
  removed: [
    { startMs: 1200, endMs: 2000 },
    { startMs: 3500, endMs: 4100 },
  ],
  /** speech.wav: frase ditada, para conferir ordem de palavras da transcrição */
  speechText: "Eu acho que a gente devia mudar isso hoje mesmo.",
} as const;

const exists = (p: string) => access(p).then(() => true, () => false);
const ff = (args: string[]) => run("ffmpeg", ["-v", "error", "-y", ...args]);

export default async function setup(): Promise<void> {
  await mkdir(FIXTURES, { recursive: true });

  const clip = join(FIXTURES, "clip.mp4");
  if (!(await exists(clip))) {
    await ff([
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
      clip,
    ]);
  }

  const toneGap = join(FIXTURES, "tone-gap.wav");
  if (!(await exists(toneGap))) {
    await ff([
      "-f", "lavfi", "-i",
      "aevalsrc=exprs='if(between(t,1,1.6),0,0.4*sin(2*PI*440*t))':s=16000:d=2.6",
      "-ac", "1", "-c:a", "pcm_s16le", toneGap,
    ]);
  }

  const raw = join(FIXTURES, "raw.wav");
  if (!(await exists(raw))) {
    await ff([
      "-f", "lavfi", "-i",
      "aevalsrc=exprs='0.35*sin(2*PI*(200+120*t)*t)+0.15*sin(2*PI*(1100-90*t)*t)':s=16000:d=6.0",
      "-ac", "1", "-c:a", "pcm_s16le", raw,
    ]);
  }

  const edited = join(FIXTURES, "edited.wav");
  if (!(await exists(edited))) {
    await ff([
      "-i", raw, "-filter_complex",
      "[0]atrim=0:1.2,asetpts=N/SR/TB[a];" +
      "[0]atrim=2.0:3.5,asetpts=N/SR/TB[b];" +
      "[0]atrim=4.1:6.0,asetpts=N/SR/TB[c];" +
      "[a][b][c]concat=n=3:v=0:a=1",
      "-c:a", "pcm_s16le", edited,
    ]);
  }

  // Fala PT-BR reproduzível via síntese do macOS. Usada pela ponte de transcrição.
  const speech = join(FIXTURES, "speech.wav");
  if (!(await exists(speech))) {
    const aiff = join(FIXTURES, "speech.aiff");
    await run("say", ["-v", "Luciana", "-o", aiff, TRUTH.speechText]);
    await ff(["-i", aiff, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", speech]);
  }
}
```

- [ ] **Step 4: Escrever o teste que falha**

`packages/core/src/interval.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mergeIntervals, totalDurationMs } from "./interval.ts";

describe("mergeIntervals", () => {
  it("funde intervalos que se sobrepõem", () => {
    expect(mergeIntervals([
      { startMs: 0, endMs: 100 },
      { startMs: 50, endMs: 180 },
    ])).toEqual([{ startMs: 0, endMs: 180 }]);
  });

  it("funde intervalos separados por menos que a tolerância", () => {
    expect(mergeIntervals([
      { startMs: 0, endMs: 100 },
      { startMs: 130, endMs: 200 },
    ], 50)).toEqual([{ startMs: 0, endMs: 200 }]);
  });

  it("mantém separados os intervalos além da tolerância", () => {
    expect(mergeIntervals([
      { startMs: 0, endMs: 100 },
      { startMs: 400, endMs: 500 },
    ], 50)).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 400, endMs: 500 },
    ]);
  });

  it("ordena a entrada antes de fundir", () => {
    expect(mergeIntervals([
      { startMs: 400, endMs: 500 },
      { startMs: 0, endMs: 100 },
    ])).toEqual([
      { startMs: 0, endMs: 100 },
      { startMs: 400, endMs: 500 },
    ]);
  });

  it("devolve lista vazia para entrada vazia", () => {
    expect(mergeIntervals([])).toEqual([]);
  });
});

describe("totalDurationMs", () => {
  it("soma a duração dos intervalos já fundidos", () => {
    expect(totalDurationMs([
      { startMs: 0, endMs: 100 },
      { startMs: 400, endMs: 500 },
    ])).toBe(200);
  });

  it("não conta duas vezes o trecho sobreposto", () => {
    expect(totalDurationMs([
      { startMs: 0, endMs: 100 },
      { startMs: 50, endMs: 150 },
    ])).toBe(150);
  });
});
```

- [ ] **Step 5: Criar o pacote e rodar o teste para vê-lo falhar**

`packages/core/package.json`:

```json
{
  "name": "@decupa/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/core/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

Run: `pnpm vitest run packages/core`
Expected: FAIL — `Failed to resolve import "./interval.ts"`

- [ ] **Step 6: Implementar**

`packages/core/src/interval.ts`:

```ts
/** Intervalo de tempo em milissegundos inteiros. Meio-aberto: [startMs, endMs). */
export interface Interval {
  startMs: number;
  endMs: number;
}

/**
 * Ordena, funde sobreposições e junta vizinhos separados por até
 * `gapToleranceMs`. Não muta a entrada.
 */
export function mergeIntervals(
  intervals: Interval[],
  gapToleranceMs = 0,
): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const merged: Interval[] = [{ ...sorted[0]! }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (current.startMs - last.endMs <= gapToleranceMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/** Duração total coberta, sem contar sobreposição duas vezes. */
export function totalDurationMs(intervals: Interval[]): number {
  return mergeIntervals(intervals).reduce(
    (sum, i) => sum + (i.endMs - i.startMs),
    0,
  );
}
```

`packages/core/src/index.ts`:

```ts
export type { Interval } from "./interval.ts";
export { mergeIntervals, totalDurationMs } from "./interval.ts";
```

- [ ] **Step 7: Rodar os testes e ver passar**

Run: `pnpm vitest run packages/core`
Expected: PASS — 7 testes verdes. O `globalSetup` roda antes e gera `tests/fixtures/generated/` (leva ~10 s na primeira vez).

- [ ] **Step 8: Verificar que os fixtures saíram com a verdade esperada**

Run:

```bash
for f in clip.mp4 tone-gap.wav raw.wav edited.wav speech.wav; do
  printf "%-14s %s\n" "$f" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "tests/fixtures/generated/$f")"
done
```

Expected: `clip.mp4 3.0`, `tone-gap.wav 2.6`, `raw.wav 6.0`, `edited.wav 4.6`, `speech.wav ~3.1`.
Se `edited.wav` não der 4.6 (6000 ms − 1400 ms removidos), o filtro de corte está errado — pare e conserte antes de seguir, porque a Task 7 depende desse número.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): workspace, fixtures gerados por ffmpeg e primitivas de intervalo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `@decupa/media` — `probe()`

**Files:**
- Create: `packages/media/package.json`, `packages/media/tsconfig.json`, `packages/media/src/types.ts`, `packages/media/src/probe.ts`, `packages/media/src/index.ts`
- Test: `packages/media/src/probe.test.ts`

**Interfaces:**
- Consumes: `FIXTURES`, `TRUTH` de `tests/fixtures/global-setup.ts`
- Produces: `MediaInfo` e `probe(path: string): Promise<MediaInfo>`. A CLI (Tasks 12–13) usa para validar entradas e reportar duração.

- [ ] **Step 1: Escrever o teste que falha**

`packages/media/src/probe.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, TRUTH } from "../../../tests/fixtures/global-setup.ts";
import { probe } from "./probe.ts";

describe("probe", () => {
  it("lê duração, dimensões e fps de um mp4", async () => {
    const info = await probe(join(FIXTURES, "clip.mp4"));
    expect(info.durationMs).toBe(TRUTH.clipDurationMs);
    expect(info.hasVideo).toBe(true);
    expect(info.hasAudio).toBe(true);
    expect(info.width).toBe(320);
    expect(info.height).toBe(240);
    expect(info.fps).toBe(25);
    expect(info.videoCodec).toBe("h264");
  });

  it("lê um wav mono 16 kHz sem vídeo", async () => {
    const info = await probe(join(FIXTURES, "tone-gap.wav"));
    expect(info.durationMs).toBe(TRUTH.toneGapDurationMs);
    expect(info.hasVideo).toBe(false);
    expect(info.hasAudio).toBe(true);
    expect(info.sampleRate).toBe(16000);
    expect(info.width).toBeNull();
  });

  it("dá erro claro quando o arquivo não existe", async () => {
    await expect(probe("/nao/existe.mp4")).rejects.toThrow(/ffprobe falhou/);
  });
});
```

- [ ] **Step 2: Criar o pacote e rodar o teste para vê-lo falhar**

`packages/media/package.json`:

```json
{
  "name": "@decupa/media",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@decupa/core": "workspace:*" }
}
```

`packages/media/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

```bash
pnpm install
pnpm vitest run packages/media
```

Expected: FAIL — `Failed to resolve import "./probe.ts"`

- [ ] **Step 3: Implementar**

`packages/media/src/types.ts`:

```ts
export interface MediaInfo {
  path: string;
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sampleRate: number | null;
}
```

`packages/media/src/probe.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MediaInfo } from "./types.ts";

const run = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

/** "25/1" -> 25 · "30000/1001" -> 29.97 · "0/0" -> null */
function parseFrameRate(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return null;
  return Math.round((num / den) * 100) / 100;
}

export async function probe(path: string): Promise<MediaInfo> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      path,
    ]));
  } catch (cause) {
    throw new Error(`ffprobe falhou em ${path}`, { cause });
  }

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const durationSeconds = Number(parsed.format?.duration ?? 0);

  return {
    path,
    durationMs: Math.round(durationSeconds * 1000),
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: parseFrameRate(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
  };
}
```

`packages/media/src/index.ts`:

```ts
export type { MediaInfo } from "./types.ts";
export { probe } from "./probe.ts";
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run packages/media`
Expected: PASS — 3 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(media): probe via ffprobe com duração em ms inteiros

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `@decupa/media` — `extractAudio()`, `readPcm()`, `hashFile()`

**Files:**
- Create: `packages/media/src/audio.ts`, `packages/media/src/hash.ts`
- Modify: `packages/media/src/index.ts`
- Test: `packages/media/src/audio.test.ts`, `packages/media/src/hash.test.ts`

**Interfaces:**
- Consumes: nada de tarefas anteriores além do pacote já criado
- Produces:
  - `extractAudio(opts: { input: string; output: string; sampleRate?: number }): Promise<void>` — grava WAV `s16le` mono.
  - `readPcm(opts: { input: string; sampleRate?: number }): Promise<Int16Array>` — decodifica direto para memória, sem arquivo intermediário. Usado pelas Tasks 4, 5 e 7.
  - `hashFile(path: string): Promise<string>` — sha256 hex, chave de cache das análises.

- [ ] **Step 1: Escrever os testes que falham**

`packages/media/src/audio.test.ts`:

```ts
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../tests/fixtures/global-setup.ts";
import { extractAudio, readPcm } from "./audio.ts";
import { probe } from "./probe.ts";

describe("extractAudio", () => {
  it("extrai wav mono 16 kHz de um mp4", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-"));
    const out = join(dir, "out.wav");

    await extractAudio({ input: join(FIXTURES, "clip.mp4"), output: out });

    const info = await probe(out);
    expect(info.sampleRate).toBe(16000);
    expect(info.audioCodec).toBe("pcm_s16le");
    // O AAC do clip.mp4 declara 3,000 s no container, mas grava 130 quadros de
    // 1024 amostras (133120 ≈ 3,019 s decodificadas). Tolerância para o padding.
    expect(info.durationMs).toBeGreaterThanOrEqual(3000);
    expect(info.durationMs).toBeLessThan(3100);
    expect((await stat(out)).size).toBeGreaterThan(0);
  });
});

describe("readPcm", () => {
  it("devolve exatamente sampleRate * duração amostras", async () => {
    // tone-gap.wav tem 2600 ms a 16 kHz => 41600 amostras
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    expect(pcm).toBeInstanceOf(Int16Array);
    expect(pcm.length).toBe(41_600);
  });

  it("tem amplitude zero dentro do silêncio conhecido", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    // silêncio em [1000, 1600) ms => amostras [16000, 25600)
    let peak = 0;
    for (let i = 16_000; i < 25_600; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    expect(peak).toBe(0);
  });

  it("tem amplitude alta fora do silêncio", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    let peak = 0;
    for (let i = 0; i < 16_000; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
    expect(peak).toBeGreaterThan(1000);
  });
});
```

`packages/media/src/hash.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../../tests/fixtures/global-setup.ts";
import { hashFile } from "./hash.ts";

describe("hashFile", () => {
  it("devolve sha256 hex de 64 caracteres", async () => {
    const hash = await hashFile(join(FIXTURES, "tone-gap.wav"));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("é estável entre chamadas", async () => {
    const path = join(FIXTURES, "tone-gap.wav");
    expect(await hashFile(path)).toBe(await hashFile(path));
  });

  it("difere entre arquivos diferentes", async () => {
    const a = await hashFile(join(FIXTURES, "tone-gap.wav"));
    const b = await hashFile(join(FIXTURES, "raw.wav"));
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Rodar os testes para vê-los falhar**

Run: `pnpm vitest run packages/media`
Expected: FAIL — `Failed to resolve import "./audio.ts"` e `"./hash.ts"`

- [ ] **Step 3: Implementar**

`packages/media/src/audio.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const DEFAULT_SAMPLE_RATE = 16_000;

/** Extrai a trilha de áudio como WAV PCM s16le mono. Sobrescreve o destino. */
export async function extractAudio(opts: {
  input: string;
  output: string;
  sampleRate?: number;
}): Promise<void> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  try {
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-i", opts.input,
      "-vn",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-c:a", "pcm_s16le",
      opts.output,
    ]);
  } catch (cause) {
    throw new Error(`extração de áudio falhou em ${opts.input}`, { cause });
  }
}

/**
 * Decodifica o áudio direto para memória como PCM s16le mono, sem arquivo
 * intermediário. `maxBuffer` alto porque 1 h a 16 kHz são ~115 MB.
 */
export async function readPcm(opts: {
  input: string;
  sampleRate?: number;
}): Promise<Int16Array> {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  let stdout: Buffer;
  try {
    ({ stdout } = await run("ffmpeg", [
      "-v", "error",
      "-i", opts.input,
      "-vn",
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ar", String(sampleRate),
      "-ac", "1",
      "-",
    ], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 }));
  } catch (cause) {
    throw new Error(`leitura de PCM falhou em ${opts.input}`, { cause });
  }

  // Descarta um byte ímpar residual, se houver, para não quebrar o Int16Array.
  const usableBytes = stdout.byteLength - (stdout.byteLength % 2);
  return new Int16Array(
    stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + usableBytes),
  );
}
```

`packages/media/src/hash.ts`:

```ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

/** sha256 hex do conteúdo. Chave de cache das análises caras. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}
```

`packages/media/src/index.ts` (substituir):

```ts
export type { MediaInfo } from "./types.ts";
export { probe } from "./probe.ts";
export { DEFAULT_SAMPLE_RATE, extractAudio, readPcm } from "./audio.ts";
export { hashFile } from "./hash.ts";
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run packages/media`
Expected: PASS — 10 testes verdes (3 de probe, 4 de audio, 3 de hash).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(media): extração de áudio, leitura de PCM em memória e hash de conteúdo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `@decupa/acoustics` — `energyEnvelope()`

**Files:**
- Create: `packages/acoustics/package.json`, `packages/acoustics/tsconfig.json`, `packages/acoustics/src/envelope.ts`, `packages/acoustics/src/index.ts`
- Test: `packages/acoustics/src/envelope.test.ts`

**Interfaces:**
- Consumes: `readPcm` de `@decupa/media`
- Produces: `EnergyEnvelope { hopMs: number; rms: Float32Array }` e `energyEnvelope(pcm: Int16Array, opts?: { sampleRate?: number; hopMs?: number }): EnergyEnvelope`. A Task 6 (`snapCut`) consome o envelope.

- [ ] **Step 1: Escrever o teste que falha**

`packages/acoustics/src/envelope.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPcm } from "@decupa/media";
import { FIXTURES } from "../../../tests/fixtures/global-setup.ts";
import { energyEnvelope } from "./envelope.ts";

describe("energyEnvelope", () => {
  it("produz um quadro a cada hopMs", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const env = energyEnvelope(pcm, { hopMs: 10 });
    // 2600 ms / 10 ms = 260 quadros
    expect(env.hopMs).toBe(10);
    expect(env.rms.length).toBe(260);
  });

  it("marca energia ~zero dentro do silêncio conhecido", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const env = energyEnvelope(pcm, { hopMs: 10 });
    // silêncio em [1000, 1600) ms => quadros [100, 160)
    for (let i = 105; i < 155; i++) {
      expect(env.rms[i]).toBeLessThan(0.001);
    }
  });

  it("marca energia alta fora do silêncio", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const env = energyEnvelope(pcm, { hopMs: 10 });
    expect(env.rms[50]).toBeGreaterThan(0.1);
    expect(env.rms[200]).toBeGreaterThan(0.1);
  });

  it("normaliza para 0..1 em escala de amplitude", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const env = energyEnvelope(pcm, { hopMs: 10 });
    for (const value of env.rms) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 2: Criar o pacote e rodar o teste para vê-lo falhar**

`packages/acoustics/package.json`:

```json
{
  "name": "@decupa/acoustics",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@decupa/core": "workspace:*",
    "@decupa/media": "workspace:*"
  }
}
```

`packages/acoustics/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

```bash
pnpm install
pnpm vitest run packages/acoustics
```

Expected: FAIL — `Failed to resolve import "./envelope.ts"`

- [ ] **Step 3: Implementar**

`packages/acoustics/src/envelope.ts`:

```ts
import { DEFAULT_SAMPLE_RATE } from "@decupa/media";

export interface EnergyEnvelope {
  /** Passo entre quadros, em ms. */
  hopMs: number;
  /** RMS por quadro, normalizado para 0..1 em escala de amplitude. */
  rms: Float32Array;
}

const INT16_MAX = 32_768;

/**
 * RMS por janela deslizante não sobreposta de `hopMs`.
 * Quadros incompletos no fim são descartados, para que
 * `rms.length * hopMs` nunca ultrapasse a duração real.
 */
export function energyEnvelope(
  pcm: Int16Array,
  opts: { sampleRate?: number; hopMs?: number } = {},
): EnergyEnvelope {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const hopMs = opts.hopMs ?? 10;
  const hop = Math.round((hopMs * sampleRate) / 1000);
  const frameCount = Math.floor(pcm.length / hop);
  const rms = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop;
    let sumSquares = 0;
    for (let i = start; i < start + hop; i++) {
      const sample = pcm[i]! / INT16_MAX;
      sumSquares += sample * sample;
    }
    rms[frame] = Math.sqrt(sumSquares / hop);
  }

  return { hopMs, rms };
}
```

`packages/acoustics/src/index.ts`:

```ts
export type { EnergyEnvelope } from "./envelope.ts";
export { energyEnvelope } from "./envelope.ts";
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run packages/acoustics`
Expected: PASS — 4 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(acoustics): envelope de energia RMS por quadro

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `@decupa/acoustics` — `detectSilence()`

**Files:**
- Create: `packages/acoustics/src/silence.ts`
- Modify: `packages/acoustics/src/index.ts`
- Test: `packages/acoustics/src/silence.test.ts`

**Interfaces:**
- Consumes: `Interval` de `@decupa/core`
- Produces: `detectSilence(opts: { input: string; thresholdDb?: number; minDurationMs?: number }): Promise<Interval[]>`. Usa o filtro `silencedetect` do ffmpeg, que é mais confiável que reimplementar. Consumido pela CLI e, mais adiante, pelo detector de candidatos.

- [ ] **Step 1: Escrever o teste que falha**

`packages/acoustics/src/silence.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, TRUTH } from "../../../tests/fixtures/global-setup.ts";
import { detectSilence } from "./silence.ts";

describe("detectSilence", () => {
  it("acha o silêncio conhecido dentro de 30 ms", async () => {
    const silences = await detectSilence({
      input: join(FIXTURES, "tone-gap.wav"),
      thresholdDb: -40,
      minDurationMs: 200,
    });

    expect(silences).toHaveLength(1);
    expect(Math.abs(silences[0]!.startMs - TRUTH.toneGapSilence.startMs)).toBeLessThanOrEqual(30);
    expect(Math.abs(silences[0]!.endMs - TRUTH.toneGapSilence.endMs)).toBeLessThanOrEqual(30);
  });

  it("ignora silêncios menores que minDurationMs", async () => {
    const silences = await detectSilence({
      input: join(FIXTURES, "tone-gap.wav"),
      thresholdDb: -40,
      minDurationMs: 2000,
    });
    expect(silences).toEqual([]);
  });

  it("devolve lista vazia para áudio sem silêncio", async () => {
    const silences = await detectSilence({
      input: join(FIXTURES, "raw.wav"),
      thresholdDb: -40,
      minDurationMs: 200,
    });
    expect(silences).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar o teste para vê-lo falhar**

Run: `pnpm vitest run packages/acoustics`
Expected: FAIL — `Failed to resolve import "./silence.ts"`

- [ ] **Step 3: Implementar**

`packages/acoustics/src/silence.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Interval } from "@decupa/core";

const run = promisify(execFile);

/**
 * O `silencedetect` do ffmpeg escreve em stderr, uma linha por evento:
 *   [silencedetect @ 0x...] silence_start: 1
 *   [silencedetect @ 0x...] silence_end: 1.600062 | silence_duration: 0.600063
 */
const START_RE = /silence_start:\s*(-?[\d.]+)/g;
const END_RE = /silence_end:\s*(-?[\d.]+)/g;

export async function detectSilence(opts: {
  input: string;
  thresholdDb?: number;
  minDurationMs?: number;
}): Promise<Interval[]> {
  const thresholdDb = opts.thresholdDb ?? -35;
  const minDurationMs = opts.minDurationMs ?? 300;
  const filter = `silencedetect=noise=${thresholdDb}dB:d=${minDurationMs / 1000}`;

  // ffmpeg sai com código 0 aqui, mas o log vai para stderr mesmo em -v info.
  const { stderr } = await run("ffmpeg", [
    "-v", "info",
    "-i", opts.input,
    "-af", filter,
    "-f", "null", "-",
  ], { maxBuffer: 64 * 1024 * 1024 });

  const starts = [...stderr.matchAll(START_RE)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(END_RE)].map((m) => Number(m[1]));

  const intervals: Interval[] = [];
  for (let i = 0; i < starts.length; i++) {
    const startSeconds = Math.max(0, starts[i]!);
    // Silêncio que vai até o fim do arquivo não gera silence_end: descarta,
    // porque não é um corte candidato — é só o rabo da gravação.
    const endSeconds = ends[i];
    if (endSeconds === undefined) continue;
    intervals.push({
      startMs: Math.round(startSeconds * 1000),
      endMs: Math.round(endSeconds * 1000),
    });
  }

  return intervals;
}
```

`packages/acoustics/src/index.ts` (substituir):

```ts
export type { EnergyEnvelope } from "./envelope.ts";
export { energyEnvelope } from "./envelope.ts";
export { detectSilence } from "./silence.ts";
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run packages/acoustics`
Expected: PASS — 7 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(acoustics): detecção de silêncio via filtro silencedetect

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `@decupa/acoustics` — `snapCut()`

**Files:**
- Create: `packages/acoustics/src/snap.ts`
- Modify: `packages/acoustics/src/index.ts`
- Test: `packages/acoustics/src/snap.test.ts`

**Interfaces:**
- Consumes: `EnergyEnvelope` da Task 4
- Produces: `snapCut(opts: { envelope: EnergyEnvelope; targetMs: number; windowMs?: number }): { ms: number; movedByMs: number }`. É o remédio do problema 03 da spec: a camada semântica decide *o quê*, esta função decide *onde*. Consumida pelo compilador de cortes (plano seguinte) e já pela CLI de medição.

- [ ] **Step 1: Escrever o teste que falha**

`packages/acoustics/src/snap.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPcm } from "@decupa/media";
import { FIXTURES } from "../../../tests/fixtures/global-setup.ts";
import { energyEnvelope } from "./envelope.ts";
import { snapCut } from "./snap.ts";

describe("snapCut", () => {
  it("puxa um corte próximo para dentro do vale de silêncio", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const envelope = energyEnvelope(pcm, { hopMs: 10 });

    // 940 ms está no tom, 60 ms antes do silêncio que começa em 1000 ms
    const result = snapCut({ envelope, targetMs: 940, windowMs: 120 });

    expect(result.ms).toBeGreaterThanOrEqual(1000);
    expect(result.ms).toBeLessThanOrEqual(1060);
    expect(result.movedByMs).toBe(result.ms - 940);
  });

  it("não move quando o alvo já está no ponto mais silencioso", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const envelope = energyEnvelope(pcm, { hopMs: 10 });

    const result = snapCut({ envelope, targetMs: 1300, windowMs: 120 });

    expect(Math.abs(result.movedByMs)).toBeLessThanOrEqual(10);
  });

  it("respeita a janela: nunca move mais que windowMs", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const envelope = energyEnvelope(pcm, { hopMs: 10 });

    const result = snapCut({ envelope, targetMs: 500, windowMs: 100 });

    expect(Math.abs(result.movedByMs)).toBeLessThanOrEqual(100);
  });

  it("não sai dos limites do envelope", async () => {
    const pcm = await readPcm({ input: join(FIXTURES, "tone-gap.wav") });
    const envelope = energyEnvelope(pcm, { hopMs: 10 });

    const atStart = snapCut({ envelope, targetMs: 0, windowMs: 200 });
    const atEnd = snapCut({ envelope, targetMs: 2590, windowMs: 200 });

    expect(atStart.ms).toBeGreaterThanOrEqual(0);
    expect(atEnd.ms).toBeLessThanOrEqual(2600);
  });
});
```

- [ ] **Step 2: Rodar o teste para vê-lo falhar**

Run: `pnpm vitest run packages/acoustics`
Expected: FAIL — `Failed to resolve import "./snap.ts"`

- [ ] **Step 3: Implementar**

`packages/acoustics/src/snap.ts`:

```ts
import type { EnergyEnvelope } from "./envelope.ts";

export interface SnapResult {
  /** Posição final do corte, em ms. */
  ms: number;
  /** Deslocamento aplicado (positivo = empurrou para frente). */
  movedByMs: number;
}

/**
 * Empurra um corte para o quadro de menor energia dentro de ±windowMs.
 * Em empate, vence o quadro mais próximo do alvo — mover menos é sempre melhor.
 */
export function snapCut(opts: {
  envelope: EnergyEnvelope;
  targetMs: number;
  windowMs?: number;
}): SnapResult {
  const { envelope, targetMs } = opts;
  const windowMs = opts.windowMs ?? 120;
  const { hopMs, rms } = envelope;

  if (rms.length === 0) return { ms: targetMs, movedByMs: 0 };

  const targetFrame = Math.round(targetMs / hopMs);
  const radius = Math.round(windowMs / hopMs);
  const lo = Math.max(0, targetFrame - radius);
  const hi = Math.min(rms.length - 1, targetFrame + radius);

  let bestFrame = Math.min(Math.max(targetFrame, lo), hi);
  let bestEnergy = rms[bestFrame]!;
  let bestDistance = Math.abs(bestFrame - targetFrame);

  for (let frame = lo; frame <= hi; frame++) {
    const energy = rms[frame]!;
    const distance = Math.abs(frame - targetFrame);
    if (energy < bestEnergy || (energy === bestEnergy && distance < bestDistance)) {
      bestFrame = frame;
      bestEnergy = energy;
      bestDistance = distance;
    }
  }

  const ms = bestFrame * hopMs;
  return { ms, movedByMs: ms - targetMs };
}
```

`packages/acoustics/src/index.ts` (substituir):

```ts
export type { EnergyEnvelope } from "./envelope.ts";
export type { SnapResult } from "./snap.ts";
export { energyEnvelope } from "./envelope.ts";
export { detectSilence } from "./silence.ts";
export { snapCut } from "./snap.ts";
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run packages/acoustics`
Expected: PASS — 11 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(acoustics): snap de corte para o vale de energia mais próximo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `@decupa/goldedit` — `alignEdited()`

O extrator de gold edits. É a tarefa de maior alavancagem do plano: transforma pares bruto/editado que o time já produziu em dataset anotado, sem ninguém marcar nada à mão.

**O algoritmo já foi validado empiricamente.** Correlação cruzada normalizada por janela, com cursor monotônico. O viés sistemático é exatamente `-windowMs/2` — a correção `+windowMs/2` dá recuperação **exata** (erro 0 ms) para `windowMs` de 200, 300 e 400 com `hopMs` de 50. Não mexer em `windowMs` sem re-medir.

**Files:**
- Create: `packages/goldedit/package.json`, `packages/goldedit/tsconfig.json`, `packages/goldedit/src/ncc.ts`, `packages/goldedit/src/align.ts`, `packages/goldedit/src/index.ts`
- Test: `packages/goldedit/src/ncc.test.ts`, `packages/goldedit/src/align.test.ts`

**Interfaces:**
- Consumes: `Interval`, `mergeIntervals` de `@decupa/core`; `readPcm`, `DEFAULT_SAMPLE_RATE` de `@decupa/media`
- Produces:
  - `ncc(a: Int16Array, aOffset: number, b: Int16Array, bOffset: number, length: number): number` — correlação cruzada normalizada de média zero, −1..1.
  - `alignEdited(opts: AlignOptions): Interval[]` onde `AlignOptions = { raw: Int16Array; edited: Int16Array; sampleRate?: number; windowMs?: number; hopMs?: number; maxLookaheadMs?: number; minGapMs?: number; searchStepSamples?: number }`.
  - `alignEditedFiles(opts: { rawPath: string; editedPath: string } & Omit<AlignOptions, "raw" | "edited">): Promise<Interval[]>` — versão que lê os arquivos. É o que a CLI usa.

- [ ] **Step 1: Escrever o teste de `ncc` que falha**

`packages/goldedit/src/ncc.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ncc } from "./ncc.ts";

describe("ncc", () => {
  it("dá 1 para sinais idênticos", () => {
    const a = Int16Array.from([1, 5, 3, 9, 2, 7]);
    expect(ncc(a, 0, a, 0, 6)).toBeCloseTo(1, 6);
  });

  it("dá -1 para sinais invertidos", () => {
    const a = Int16Array.from([1, 5, 3, 9, 2, 7]);
    const b = Int16Array.from([-1, -5, -3, -9, -2, -7]);
    expect(ncc(a, 0, b, 0, 6)).toBeCloseTo(-1, 6);
  });

  it("ignora deslocamento de nível (média zero)", () => {
    const a = Int16Array.from([1, 5, 3, 9, 2, 7]);
    const b = Int16Array.from([101, 105, 103, 109, 102, 107]);
    expect(ncc(a, 0, b, 0, 6)).toBeCloseTo(1, 6);
  });

  it("dá 0 quando um dos lados é constante", () => {
    const a = Int16Array.from([1, 5, 3, 9, 2, 7]);
    const flat = Int16Array.from([4, 4, 4, 4, 4, 4]);
    expect(ncc(a, 0, flat, 0, 6)).toBe(0);
  });

  it("respeita os offsets", () => {
    const a = Int16Array.from([0, 0, 1, 5, 3, 9]);
    const b = Int16Array.from([1, 5, 3, 9]);
    expect(ncc(a, 2, b, 0, 4)).toBeCloseTo(1, 6);
  });
});
```

- [ ] **Step 2: Criar o pacote e rodar o teste para vê-lo falhar**

`packages/goldedit/package.json`:

```json
{
  "name": "@decupa/goldedit",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@decupa/core": "workspace:*",
    "@decupa/media": "workspace:*"
  }
}
```

`packages/goldedit/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

```bash
pnpm install
pnpm vitest run packages/goldedit
```

Expected: FAIL — `Failed to resolve import "./ncc.ts"`

- [ ] **Step 3: Implementar `ncc`**

`packages/goldedit/src/ncc.ts`:

```ts
/**
 * Correlação cruzada normalizada de média zero entre duas fatias de mesmo
 * tamanho. Devolve -1..1, ou 0 quando um dos lados não tem variação.
 */
export function ncc(
  a: Int16Array,
  aOffset: number,
  b: Int16Array,
  bOffset: number,
  length: number,
): number {
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < length; i++) {
    sumA += a[aOffset + i]!;
    sumB += b[bOffset + i]!;
  }
  const meanA = sumA / length;
  const meanB = sumB / length;

  let numerator = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[aOffset + i]! - meanA;
    const y = b[bOffset + i]! - meanB;
    numerator += x * y;
    varA += x * x;
    varB += y * y;
  }

  const denominator = Math.sqrt(varA * varB);
  return denominator === 0 ? 0 : numerator / denominator;
}
```

- [ ] **Step 4: Rodar e ver `ncc` passar**

Run: `pnpm vitest run packages/goldedit`
Expected: PASS — 5 testes verdes.

- [ ] **Step 5: Escrever o teste de `alignEdited` que falha**

`packages/goldedit/src/align.test.ts`:

```ts
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPcm } from "@decupa/media";
import { FIXTURES, TRUTH } from "../../../tests/fixtures/global-setup.ts";
import { alignEdited, alignEditedFiles } from "./align.ts";

describe("alignEdited", () => {
  it("recupera exatamente os intervalos removidos do par sintético", async () => {
    const raw = await readPcm({ input: join(FIXTURES, "raw.wav") });
    const edited = await readPcm({ input: join(FIXTURES, "edited.wav") });

    const removed = alignEdited({ raw, edited });

    expect(removed).toHaveLength(2);
    for (const [i, truth] of TRUTH.removed.entries()) {
      expect(Math.abs(removed[i]!.startMs - truth.startMs)).toBeLessThanOrEqual(25);
      expect(Math.abs(removed[i]!.endMs - truth.endMs)).toBeLessThanOrEqual(25);
    }
  });

  it("preserva a duração de cada remoção", async () => {
    const raw = await readPcm({ input: join(FIXTURES, "raw.wav") });
    const edited = await readPcm({ input: join(FIXTURES, "edited.wav") });

    const removed = alignEdited({ raw, edited });

    expect(Math.abs((removed[0]!.endMs - removed[0]!.startMs) - 800)).toBeLessThanOrEqual(25);
    expect(Math.abs((removed[1]!.endMs - removed[1]!.startMs) - 600)).toBeLessThanOrEqual(25);
  });

  it("não acha remoção nenhuma quando os dois lados são iguais", async () => {
    const raw = await readPcm({ input: join(FIXTURES, "raw.wav") });
    expect(alignEdited({ raw, edited: raw })).toEqual([]);
  });

  it("descarta lacunas menores que minGapMs", async () => {
    const raw = await readPcm({ input: join(FIXTURES, "raw.wav") });
    const edited = await readPcm({ input: join(FIXTURES, "edited.wav") });

    expect(alignEdited({ raw, edited, minGapMs: 5000 })).toEqual([]);
  });

  it("alignEditedFiles produz o mesmo resultado a partir dos caminhos", async () => {
    const removed = await alignEditedFiles({
      rawPath: join(FIXTURES, "raw.wav"),
      editedPath: join(FIXTURES, "edited.wav"),
    });
    expect(removed).toHaveLength(2);
    expect(Math.abs(removed[0]!.startMs - TRUTH.removed[0]!.startMs)).toBeLessThanOrEqual(25);
  });
});
```

- [ ] **Step 6: Rodar o teste para vê-lo falhar**

Run: `pnpm vitest run packages/goldedit`
Expected: FAIL — `Failed to resolve import "./align.ts"`

- [ ] **Step 7: Implementar `alignEdited`**

`packages/goldedit/src/align.ts`:

```ts
import { mergeIntervals, type Interval } from "@decupa/core";
import { DEFAULT_SAMPLE_RATE, readPcm } from "@decupa/media";
import { ncc } from "./ncc.ts";

export interface AlignOptions {
  raw: Int16Array;
  edited: Int16Array;
  sampleRate?: number;
  /** Tamanho da janela de casamento. 200 ms é o valor calibrado. */
  windowMs?: number;
  /** Passo entre janelas. Deve dividir windowMs para o viés ficar exato. */
  hopMs?: number;
  /** Até onde procurar à frente do cursor. Limita o custo em arquivos longos. */
  maxLookaheadMs?: number;
  /** Lacunas menores que isto são ruído de alinhamento, não corte. */
  minGapMs?: number;
  /** Passo da busca grosseira, em amostras. Menor = mais lento e mais preciso. */
  searchStepSamples?: number;
}

/**
 * Deriva os intervalos que foram removidos do bruto para produzir o editado.
 *
 * Percorre o editado em janelas, casando cada uma contra o bruto por NCC, com
 * um cursor que só anda para frente. Quando o melhor casamento pula à frente do
 * cursor, o pulo é um trecho removido.
 *
 * O ponto detectado fica atrasado em exatamente metade da janela — a última
 * janela que ainda casa é a que *começa* antes do corte. Daí a correção
 * `+windowMs/2`, verificada empiricamente: com ela o erro é 0 ms em fixture
 * sintético para windowMs de 200, 300 e 400.
 */
export function alignEdited(opts: AlignOptions): Interval[] {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const windowMs = opts.windowMs ?? 200;
  const hopMs = opts.hopMs ?? 50;
  const maxLookaheadMs = opts.maxLookaheadMs ?? 30_000;
  const minGapMs = opts.minGapMs ?? 120;
  const searchStep = opts.searchStepSamples ?? 8;

  const { raw, edited } = opts;
  const window = Math.round((windowMs * sampleRate) / 1000);
  const hop = Math.round((hopMs * sampleRate) / 1000);
  const lookahead = Math.round((maxLookaheadMs * sampleRate) / 1000);
  const biasCorrectionMs = Math.round(windowMs / 2);
  const toMs = (samples: number) => Math.round((samples * 1000) / sampleRate);

  const gaps: Interval[] = [];
  let cursor = 0;

  for (let editedStart = 0; editedStart + window <= edited.length; editedStart += hop) {
    const searchEnd = Math.min(cursor + lookahead, raw.length - window);
    if (searchEnd < cursor) break;

    let best = cursor;
    let bestScore = -2;

    for (let offset = cursor; offset <= searchEnd; offset += searchStep) {
      const score = ncc(edited, editedStart, raw, offset, window);
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }

    // Refino fino em torno do melhor candidato grosseiro.
    const refineLo = Math.max(cursor, best - searchStep);
    const refineHi = Math.min(searchEnd, best + searchStep);
    for (let offset = refineLo; offset <= refineHi; offset++) {
      const score = ncc(edited, editedStart, raw, offset, window);
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }

    if (best > cursor) {
      gaps.push({
        startMs: toMs(cursor) + biasCorrectionMs,
        endMs: toMs(best) + biasCorrectionMs,
      });
    }
    cursor = best + hop;
  }

  return mergeIntervals(gaps, hopMs).filter(
    (gap) => gap.endMs - gap.startMs >= minGapMs,
  );
}

/** Mesma coisa, lendo os dois arquivos do disco. É o que a CLI usa. */
export async function alignEditedFiles(
  opts: { rawPath: string; editedPath: string } & Omit<AlignOptions, "raw" | "edited">,
): Promise<Interval[]> {
  const { rawPath, editedPath, ...rest } = opts;
  const sampleRate = rest.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const [raw, edited] = await Promise.all([
    readPcm({ input: rawPath, sampleRate }),
    readPcm({ input: editedPath, sampleRate }),
  ]);
  return alignEdited({ raw, edited, ...rest });
}
```

`packages/goldedit/src/index.ts`:

```ts
export type { AlignOptions } from "./align.ts";
export { alignEdited, alignEditedFiles } from "./align.ts";
export { ncc } from "./ncc.ts";
```

- [ ] **Step 8: Rodar os testes e ver passar**

Run: `pnpm vitest run packages/goldedit`
Expected: PASS — 10 testes verdes.

Se o primeiro teste falhar por deslocamento constante em todos os intervalos, o valor de `biasCorrectionMs` está errado para o `windowMs` em uso — meça o deslocamento observado e confirme que é `windowMs/2` antes de mudar qualquer coisa.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(goldedit): deriva intervalos removidos de par bruto/editado por NCC

Correlação cruzada normalizada com cursor monotônico e correção de viés de
windowMs/2. Recuperação exata em fixture sintético.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `@decupa/metrics` — `scoreIntervals()`

**Files:**
- Create: `packages/metrics/package.json`, `packages/metrics/tsconfig.json`, `packages/metrics/src/intervals.ts`, `packages/metrics/src/index.ts`
- Test: `packages/metrics/src/intervals.test.ts`

**Interfaces:**
- Consumes: `Interval`, `mergeIntervals`, `totalDurationMs` de `@decupa/core`
- Produces: `IntervalScore { precisionMs, recallMs, f1, iou, predictedMs, truthMs, intersectionMs }` e `scoreIntervals(opts: { predicted: Interval[]; truth: Interval[] }): IntervalScore`. Precisão e recall são calculados **por milissegundo coberto**, não por contagem de intervalos — dois cortes que somam a mesma duração devem pontuar igual a um corte só.

- [ ] **Step 1: Escrever o teste que falha**

`packages/metrics/src/intervals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scoreIntervals } from "./intervals.ts";

describe("scoreIntervals", () => {
  it("dá pontuação perfeita para predição idêntica", () => {
    const intervals = [{ startMs: 100, endMs: 300 }, { startMs: 500, endMs: 800 }];
    const score = scoreIntervals({ predicted: intervals, truth: intervals });
    expect(score.iou).toBe(1);
    expect(score.f1).toBe(1);
    expect(score.precisionMs).toBe(1);
    expect(score.recallMs).toBe(1);
  });

  it("dá zero quando não há sobreposição", () => {
    const score = scoreIntervals({
      predicted: [{ startMs: 0, endMs: 100 }],
      truth: [{ startMs: 500, endMs: 600 }],
    });
    expect(score.iou).toBe(0);
    expect(score.f1).toBe(0);
  });

  it("calcula sobreposição parcial por milissegundo", () => {
    // predito 0..200, verdade 100..300 => interseção 100 ms, união 300 ms
    const score = scoreIntervals({
      predicted: [{ startMs: 0, endMs: 200 }],
      truth: [{ startMs: 100, endMs: 300 }],
    });
    expect(score.intersectionMs).toBe(100);
    expect(score.iou).toBeCloseTo(100 / 300, 6);
    expect(score.precisionMs).toBeCloseTo(0.5, 6);
    expect(score.recallMs).toBeCloseTo(0.5, 6);
    expect(score.f1).toBeCloseTo(0.5, 6);
  });

  it("penaliza predição que corta demais", () => {
    // predito 0..1000 cobre toda a verdade 100..300, mas sobra muito
    const score = scoreIntervals({
      predicted: [{ startMs: 0, endMs: 1000 }],
      truth: [{ startMs: 100, endMs: 300 }],
    });
    expect(score.recallMs).toBe(1);
    expect(score.precisionMs).toBeCloseTo(0.2, 6);
  });

  it("trata listas vazias sem dividir por zero", () => {
    expect(scoreIntervals({ predicted: [], truth: [] })).toMatchObject({
      iou: 1, f1: 1, precisionMs: 1, recallMs: 1,
    });
    expect(scoreIntervals({ predicted: [], truth: [{ startMs: 0, endMs: 100 }] }))
      .toMatchObject({ iou: 0, f1: 0, recallMs: 0 });
    expect(scoreIntervals({ predicted: [{ startMs: 0, endMs: 100 }], truth: [] }))
      .toMatchObject({ iou: 0, f1: 0, precisionMs: 0 });
  });

  it("funde sobreposições na entrada antes de pontuar", () => {
    const score = scoreIntervals({
      predicted: [{ startMs: 0, endMs: 200 }, { startMs: 100, endMs: 300 }],
      truth: [{ startMs: 0, endMs: 300 }],
    });
    expect(score.iou).toBe(1);
  });
});
```

- [ ] **Step 2: Criar o pacote e rodar o teste para vê-lo falhar**

`packages/metrics/package.json`:

```json
{
  "name": "@decupa/metrics",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@decupa/core": "workspace:*" }
}
```

`packages/metrics/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

```bash
pnpm install
pnpm vitest run packages/metrics
```

Expected: FAIL — `Failed to resolve import "./intervals.ts"`

- [ ] **Step 3: Implementar**

`packages/metrics/src/intervals.ts`:

```ts
import { mergeIntervals, totalDurationMs, type Interval } from "@decupa/core";

export interface IntervalScore {
  /** Fração dos ms preditos que caem dentro da verdade. */
  precisionMs: number;
  /** Fração dos ms da verdade que foram preditos. */
  recallMs: number;
  f1: number;
  iou: number;
  predictedMs: number;
  truthMs: number;
  intersectionMs: number;
}

function intersectionMs(a: Interval[], b: Interval[]): number {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  let total = 0;
  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    const start = Math.max(left[i]!.startMs, right[j]!.startMs);
    const end = Math.min(left[i]!.endMs, right[j]!.endMs);
    if (end > start) total += end - start;
    if (left[i]!.endMs < right[j]!.endMs) i++;
    else j++;
  }

  return total;
}

export function scoreIntervals(opts: {
  predicted: Interval[];
  truth: Interval[];
}): IntervalScore {
  const predictedMs = totalDurationMs(opts.predicted);
  const truthMs = totalDurationMs(opts.truth);
  const overlap = intersectionMs(opts.predicted, opts.truth);
  const unionMs = predictedMs + truthMs - overlap;

  // Nada predito e nada esperado é acerto perfeito, não divisão por zero.
  const precisionMs = predictedMs === 0 ? (truthMs === 0 ? 1 : 0) : overlap / predictedMs;
  const recallMs = truthMs === 0 ? (predictedMs === 0 ? 1 : 0) : overlap / truthMs;
  const f1 = precisionMs + recallMs === 0 ? 0 : (2 * precisionMs * recallMs) / (precisionMs + recallMs);
  const iou = unionMs === 0 ? 1 : overlap / unionMs;

  return { precisionMs, recallMs, f1, iou, predictedMs, truthMs, intersectionMs: overlap };
}
```

`packages/metrics/src/index.ts`:

```ts
export type { IntervalScore } from "./intervals.ts";
export { scoreIntervals } from "./intervals.ts";
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run packages/metrics`
Expected: PASS — 6 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(metrics): precisão, recall, F1 e IoU de intervalos por milissegundo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: `@decupa/metrics` — `boundaryError()`

O número que decide o portão da Fase 0: erro de fronteira de palavra em ms, p50 e p90.

**Files:**
- Create: `packages/metrics/src/boundary.ts`
- Modify: `packages/metrics/src/index.ts`
- Test: `packages/metrics/src/boundary.test.ts`

**Interfaces:**
- Consumes: nada além do pacote já criado
- Produces: `BoundaryError { n: number; p50Ms: number; p90Ms: number; maxMs: number; meanMs: number; unmatched: number }` e `boundaryError(opts: { predicted: number[]; truth: number[]; toleranceMs?: number }): BoundaryError`. Cada fronteira da verdade é casada com a fronteira predita mais próxima dentro de `toleranceMs`; as sem par entram em `unmatched` e não poluem os percentis.

- [ ] **Step 1: Escrever o teste que falha**

`packages/metrics/src/boundary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { boundaryError } from "./boundary.ts";

describe("boundaryError", () => {
  it("dá erro zero para fronteiras idênticas", () => {
    const result = boundaryError({ predicted: [100, 200, 300], truth: [100, 200, 300] });
    expect(result.n).toBe(3);
    expect(result.p50Ms).toBe(0);
    expect(result.p90Ms).toBe(0);
    expect(result.maxMs).toBe(0);
    expect(result.unmatched).toBe(0);
  });

  it("mede a distância absoluta até a fronteira mais próxima", () => {
    const result = boundaryError({ predicted: [110, 190, 305], truth: [100, 200, 300] });
    expect(result.n).toBe(3);
    expect(result.maxMs).toBe(10);
    expect(result.meanMs).toBeCloseTo((10 + 10 + 5) / 3, 6);
  });

  it("calcula p50 e p90 sobre os erros ordenados", () => {
    // erros: 0,1,2,3,4,5,6,7,8,100 -> p50 = 5, p90 = 100
    const truth = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];
    const predicted = [0, 101, 202, 303, 404, 505, 606, 707, 808, 1000];
    const result = boundaryError({ predicted, truth, toleranceMs: 200 });
    expect(result.p50Ms).toBe(5);
    expect(result.p90Ms).toBe(100);
  });

  it("conta como unmatched a fronteira sem par dentro da tolerância", () => {
    const result = boundaryError({
      predicted: [100],
      truth: [100, 5000],
      toleranceMs: 200,
    });
    expect(result.n).toBe(1);
    expect(result.unmatched).toBe(1);
    expect(result.p50Ms).toBe(0);
  });

  it("devolve zeros e unmatched total quando não há predição", () => {
    const result = boundaryError({ predicted: [], truth: [100, 200] });
    expect(result.n).toBe(0);
    expect(result.unmatched).toBe(2);
    expect(result.p50Ms).toBe(0);
    expect(result.p90Ms).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar o teste para vê-lo falhar**

Run: `pnpm vitest run packages/metrics`
Expected: FAIL — `Failed to resolve import "./boundary.ts"`

- [ ] **Step 3: Implementar**

`packages/metrics/src/boundary.ts`:

```ts
export interface BoundaryError {
  /** Quantas fronteiras da verdade acharam par dentro da tolerância. */
  n: number;
  p50Ms: number;
  p90Ms: number;
  maxMs: number;
  meanMs: number;
  /** Fronteiras da verdade sem nenhuma predição perto. */
  unmatched: number;
}

/** Percentil por interpolação de índice mais próximo, sobre lista ordenada. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index]!;
}

/**
 * Erro de fronteira: para cada tempo em `truth`, a distância até o tempo mais
 * próximo em `predicted`. Fronteiras sem par dentro de `toleranceMs` viram
 * `unmatched` em vez de inflar os percentis com um número arbitrário.
 */
export function boundaryError(opts: {
  predicted: number[];
  truth: number[];
  toleranceMs?: number;
}): BoundaryError {
  const toleranceMs = opts.toleranceMs ?? 500;
  const predicted = [...opts.predicted].sort((a, b) => a - b);

  const errors: number[] = [];
  let unmatched = 0;

  for (const target of opts.truth) {
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of predicted) {
      const distance = Math.abs(candidate - target);
      if (distance < best) best = distance;
      // predicted está ordenado: passou do alvo, só piora daqui.
      if (candidate > target && distance > best) break;
    }
    if (best <= toleranceMs) errors.push(best);
    else unmatched++;
  }

  errors.sort((a, b) => a - b);
  const mean = errors.length === 0
    ? 0
    : errors.reduce((sum, e) => sum + e, 0) / errors.length;

  return {
    n: errors.length,
    p50Ms: percentile(errors, 0.5),
    p90Ms: percentile(errors, 0.9),
    maxMs: errors.length === 0 ? 0 : errors[errors.length - 1]!,
    meanMs: mean,
    unmatched,
  };
}
```

`packages/metrics/src/index.ts` (substituir):

```ts
export type { IntervalScore } from "./intervals.ts";
export type { BoundaryError } from "./boundary.ts";
export { scoreIntervals } from "./intervals.ts";
export { boundaryError } from "./boundary.ts";
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run packages/metrics`
Expected: PASS — 11 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(metrics): erro de fronteira com p50, p90 e contagem de não pareados

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: `services/speech` — sidecar Python com WhisperX

**Files:**
- Create: `services/speech/pyproject.toml`, `services/speech/transcribe.py`, `services/speech/README.md`
- Modify: `.gitignore` (já cobre `.venv/`)

**Interfaces:**
- Consumes: nada dos pacotes TS
- Produces: um executável de linha de comando que recebe `--wav` e escreve em stdout o JSON `{ "language": string, "words": [{ "text", "startMs", "endMs", "confidence", "sentenceIndex" }] }`. **Este é o contrato que a Task 11 consome** — se o WhisperX tiver mudado de API, conserte aqui e mantenha o formato de saída.

Esta tarefa não tem teste automatizado em vitest: depende de baixar modelo e de rede. A verificação é manual, no Step 4, e é obrigatória antes de seguir.

- [ ] **Step 1: Criar o ambiente Python fixado em 3.11**

O Python do sistema é 3.14, que não tem wheels de `torch`/`ctranslate2`. O `uv` instala e fixa a 3.11 só para este serviço.

```bash
cd "/Users/jhonatan/Repos/Video editor"
mkdir -p services/speech
uv python install 3.11
```

- [ ] **Step 2: Escrever o `pyproject.toml` e instalar**

`services/speech/pyproject.toml`:

```toml
[project]
name = "decupa-speech"
version = "0.1.0"
description = "Sidecar de transcrição e alinhamento forçado do Decupa"
requires-python = ">=3.11,<3.12"
dependencies = ["whisperx"]

[tool.uv]
package = false
```

```bash
cd services/speech
uv sync --python 3.11
uv run python -c "import whisperx, torch; print('whisperx ok, torch', torch.__version__)"
```

Expected: imprime a versão do torch sem erro. Se falhar aqui, o problema é ambiente e não código — resolva antes de continuar.

- [ ] **Step 3: Escrever o script**

`services/speech/transcribe.py`:

```python
"""Transcreve e alinha um WAV, emitindo tokens com tempo em ms inteiros.

Contrato de saída (stdout, JSON):
  {"language": "pt", "words": [
     {"text": "eu", "startMs": 120, "endMs": 260,
      "confidence": 0.91, "sentenceIndex": 0}, ...]}
"""

from __future__ import annotations

import argparse
import json
import sys

import whisperx


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", required=True)
    parser.add_argument("--language", default="pt")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--batch-size", type=int, default=8)
    args = parser.parse_args()

    audio = whisperx.load_audio(args.wav)

    asr = whisperx.load_model(
        args.model,
        args.device,
        compute_type=args.compute_type,
        language=args.language,
    )
    transcription = asr.transcribe(audio, batch_size=args.batch_size)

    align_model, align_meta = whisperx.load_align_model(
        language_code=args.language, device=args.device
    )
    aligned = whisperx.align(
        transcription["segments"],
        align_model,
        align_meta,
        audio,
        args.device,
        return_char_alignments=False,
    )

    words = []
    for sentence_index, segment in enumerate(aligned["segments"]):
        for word in segment.get("words", []):
            # Palavras sem tempo acontecem quando o alinhador não acha o áudio
            # correspondente. Descartar é melhor que inventar um tempo.
            if "start" not in word or "end" not in word:
                continue
            words.append(
                {
                    "text": word["word"].strip(),
                    "startMs": int(round(word["start"] * 1000)),
                    "endMs": int(round(word["end"] * 1000)),
                    "confidence": float(word.get("score", 0.0)),
                    "sentenceIndex": sentence_index,
                }
            )

    json.dump({"language": args.language, "words": words}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

`services/speech/README.md`:

```markdown
# services/speech

Sidecar de transcrição e alinhamento forçado. Python 3.11 fixado via uv, porque
`torch` e `ctranslate2` não têm wheels para o 3.14 do sistema.

    uv sync --python 3.11
    uv run python transcribe.py --wav caminho.wav --language pt

Escreve JSON em stdout. Tempo sempre em milissegundo inteiro — o lado
TypeScript nunca vê segundo fracionário.

O modelo de alinhamento de PT é baixado pelo WhisperX na primeira execução.
Se ele mudar de nome ou sumir, é aqui que se conserta, mantendo o formato de
saída intacto.
```

- [ ] **Step 4: Rodar no fixture de fala e conferir o contrato**

O fixture `speech.wav` diz "Eu acho que a gente devia mudar isso hoje mesmo."

```bash
cd "/Users/jhonatan/Repos/Video editor/services/speech"
uv run python transcribe.py \
  --wav ../../tests/fixtures/generated/speech.wav --language pt \
  | python3 -m json.tool | head -30
```

Expected: JSON com `language: "pt"` e uma lista `words` com ~9 entradas, cada uma com `text`, `startMs`, `endMs` inteiros crescentes e `confidence` entre 0 e 1. As primeiras palavras devem ser reconhecíveis como "Eu", "acho", "que".

Se o WhisperX tiver mudado de API, o erro aparece aqui. Conserte o script mantendo o formato de saída — o contrato é o JSON, não a biblioteca.

- [ ] **Step 5: Commit**

```bash
cd "/Users/jhonatan/Repos/Video editor"
git add -A
git commit -m "feat(speech): sidecar WhisperX com saída de tokens em ms inteiros

Python 3.11 fixado via uv; o 3.14 do sistema não tem wheels de torch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: `@decupa/transcript` — tipos e ponte para o sidecar

**Files:**
- Create: `packages/transcript/package.json`, `packages/transcript/tsconfig.json`, `packages/transcript/src/types.ts`, `packages/transcript/src/tokens.ts`, `packages/transcript/src/transcribe.ts`, `packages/transcript/src/index.ts`
- Test: `packages/transcript/src/tokens.test.ts`

**Interfaces:**
- Consumes: `extractAudio` de `@decupa/media`
- Produces:
  - `TranscriptToken { id: TokenId; text: string; startMs: number; endMs: number; confidence: number; sentenceIndex: number }`, `TokenId = string`, `Transcript { language: string; tokens: TranscriptToken[] }`
  - `toTokens(words: RawWord[]): TranscriptToken[]` — atribui os IDs `w_000000`. Testável puro.
  - `wordBoundaries(transcript: Transcript): number[]` — todas as fronteiras (início e fim de cada token), ordenadas e deduplicadas. É o que a Task 13 alimenta no `boundaryError`.
  - `transcribe(opts: { input: string; language?: string; model?: string }): Promise<Transcript>` — extrai o áudio, chama o sidecar, devolve tokens.

O `toTokens` e o `wordBoundaries` são testados; o `transcribe` não, porque depende do sidecar. A Task 13 o exercita de verdade.

- [ ] **Step 1: Escrever o teste que falha**

`packages/transcript/src/tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { toTokens, wordBoundaries } from "./tokens.ts";

const words = [
  { text: "eu", startMs: 100, endMs: 260, confidence: 0.9, sentenceIndex: 0 },
  { text: "acho", startMs: 260, endMs: 520, confidence: 0.8, sentenceIndex: 0 },
  { text: "que", startMs: 520, endMs: 610, confidence: 0.95, sentenceIndex: 0 },
];

describe("toTokens", () => {
  it("atribui IDs sequenciais com seis dígitos", () => {
    const tokens = toTokens(words);
    expect(tokens.map((t) => t.id)).toEqual(["w_000000", "w_000001", "w_000002"]);
  });

  it("preserva texto e tempos", () => {
    const tokens = toTokens(words);
    expect(tokens[1]).toMatchObject({
      text: "acho", startMs: 260, endMs: 520, confidence: 0.8, sentenceIndex: 0,
    });
  });

  it("arredonda tempo fracionário para inteiro", () => {
    const tokens = toTokens([
      { text: "a", startMs: 100.4, endMs: 260.6, confidence: 1, sentenceIndex: 0 },
    ]);
    expect(tokens[0]!.startMs).toBe(100);
    expect(tokens[0]!.endMs).toBe(261);
  });

  it("devolve lista vazia para entrada vazia", () => {
    expect(toTokens([])).toEqual([]);
  });
});

describe("wordBoundaries", () => {
  it("junta início e fim, ordenado e sem repetição", () => {
    const boundaries = wordBoundaries({ language: "pt", tokens: toTokens(words) });
    expect(boundaries).toEqual([100, 260, 520, 610]);
  });

  it("devolve lista vazia sem tokens", () => {
    expect(wordBoundaries({ language: "pt", tokens: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Criar o pacote e rodar o teste para vê-lo falhar**

`packages/transcript/package.json`:

```json
{
  "name": "@decupa/transcript",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@decupa/core": "workspace:*",
    "@decupa/media": "workspace:*"
  }
}
```

`packages/transcript/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

```bash
pnpm install
pnpm vitest run packages/transcript
```

Expected: FAIL — `Failed to resolve import "./tokens.ts"`

- [ ] **Step 3: Implementar tipos e tokens**

`packages/transcript/src/types.ts`:

```ts
export type TokenId = string;

/** Palavra alinhada. Tempo sempre em ms inteiro. */
export interface TranscriptToken {
  id: TokenId;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  sentenceIndex: number;
}

export interface Transcript {
  language: string;
  tokens: TranscriptToken[];
}

/** Formato cru vindo do sidecar Python, antes de ganhar ID. */
export interface RawWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  sentenceIndex: number;
}
```

`packages/transcript/src/tokens.ts`:

```ts
import type { RawWord, Transcript, TranscriptToken } from "./types.ts";

/** `w_000318` — índice global, seis dígitos. Ver Global Constraints. */
export function tokenId(index: number): string {
  return `w_${String(index).padStart(6, "0")}`;
}

export function toTokens(words: RawWord[]): TranscriptToken[] {
  return words.map((word, index) => ({
    id: tokenId(index),
    text: word.text,
    startMs: Math.round(word.startMs),
    endMs: Math.round(word.endMs),
    confidence: word.confidence,
    sentenceIndex: word.sentenceIndex,
  }));
}

/** Todas as fronteiras de palavra, ordenadas e sem repetição. */
export function wordBoundaries(transcript: Transcript): number[] {
  const unique = new Set<number>();
  for (const token of transcript.tokens) {
    unique.add(token.startMs);
    unique.add(token.endMs);
  }
  return [...unique].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run packages/transcript`
Expected: PASS — 6 testes verdes.

- [ ] **Step 5: Implementar a ponte para o sidecar**

`packages/transcript/src/transcribe.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractAudio } from "@decupa/media";
import { toTokens } from "./tokens.ts";
import type { RawWord, Transcript } from "./types.ts";

const run = promisify(execFile);

/** packages/transcript/src -> ../../../services/speech */
const SPEECH_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../services/speech",
);

interface SidecarOutput {
  language: string;
  words: RawWord[];
}

/**
 * Extrai o áudio para um WAV temporário e roda o sidecar Python.
 * O WAV temporário é sempre removido, inclusive em erro.
 */
export async function transcribe(opts: {
  input: string;
  language?: string;
  model?: string;
}): Promise<Transcript> {
  const language = opts.language ?? "pt";
  const model = opts.model ?? "small";
  const dir = await mkdtemp(join(tmpdir(), "decupa-asr-"));
  const wav = join(dir, "audio.wav");

  try {
    await extractAudio({ input: opts.input, output: wav });

    const { stdout } = await run("uv", [
      "run", "python", "transcribe.py",
      "--wav", wav,
      "--language", language,
      "--model", model,
    ], { cwd: SPEECH_DIR, maxBuffer: 256 * 1024 * 1024 });

    const parsed = JSON.parse(stdout) as SidecarOutput;
    return { language: parsed.language, tokens: toTokens(parsed.words) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

`packages/transcript/src/index.ts`:

```ts
export type { RawWord, TokenId, Transcript, TranscriptToken } from "./types.ts";
export { toTokens, tokenId, wordBoundaries } from "./tokens.ts";
export { transcribe } from "./transcribe.ts";
```

- [ ] **Step 6: Verificar a ponte de ponta a ponta**

```bash
cd "/Users/jhonatan/Repos/Video editor"
node --experimental-strip-types -e '
import { transcribe } from "./packages/transcript/src/index.ts";
const t = await transcribe({ input: "tests/fixtures/generated/speech.wav" });
console.log(t.tokens.slice(0, 5).map((x) => `${x.id} ${x.text} ${x.startMs}-${x.endMs}`).join("\n"));
console.log("total de tokens:", t.tokens.length);
'
```

Expected: cinco linhas no formato `w_000000 Eu 120-260`, com tempos crescentes, e um total em torno de 9 tokens.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(transcript): tokens com ID estável e ponte para o sidecar de fala

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: `apps/cli` — comando `gold`

**Files:**
- Create: `apps/cli/package.json`, `apps/cli/tsconfig.json`, `apps/cli/src/index.ts`, `apps/cli/src/gold.ts`
- Test: `apps/cli/src/gold.test.ts`

**Interfaces:**
- Consumes: `alignEditedFiles` de `@decupa/goldedit`; `probe` de `@decupa/media`; `totalDurationMs` de `@decupa/core`
- Produces: `runGold(opts: { rawPath: string; editedPath: string; outPath: string }): Promise<GoldEditFile>` e `GoldEditFile { raw, edited, rawDurationMs, editedDurationMs, removedMs, removed: Interval[], generatedAt }`. A Task 14 lê esse arquivo.

- [ ] **Step 1: Escrever o teste que falha**

`apps/cli/src/gold.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, TRUTH } from "../../../tests/fixtures/global-setup.ts";
import { runGold } from "./gold.ts";

describe("runGold", () => {
  it("grava um arquivo de gold edit com os intervalos removidos", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-gold-"));
    const outPath = join(dir, "gold.json");

    const result = await runGold({
      rawPath: join(FIXTURES, "raw.wav"),
      editedPath: join(FIXTURES, "edited.wav"),
      outPath,
    });

    expect(result.removed).toHaveLength(2);
    expect(result.rawDurationMs).toBe(6000);
    expect(result.editedDurationMs).toBe(4600);
    expect(Math.abs(result.removedMs - 1400)).toBeLessThanOrEqual(50);

    const written = JSON.parse(await readFile(outPath, "utf8"));
    expect(written.removed).toEqual(result.removed);
    expect(typeof written.generatedAt).toBe("string");
  });

  it("os intervalos batem com a verdade dentro de 25 ms", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-gold-"));
    const result = await runGold({
      rawPath: join(FIXTURES, "raw.wav"),
      editedPath: join(FIXTURES, "edited.wav"),
      outPath: join(dir, "gold.json"),
    });

    for (const [i, truth] of TRUTH.removed.entries()) {
      expect(Math.abs(result.removed[i]!.startMs - truth.startMs)).toBeLessThanOrEqual(25);
      expect(Math.abs(result.removed[i]!.endMs - truth.endMs)).toBeLessThanOrEqual(25);
    }
  });

  it("avisa quando o editado é mais longo que o bruto", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-gold-"));
    await expect(runGold({
      rawPath: join(FIXTURES, "edited.wav"),
      editedPath: join(FIXTURES, "raw.wav"),
      outPath: join(dir, "gold.json"),
    })).rejects.toThrow(/mais longo que o bruto/);
  });
});
```

- [ ] **Step 2: Criar o pacote e rodar o teste para vê-lo falhar**

`apps/cli/package.json`:

```json
{
  "name": "@decupa/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "decupa": "./src/index.ts" },
  "dependencies": {
    "@decupa/acoustics": "workspace:*",
    "@decupa/core": "workspace:*",
    "@decupa/goldedit": "workspace:*",
    "@decupa/media": "workspace:*",
    "@decupa/metrics": "workspace:*",
    "@decupa/transcript": "workspace:*"
  }
}
```

`apps/cli/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

```bash
pnpm install
pnpm vitest run apps/cli
```

Expected: FAIL — `Failed to resolve import "./gold.ts"`

- [ ] **Step 3: Implementar**

`apps/cli/src/gold.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { totalDurationMs, type Interval } from "@decupa/core";
import { alignEditedFiles } from "@decupa/goldedit";
import { probe } from "@decupa/media";

export interface GoldEditFile {
  raw: string;
  edited: string;
  rawDurationMs: number;
  editedDurationMs: number;
  removedMs: number;
  removed: Interval[];
  generatedAt: string;
}

/**
 * Deriva os cortes de um par bruto/editado e grava o gold edit em JSON.
 * É assim que o trabalho já feito pelo time vira dataset anotado.
 */
export async function runGold(opts: {
  rawPath: string;
  editedPath: string;
  outPath: string;
}): Promise<GoldEditFile> {
  const [rawInfo, editedInfo] = await Promise.all([
    probe(opts.rawPath),
    probe(opts.editedPath),
  ]);

  if (editedInfo.durationMs > rawInfo.durationMs) {
    throw new Error(
      `o editado (${editedInfo.durationMs} ms) é mais longo que o bruto ` +
      `(${rawInfo.durationMs} ms) — os argumentos parecem trocados`,
    );
  }

  const removed = await alignEditedFiles({
    rawPath: opts.rawPath,
    editedPath: opts.editedPath,
  });

  const result: GoldEditFile = {
    raw: opts.rawPath,
    edited: opts.editedPath,
    rawDurationMs: rawInfo.durationMs,
    editedDurationMs: editedInfo.durationMs,
    removedMs: totalDurationMs(removed),
    removed,
    generatedAt: new Date().toISOString(),
  };

  await writeFile(opts.outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
```

`apps/cli/src/index.ts`:

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runGold } from "./gold.ts";

const USAGE = `decupa — bancada de medição

  decupa gold --raw <bruto> --edited <editado> --out <gold.json>
      Deriva os cortes de um par bruto/editado.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "gold") {
    const { values } = parseArgs({
      args: rest,
      options: {
        raw: { type: "string" },
        edited: { type: "string" },
        out: { type: "string" },
      },
    });
    if (!values.raw || !values.edited || !values.out) {
      console.error("gold precisa de --raw, --edited e --out");
      return 1;
    }
    const result = await runGold({
      rawPath: values.raw,
      editedPath: values.edited,
      outPath: values.out,
    });
    console.log(
      `${result.removed.length} cortes · ${result.removedMs} ms removidos ` +
      `de ${result.rawDurationMs} ms · gravado em ${values.out}`,
    );
    return 0;
  }

  console.log(USAGE);
  return command === undefined ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run apps/cli`
Expected: PASS — 3 testes verdes.

- [ ] **Step 5: Rodar a CLI de verdade**

```bash
cd "/Users/jhonatan/Repos/Video editor"
pnpm decupa gold \
  --raw tests/fixtures/generated/raw.wav \
  --edited tests/fixtures/generated/edited.wav \
  --out /tmp/gold.json
cat /tmp/gold.json
```

Expected: imprime `2 cortes · ~1400 ms removidos de 6000 ms` e o JSON tem `removed` com os intervalos perto de `[1200,2000]` e `[3500,4100]`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): comando gold deriva dataset anotado de par bruto/editado

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: `apps/cli` — comando `measure`

O comando que responde o portão da Fase 0.

**Files:**
- Create: `apps/cli/src/measure.ts`
- Modify: `apps/cli/src/index.ts`
- Test: `apps/cli/src/measure.test.ts`

**Interfaces:**
- Consumes: `transcribe`, `wordBoundaries` de `@decupa/transcript`; `boundaryError` de `@decupa/metrics`; `probe` de `@decupa/media`
- Produces: `runMeasure(opts: { input: string; truthPath: string; language?: string; model?: string; toleranceMs?: number }): Promise<MeasureReport>` e `MeasureReport { input, language, model, tokenCount, boundaries, truthBoundaries, error: BoundaryError, gatePassed, measuredAt }`. O arquivo de verdade é um JSON `{ "boundariesMs": number[] }` marcado à mão.

- [ ] **Step 1: Escrever o teste que falha**

`apps/cli/src/measure.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateGate, loadTruthBoundaries } from "./measure.ts";

describe("loadTruthBoundaries", () => {
  it("aceita o formato de arquivo de verdade", () => {
    expect(loadTruthBoundaries('{"boundariesMs":[100,260,520]}')).toEqual([100, 260, 520]);
  });

  it("ordena e remove repetição", () => {
    expect(loadTruthBoundaries('{"boundariesMs":[520,100,260,100]}')).toEqual([100, 260, 520]);
  });

  it("dá erro claro quando falta a chave", () => {
    expect(() => loadTruthBoundaries("{}")).toThrow(/boundariesMs/);
  });

  it("dá erro claro quando não é lista de números", () => {
    expect(() => loadTruthBoundaries('{"boundariesMs":["a"]}')).toThrow(/boundariesMs/);
  });
});

describe("evaluateGate", () => {
  it("passa quando p90 fica no limite", () => {
    expect(evaluateGate({ n: 10, p50Ms: 20, p90Ms: 50, maxMs: 80, meanMs: 25, unmatched: 0 })).toBe(true);
  });

  it("reprova quando p90 passa de 50 ms", () => {
    expect(evaluateGate({ n: 10, p50Ms: 20, p90Ms: 51, maxMs: 80, meanMs: 25, unmatched: 0 })).toBe(false);
  });

  it("reprova quando mais de 5% das fronteiras não acharam par", () => {
    expect(evaluateGate({ n: 90, p50Ms: 5, p90Ms: 10, maxMs: 20, meanMs: 6, unmatched: 10 })).toBe(false);
  });

  it("reprova quando não há fronteira nenhuma casada", () => {
    expect(evaluateGate({ n: 0, p50Ms: 0, p90Ms: 0, maxMs: 0, meanMs: 0, unmatched: 12 })).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste para vê-lo falhar**

Run: `pnpm vitest run apps/cli`
Expected: FAIL — `Failed to resolve import "./measure.ts"`

- [ ] **Step 3: Implementar**

`apps/cli/src/measure.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { boundaryError, type BoundaryError } from "@decupa/metrics";
import { transcribe, wordBoundaries } from "@decupa/transcript";

/** Limiares do portão da Fase 0. Ver a spec. */
export const GATE_P90_MS = 50;
export const GATE_MAX_UNMATCHED_RATIO = 0.05;

export interface MeasureReport {
  input: string;
  language: string;
  model: string;
  tokenCount: number;
  boundaries: number[];
  truthBoundaries: number[];
  error: BoundaryError;
  gatePassed: boolean;
  measuredAt: string;
}

/** Arquivo de verdade: `{ "boundariesMs": [120, 260, 520, ...] }`, em ms. */
export function loadTruthBoundaries(json: string): number[] {
  const parsed = JSON.parse(json) as { boundariesMs?: unknown };
  const raw = parsed.boundariesMs;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "number")) {
    throw new Error("arquivo de verdade precisa de boundariesMs: number[]");
  }
  return [...new Set(raw as number[])].sort((a, b) => a - b);
}

export function evaluateGate(error: BoundaryError): boolean {
  const total = error.n + error.unmatched;
  if (total === 0 || error.n === 0) return false;
  if (error.unmatched / total > GATE_MAX_UNMATCHED_RATIO) return false;
  return error.p90Ms <= GATE_P90_MS;
}

export async function runMeasure(opts: {
  input: string;
  truthPath: string;
  language?: string;
  model?: string;
  toleranceMs?: number;
  outPath?: string;
}): Promise<MeasureReport> {
  const language = opts.language ?? "pt";
  const model = opts.model ?? "small";

  const truthBoundaries = loadTruthBoundaries(await readFile(opts.truthPath, "utf8"));
  const transcript = await transcribe({ input: opts.input, language, model });
  const boundaries = wordBoundaries(transcript);

  const error = boundaryError({
    predicted: boundaries,
    truth: truthBoundaries,
    toleranceMs: opts.toleranceMs ?? 500,
  });

  const report: MeasureReport = {
    input: opts.input,
    language,
    model,
    tokenCount: transcript.tokens.length,
    boundaries,
    truthBoundaries,
    error,
    gatePassed: evaluateGate(error),
    measuredAt: new Date().toISOString(),
  };

  if (opts.outPath) {
    await writeFile(opts.outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  return report;
}
```

`apps/cli/src/index.ts` (substituir o corpo de `main`, mantendo o resto):

```ts
#!/usr/bin/env node
import { parseArgs } from "node:util";
import { runGold } from "./gold.ts";
import { GATE_P90_MS, runMeasure } from "./measure.ts";

const USAGE = `decupa — bancada de medição

  decupa gold --raw <bruto> --edited <editado> --out <gold.json>
      Deriva os cortes de um par bruto/editado.

  decupa measure --input <video|wav> --truth <verdade.json> [--model small] [--out <relatorio.json>]
      Mede o erro de fronteira de palavra do alinhamento contra fronteiras
      marcadas à mão. Portão da Fase 0: p90 <= ${GATE_P90_MS} ms.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "gold") {
    const { values } = parseArgs({
      args: rest,
      options: {
        raw: { type: "string" },
        edited: { type: "string" },
        out: { type: "string" },
      },
    });
    if (!values.raw || !values.edited || !values.out) {
      console.error("gold precisa de --raw, --edited e --out");
      return 1;
    }
    const result = await runGold({
      rawPath: values.raw,
      editedPath: values.edited,
      outPath: values.out,
    });
    console.log(
      `${result.removed.length} cortes · ${result.removedMs} ms removidos ` +
      `de ${result.rawDurationMs} ms · gravado em ${values.out}`,
    );
    return 0;
  }

  if (command === "measure") {
    const { values } = parseArgs({
      args: rest,
      options: {
        input: { type: "string" },
        truth: { type: "string" },
        model: { type: "string" },
        out: { type: "string" },
      },
    });
    if (!values.input || !values.truth) {
      console.error("measure precisa de --input e --truth");
      return 1;
    }
    const report = await runMeasure({
      input: values.input,
      truthPath: values.truth,
      model: values.model,
      outPath: values.out,
    });
    const { error } = report;
    console.log(
      `${report.tokenCount} tokens · ${error.n} fronteiras casadas, ` +
      `${error.unmatched} sem par\n` +
      `p50 ${error.p50Ms} ms · p90 ${error.p90Ms} ms · max ${error.maxMs} ms\n` +
      `portão (p90 <= ${GATE_P90_MS} ms): ${report.gatePassed ? "PASSOU" : "REPROVOU"}`,
    );
    return report.gatePassed ? 0 : 2;
  }

  console.log(USAGE);
  return command === undefined ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run apps/cli`
Expected: PASS — 11 testes verdes (3 de gold, 8 de measure).

- [ ] **Step 5: Rodar `measure` de verdade no fixture de fala**

> **Esta instrução foi reescrita depois de uma auditoria.** A versão anterior
> mandava imprimir a transcrição e "corrigir o que estiver errado". Isso ancora
> quem marca e produz verdade circular: numa execução real, as 9 fronteiras
> gravadas eram todas subconjunto exato da saída do alinhador, e o p90 deu 0 ms
> por aritmética, não por qualidade. **Nunca produza a verdade a partir da
> predição.**

Marcar as fronteiras **às cegas**, sem nunca ver a saída do alinhador. Use o
comando dedicado, que toca janelas curtas a partir do cursor e nunca exibe
predição:

```bash
cd "/Users/jhonatan/Repos/Video editor"
pnpm decupa mark \
  --input tests/fixtures/generated/speech.wav \
  --out /tmp/verdade-speech.json
```

Ouça: se o cursor está no ataque da palavra, ela entra limpa; cedo demais, entra
silêncio antes; tarde demais, a palavra entra decapitada. Ajuste com as setas
(±10 ms) ou shift+setas (±50 ms), `enter` marca, `q` grava e sai.

O arquivo gravado carrega `"method": "blind-keyboard"`. Sem esse carimbo o
`measure` sai com código 3 e o `report` recusa liberar o portão — de propósito.

```bash
pnpm decupa measure \
  --input tests/fixtures/generated/speech.wav \
  --truth /tmp/verdade-speech.json \
  --out /tmp/relatorio.json
```

Expected: imprime p50/p90/max e o veredito do portão. **O número que importa é o
do material real do time** — este passo só confirma que o encanamento funciona
ponta a ponta. E nove fronteiras de uma frase sintética não decidem nada: o
portão de verdade pede ~200 fronteiras em 5 trechos, com os falantes recorrentes
e com material que tem ruído e fala rápida.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): comando measure com o portão de p90 <= 50 ms da fase 0

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 14: `apps/cli` — comando `report`

Junta os relatórios de vários trechos numa página HTML só, para a conversa de vai/não-vai acontecer olhando números em vez de impressões.

**Files:**
- Create: `apps/cli/src/report.ts`
- Modify: `apps/cli/src/index.ts`
- Test: `apps/cli/src/report.test.ts`

**Interfaces:**
- Consumes: `MeasureReport` da Task 13
- Produces: `renderReport(reports: MeasureReport[]): string` (HTML) e `runReport(opts: { inputPaths: string[]; outPath: string }): Promise<string>`. Fim da linha — nada consome isto.

- [ ] **Step 1: Escrever o teste que falha**

`apps/cli/src/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MeasureReport } from "./measure.ts";
import { aggregate, renderReport } from "./report.ts";

const report = (name: string, p50: number, p90: number, passed: boolean): MeasureReport => ({
  input: name,
  language: "pt",
  model: "small",
  tokenCount: 100,
  boundaries: [],
  truthBoundaries: [],
  error: { n: 20, p50Ms: p50, p90Ms: p90, maxMs: p90 + 10, meanMs: p50, unmatched: 0 },
  gatePassed: passed,
  measuredAt: "2026-09-01T00:00:00.000Z",
});

describe("aggregate", () => {
  it("conta aprovados e reprovados", () => {
    const summary = aggregate([
      report("a.wav", 10, 30, true),
      report("b.wav", 20, 45, true),
      report("c.wav", 60, 120, false),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
  });

  it("usa o pior p90 como veredito global", () => {
    const summary = aggregate([
      report("a.wav", 10, 30, true),
      report("c.wav", 60, 120, false),
    ]);
    expect(summary.worstP90Ms).toBe(120);
    expect(summary.gatePassed).toBe(false);
  });

  it("aprova só quando todos passam", () => {
    const summary = aggregate([report("a.wav", 10, 30, true), report("b.wav", 20, 45, true)]);
    expect(summary.gatePassed).toBe(true);
  });

  it("trata lista vazia", () => {
    const summary = aggregate([]);
    expect(summary.total).toBe(0);
    expect(summary.gatePassed).toBe(false);
  });
});

describe("renderReport", () => {
  it("gera HTML com uma linha por trecho", () => {
    const html = renderReport([report("a.wav", 10, 30, true), report("c.wav", 60, 120, false)]);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("a.wav");
    expect(html).toContain("c.wav");
    expect(html).toContain("REPROVOU");
  });

  it("escapa caminho com caractere de HTML", () => {
    const html = renderReport([report("<script>.wav", 10, 30, true)]);
    expect(html).not.toContain("<script>.wav");
    expect(html).toContain("&lt;script&gt;.wav");
  });
});
```

- [ ] **Step 2: Rodar o teste para vê-lo falhar**

Run: `pnpm vitest run apps/cli`
Expected: FAIL — `Failed to resolve import "./report.ts"`

- [ ] **Step 3: Implementar**

`apps/cli/src/report.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { GATE_P90_MS, type MeasureReport } from "./measure.ts";

export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  worstP90Ms: number;
  gatePassed: boolean;
}

export function aggregate(reports: MeasureReport[]): ReportSummary {
  const passed = reports.filter((r) => r.gatePassed).length;
  const worstP90Ms = reports.reduce((worst, r) => Math.max(worst, r.error.p90Ms), 0);
  return {
    total: reports.length,
    passed,
    failed: reports.length - passed,
    worstP90Ms,
    gatePassed: reports.length > 0 && passed === reports.length,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderReport(reports: MeasureReport[]): string {
  const summary = aggregate(reports);
  const rows = reports
    .map((r) => `      <tr class="${r.gatePassed ? "ok" : "bad"}">
        <td>${escapeHtml(r.input)}</td>
        <td class="n">${r.tokenCount}</td>
        <td class="n">${r.error.n}</td>
        <td class="n">${r.error.unmatched}</td>
        <td class="n">${r.error.p50Ms}</td>
        <td class="n">${r.error.p90Ms}</td>
        <td class="n">${r.error.maxMs}</td>
        <td>${r.gatePassed ? "PASSOU" : "REPROVOU"}</td>
      </tr>`)
    .join("\n");

  return `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<title>Decupa — erro de fronteira de palavra</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 40px auto; max-width: 900px; padding: 0 20px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  .sub { color: #666; margin-bottom: 24px; }
  .verdict { padding: 14px 18px; border-radius: 6px; font-weight: 600; margin-bottom: 24px; }
  .verdict.ok { background: #d6e9df; color: #2f7a5b; }
  .verdict.bad { background: #f2dcd6; color: #b34a33; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #ddd; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #666; }
  td.n { font-variant-numeric: tabular-nums; text-align: right; }
  tr.bad td { background: #fdf3f1; }
</style>
<h1>Erro de fronteira de palavra</h1>
<p class="sub">Portão da Fase 0: p90 &le; ${GATE_P90_MS} ms em todos os trechos.</p>
<div class="verdict ${summary.gatePassed ? "ok" : "bad"}">
  ${summary.passed} de ${summary.total} trechos passaram · pior p90 ${summary.worstP90Ms} ms ·
  ${summary.gatePassed ? "PORTÃO LIBERADO" : "PORTÃO FECHADO"}
</div>
<table>
  <thead>
    <tr>
      <th>Trecho</th><th>Tokens</th><th>Casadas</th><th>Sem par</th>
      <th>p50 ms</th><th>p90 ms</th><th>max ms</th><th>Veredito</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
</html>
`;
}

export async function runReport(opts: {
  inputPaths: string[];
  outPath: string;
}): Promise<string> {
  const reports: MeasureReport[] = [];
  for (const path of opts.inputPaths) {
    reports.push(JSON.parse(await readFile(path, "utf8")) as MeasureReport);
  }
  const html = renderReport(reports);
  await writeFile(opts.outPath, html, "utf8");
  return html;
}
```

`apps/cli/src/index.ts` — adicionar o import e o bloco do comando antes do `console.log(USAGE)`:

```ts
import { runReport } from "./report.ts";
```

```ts
  if (command === "report") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { out: { type: "string" } },
      allowPositionals: true,
    });
    if (positionals.length === 0 || !values.out) {
      console.error("report precisa de --out e ao menos um relatório .json");
      return 1;
    }
    await runReport({ inputPaths: positionals, outPath: values.out });
    console.log(`relatório de ${positionals.length} trechos em ${values.out}`);
    return 0;
  }
```

E acrescentar ao `USAGE`:

```
  decupa report --out <relatorio.html> <medida1.json> [medida2.json ...]
      Junta relatórios de measure numa página só.
```

- [ ] **Step 4: Rodar os testes e ver passar**

Run: `pnpm vitest run apps/cli`
Expected: PASS — 17 testes verdes.

- [ ] **Step 5: Rodar a suíte inteira e o typecheck**

```bash
pnpm vitest run
pnpm typecheck
```

Expected: 72 testes verdes ao todo — core 7, media 10, acoustics 11, goldedit 10, metrics 11, transcript 6, cli 17 — e typecheck sem erro.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cli): relatório HTML consolidado do erro de fronteira

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Como usar a bancada depois de pronta

```bash
# 1. Transformar pares bruto/editado já existentes em dataset anotado
for par in rushes/*/; do
  pnpm decupa gold --raw "$par/bruto.mp4" --edited "$par/editado.mp4" --out "$par/gold.json"
done

# 2. Marcar as fronteiras às cegas, um trecho por vez (não pule esta etapa)
for t in trechos/*.mp4; do
  pnpm decupa mark --input "$t" --out "${t%.mp4}.verdade.json"
done

# 3. Medir o alinhamento contra as fronteiras marcadas
for t in trechos/*.mp4; do
  pnpm decupa measure --input "$t" --truth "${t%.mp4}.verdade.json" --out "${t%.mp4}.medida.json"
done

# 4. Consolidar e olhar o veredito
pnpm decupa report --out bench/relatorio.html trechos/*.medida.json
open bench/relatorio.html
```

**O portão da Fase 0 é o veredito dessa página.** Se abrir "PORTÃO FECHADO" com p90 muito acima de 50 ms, a próxima ação é trocar o modelo de alinhamento (`--model medium`, ou MFA no lugar do WhisperX) e re-medir — não é seguir para o plano seguinte.

## Próximo plano

`2026-XX-XX-decupa-bake-off-pipelines.md` — implementa os três pipelines A/B/C sobre este dataset e responde a segunda metade do portão da Fase 0. Depende de: `@decupa/goldedit` (dataset), `@decupa/metrics` (avaliação), chave da API do Gemini, e do dataset coletado com o comando `gold`.

---

## Adendo pós-auditoria (02/09/2026)

A auditoria da execução encontrou um defeito que não estava no código, e sim no
método: a verdade usada no `measure` tinha sido amostrada da saída do próprio
alinhador. As 9 fronteiras eram subconjunto exato da predição, e `p90 = 0 ms`
era consequência aritmética. A ferramenta estava certa; o insumo é que não media
nada. Perturbar 4 fronteiras em 20–80 ms levou o p90 a 80 ms e fechou o portão,
confirmando que a métrica é sensível.

A origem foi este plano: o Step 5 da Task 13 mandava imprimir a transcrição
antes de marcar. Três coisas foram feitas para que não se repita.

**1. `decupa mark` — marcação cega.** `apps/cli/src/mark.ts`. Toca uma janela
curta a partir do cursor e captura fronteiras pelo teclado, sem nunca ler,
importar ou exibir a saída do alinhador. Lógica pura (`decodeKey`, `applyKey`,
`formatTruthFile`) coberta por 18 testes; só o laço de TTY e a chamada do
`ffplay` ficam sem teste.

**2. Procedência no arquivo de verdade.** O `mark` grava
`"method": "blind-keyboard"`. `loadTruthMethod` lê o campo e `MeasureReport`
passa a carregar `truthMethod`.

**3. O portão passou a exigir procedência.** `decupa measure` sai com **código 3**
e imprime aviso quando a verdade não é cega. `aggregate` ganhou
`unverifiedTruth` e só libera o portão quando todos os trechos passam **e** toda
verdade é cega; o HTML mostra a coluna de procedência e um alerta no topo.

Verificado contra o arquivo circular original: `measure` sai 3 com o aviso, e o
`report` renderiza `PORTÃO FECHADO`. O cenário que passou despercebido agora é
impossível de reportar como aprovação.

**Estado da Fase 0:** o portão não está aprovado nem reprovado — está **não
medido**. Não existe nenhuma evidência sobre a qualidade do alinhamento em
PT-BR neste repositório. O caminho é marcar às cegas ~200 fronteiras em material
real do time e rodar `measure`.
