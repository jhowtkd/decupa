# ICE-2 #08 — extractAudio com seek de saída

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `-ss` vem **depois** de `-i`, para o recorte de alinhamento/snap ser frame-accurate no áudio.

**Architecture:** Hoje `audio.ts` faz `-ss` antes de `-i` (seek de keyframe). `model.ts` já documenta seek de saída para evidência visual. Extrair `extractAudioArgs` puro e testar a ordem dos flags; `extractAudio` só executa esses args.

**Tech Stack:** TypeScript, vitest. Sem mídia nova, sem GOP fixture.

**Base:** `403bcf8`. **Donos:** `packages/media/src/audio.ts`, `packages/media/src/audio.test.ts`.

## Global Constraints

- Não mudar `readPcm`. Não tocar em `transcribe.ts` / `routes.ts` (eles já chamam `extractAudio`).
- Sem dependência nova. `git add` só destes arquivos.

---

### Task 1: Args com -i antes de -ss

**Files:**
- Modify: `packages/media/src/audio.ts`
- Test: `packages/media/src/audio.test.ts`

**Step 1: Teste que falha**

No topo de `audio.test.ts`, importar `extractAudioArgs` junto de `extractAudio`. Dentro de `describe("extractAudio")`:

```ts
  it("coloca -ss depois de -i para o recorte ser preciso no GOP", () => {
    const args = extractAudioArgs({
      input: "/tmp/fala.mp4",
      output: "/tmp/clip.wav",
      startSeconds: 12.5,
      durationSeconds: 1.2,
    });
    const iAt = args.indexOf("-i");
    const ssAt = args.indexOf("-ss");
    expect(iAt).toBeGreaterThan(0);
    expect(ssAt).toBeGreaterThan(iAt);
    expect(args[iAt + 1]).toBe("/tmp/fala.mp4");
    expect(args[ssAt + 1]).toBe("12.5");
    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("1.2");
  });
```

**Step 2: Rodar e ver falhar**

Run: `npx vitest run packages/media/src/audio.test.ts`

Expected: FAIL — `extractAudioArgs` ausente, ou `-ss` antes de `-i`.

**Step 3: Implementar**

Em `audio.ts`, extrair e usar:

```ts
export function extractAudioArgs(opts: {
  input: string;
  output: string;
  sampleRate?: number;
  startSeconds?: number;
  durationSeconds?: number;
}): string[] {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const args = ["-v", "error", "-y", "-i", opts.input];
  // Seek de saída: -ss depois de -i. Seek de entrada (antes de -i) para em
  // keyframe e desloca o PCM que o snap/alinhamento trata como t=0.
  if (opts.startSeconds !== undefined) args.push("-ss", String(opts.startSeconds));
  if (opts.durationSeconds !== undefined) args.push("-t", String(opts.durationSeconds));
  args.push(
    "-vn",
    "-ar", String(sampleRate),
    "-ac", "1",
    "-c:a", "pcm_s16le",
    opts.output,
  );
  return args;
}

export async function extractAudio(opts: {
  input: string;
  output: string;
  sampleRate?: number;
  startSeconds?: number;
  durationSeconds?: number;
}): Promise<void> {
  try {
    await run("ffmpeg", extractAudioArgs(opts));
  } catch (cause) {
    throw new Error(`extração de áudio falhou em ${opts.input}`, { cause });
  }
}
```

Remover o corpo antigo que montava `args` na mão.

**Step 4: Rodar audio.test.ts inteiro**

Run: `npx vitest run packages/media/src/audio.test.ts`

Expected: PASS, inclusive extração real de `clip.mp4` (sem `-ss`).

**Step 5: Typecheck e commit**

Run: `pnpm run typecheck`

```bash
git add packages/media/src/audio.ts packages/media/src/audio.test.ts
git commit -m "fix: extractAudio seeks after -i so alignment PCM starts at t=0"
```
