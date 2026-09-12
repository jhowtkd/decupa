# ICE-2 #09 — available_range OTIO na taxa da timeline

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `media_reference.available_range` usa a mesma `rate` do `source_range` do clipe (fps da timeline), inclusive com fonte 25 fps em timeline 30000/1001.

**Architecture:** `clipItem` já emite `start_time`/`duration` na taxa da timeline. `externalReference` ainda usa `source.fps`. Harmonizar `available_range` para `rate: fps` (timeline) e duração em frames `round(durationSeconds * fps)`. Não mexer em `server.ts` (plano 04).

**Tech Stack:** TypeScript, vitest, `fixtureAssembly`.

**Base:** `403bcf8`. **Donos:** `assembly/otio.ts`, `otio.test.ts`.

## Global Constraints

- Não alterar o cálculo de `source_range` do clipe (já harmonizado na ICE-1).
- Sem dependência nova. `git add` só destes arquivos.

---

### Task 1: Mesma rate no available_range

**Files:**
- Modify: `apps/cli/src/app/assembly/otio.ts` (`sourceDuration` / `externalReference`)
- Test: `apps/cli/src/app/assembly/otio.test.ts`

**Step 1: Teste que falha**

No final de `otio.test.ts`:

```ts
it("available_range do media_reference usa a mesma rate do source_range do clipe", () => {
  const a = fixtureAssembly();
  a.fps = { num: 30000, den: 1001 };
  a.sources[0]!.fps = { num: 25, den: 1 };
  a.sources[0]!.durationSeconds = 3;
  a.tracks[1]!.clips = [];
  a.tracks[2]!.clips[0]!.durationFrames = 10;
  a.tracks[0]!.clips[0]!.durationFrames = 10;
  const doc = JSON.parse(buildOtio(validateAssembly(a)));
  const clip = doc.tracks.children[0].children[0];
  const fps = 30000 / 1001;
  expect(clip.source_range.start_time.rate).toBe(fps);
  expect(clip.media_reference.available_range.duration.rate).toBe(fps);
  expect(clip.media_reference.available_range.duration.rate)
    .toBe(clip.source_range.duration.rate);
  expect(clip.media_reference.available_range.duration.value).toBe(Math.round(3 * fps));
  expect(clip.media_reference.available_range.start_time.rate).toBe(fps);
});
```

**Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/otio.test.ts -t "available_range"`

Expected: FAIL — `available_range.duration.rate` é 25, não `30000/1001`.

**Step 3: Harmonizar**

Em `otio.ts`, substituir `sourceDuration` / `sourceRate` / o `available_range` de `externalReference` por:

```ts
function mediaAvailableDuration(source: Source, fps: number): number {
  return Math.round(source.durationSeconds * fps);
}

function externalReference(source: Source, assembly: Assembly, fps: number) {
  const width = source.width ?? assembly.width;
  const height = source.height ?? assembly.height;
  return {
    OTIO_SCHEMA: "ExternalReference.1",
    name: source.id,
    target_url: pathToFileURL(source.path).href,
    // Mesma rate do source_range do clipe: rates mistos no mesmo arquivo
    // (timeline vs fonte) deslocam in-point em importadores C++.
    available_range: range(0, mediaAvailableDuration(source, fps), fps),
    available_image_bounds: imageBounds(width, height),
    metadata: {
      decupa: {
        sourceId: source.id,
        width,
        height,
        fps: source.fps,
      },
    },
  };
}
```

Apagar `sourceDuration` e `sourceRate` se ficarem sem uso.

**Step 4: Rodar otio.test.ts**

Run: `npx vitest run apps/cli/src/app/assembly/otio.test.ts`

Expected: PASS, inclusive o teste ICE-1 de `start_time` em frames.

**Step 5: Typecheck e commit**

Run: `pnpm run typecheck`

```bash
git add apps/cli/src/app/assembly/otio.ts apps/cli/src/app/assembly/otio.test.ts
git commit -m "fix: OTIO available_range uses timeline rate to match clip source_range"
```
