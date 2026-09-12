# ICE-2 #04 — OTIO do limpar com hash real e sem fallback 30 fps

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `POST /jobs/:id/export {kind:"otio"}` usa fps/canvas/hash da fonte; probe falho vira erro HTTP, não timeline 30 fps com sha `0{64}`.

**Architecture:** O bloco `kind === "otio"` em `server.ts:371-457` engole falha de `probe` e inventa metadados. `hashFile` já existe em `@decupa/media`; `server.ts` hoje só importa `probe`. Não mexer em `assembly/otio.ts` (plano 09).

**Tech Stack:** TypeScript, vitest, `bootComPlano` já usado em `server.test.ts`. Fixture `clip.mp4` (25 fps, 320×240).

**Base:** `403bcf8`. **Donos:** `apps/cli/src/app/server.ts` (import + bloco otio), `apps/cli/src/app/server.test.ts`.

## Global Constraints

- Não criar `cut-otio.ts`. Não alterar `buildOtio`.
- Sem chamada paga. `git add` só destes arquivos.

---

### Task 1: Hash real, fps da fonte, probe obrigatório

**Files:**
- Modify: `apps/cli/src/app/server.ts:9` (import) e `:371-457`
- Test: `apps/cli/src/app/server.test.ts` (teste existente `export otio` + um caso de probe falho)

**Step 1: Endurecer o teste existente e acrescentar o de erro**

`bootComPlano` (`server.test.ts:40`) usa `input: join(dir, "v.mp4")` **sem criar o arquivo**. O teste atual passa **por causa do fallback 30 fps**. Acrescente imports `copyFile` em `node:fs/promises` e `FIXTURES` de `../../../../../tests/fixtures/global-setup.ts`.

No teste `export otio gera timeline compatível...`, **antes** do `fetch`, copie a fixture:

```ts
    await copyFile(join(FIXTURES, "clip.mp4"), join(dir, "v.mp4"));
```

Substitua as asserções fracas (`toContain("Timeline.1")`) por:

```ts
    const doc = JSON.parse(otio) as {
      metadata: { Resolve: { timelineFrameRate: string; timelineResolutionWidth: string } };
    };
    expect(doc.metadata.Resolve.timelineFrameRate).toBe("25");
    expect(doc.metadata.Resolve.timelineResolutionWidth).toBe("320");
    expect(otio).not.toContain(`"sha256": "${"0".repeat(64)}"`);
```

No mesmo `describe`, acrescente o caso sem arquivo (probe quebra):

```ts
  it("export otio falha em vez de inventar 30 fps quando o probe quebra", async () => {
    const { base, app, dir } = await bootComPlano();
    const res = await fetch(`${base}/jobs/${app.jobId}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "otio" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await expect(readFile(join(dir, "corte.otio"), "utf8")).rejects.toThrow();
  });
```

**Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/server.test.ts -t "export otio"`

Expected: FAIL — fps não é `"25"` (fallback 30) e/ou o sha zero ainda está no JSON.

**Step 3: Corrigir o bloco otio**

1. Import: `import { hashFile, probe, type MediaInfo } from "@decupa/media";`

2. Substituir o bloco `if (kind === "otio") { ... }` por:

```ts
          if (kind === "otio") {
            const info = await probe(input);
            const rate = info.frameRate;
            if (!rate) {
              throw new Error("fonte sem frame rate para exportar OTIO");
            }
            const fps = rate.num / rate.den;
            const durationSeconds = Math.max(info.durationMs / 1000, 0.001);
            const width = info.width;
            const height = info.height;
            if (!width || !height || width % 2 !== 0 || height % 2 !== 0) {
              throw new Error("fonte com canvas inválido para exportar OTIO");
            }
            const sha256 = await hashFile(input);
            const videoClips = (plan.clips as { start: number; end: number }[]).map((clip, i) => {
              const durationFrames = Math.max(1, Math.round((clip.end - clip.start) * fps));
              return {
                id: `v_c${i + 1}`,
                sceneId: `scene_${i + 1}`,
                sourceId: "src1",
                sourceStartSeconds: clip.start,
                durationFrames,
                startFrame: 0,
              };
            });
            let cursor = 0;
            for (const clip of videoClips) {
              clip.startFrame = cursor;
              cursor += clip.durationFrames;
            }
            const audioClips = videoClips.map((clip, i) => ({ ...clip, id: `a_c${i + 1}` }));
            const assembly: Assembly = {
              version: 1,
              revision: 1,
              name: basename(input),
              fps: rate,
              width,
              height,
              sources: [{
                id: "src1",
                path: resolve(input),
                sha256,
                durationSeconds,
                hasVideo: info.hasVideo,
                hasAudio: info.hasAudio,
                fps: rate,
                width,
                height,
                role: "speech",
                included: true,
                name: basename(input),
              }],
              tracks: [
                { kind: "Video", name: "V1", clips: info.hasVideo ? videoClips : [] },
                { kind: "Video", name: "V2", clips: [] },
                { kind: "Audio", name: "A1", clips: info.hasAudio ? audioClips : [] },
              ],
            };
            const out = join(workDir, "corte.otio");
            await writeFile(out, `${buildOtio(assembly)}\n`, "utf8");
            sendJson(res, { path: out, downloadUrl: `/jobs/${current.id}/download/otio` });
            return;
          }
```

`probe` que lança já cai no handler de erro do servidor (4xx/5xx existente). Não engolir.

Confirme que `input` neste bloco é o mesmo path passado a `probeFps` no `kind === "edl"` (variável local do handler). Não invente path.

**Step 4: Rodar server.test.ts**

Run: `npx vitest run apps/cli/src/app/server.test.ts`

Expected: PASS.

**Step 5: Typecheck e commit**

Run: `pnpm run typecheck`

```bash
git add apps/cli/src/app/server.ts apps/cli/src/app/server.test.ts
git commit -m "fix: limpar OTIO uses source probe and real hash, no 30fps fallback"
```
