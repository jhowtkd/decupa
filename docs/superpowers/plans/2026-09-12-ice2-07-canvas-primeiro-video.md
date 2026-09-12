# ICE-2 #07 — Canvas a partir do primeiro vídeo

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** O quadro/fps da montagem vêm do primeiro arquivo **com vídeo**, mesmo que um áudio já esteja cadastrado. Vídeo seguinte não sobrescreve.

**Architecture:** `applyCanvasFrom` retorna cedo se `sources.length > 0`. Áudio-primeiro trava 320×240@25. Exportar a função e testá-la pura. `addSource` já a chama — não mudar `addSource`.

**Tech Stack:** TypeScript, vitest. Sem HTTP.

**Base:** `403bcf8`. **Donos:** `routes.ts` **somente** `applyCanvasFrom` (exportar + condição), testes novos no final de `routes.test.ts`.

## Global Constraints

- **Não** editar `publishCorrection`, `alignCorrectionJob`, nem o handler `GET /project` (plano 02).
- Sem dependência nova. `git add` só destes arquivos.

---

### Task 1: Primeiro hasVideo define o canvas

**Files:**
- Modify: `apps/cli/src/app/assembly/routes.ts:325-333` (exportar `applyCanvasFrom`)
- Test: `apps/cli/src/app/assembly/routes.test.ts`

**Step 1: Escrever o teste que falha**

No import de `./routes.ts` em `routes.test.ts`, acrescente `applyCanvasFrom`. No final:

```ts
it("canvas vem do primeiro vídeo mesmo com áudio já cadastrado", () => {
  const audio: import("./types.ts").Source = {
    ...fixtureAssembly().sources[0]!,
    id: "wav",
    hasVideo: false,
    hasAudio: true,
    width: null,
    height: null,
    fps: null,
    role: "speech",
  };
  const video: import("./types.ts").Source = {
    ...fixtureAssembly().sources[0]!,
    id: "cam",
    hasVideo: true,
    hasAudio: true,
    width: 1920,
    height: 1080,
    fps: { num: 30000, den: 1001 },
    role: "speech",
  };
  let p = blankProject("p1");
  expect(p.assembly.width).toBe(320);
  p = {
    ...p,
    assembly: { ...p.assembly, sources: [audio] },
  };
  const afterAudio = applyCanvasFrom(p, audio);
  expect(afterAudio.assembly.width).toBe(320);
  const afterVideo = applyCanvasFrom(afterAudio, video);
  expect(afterVideo.assembly.width).toBe(1920);
  expect(afterVideo.assembly.height).toBe(1080);
  expect(afterVideo.assembly.fps).toEqual({ num: 30000, den: 1001 });
  const second = { ...video, id: "cam2", width: 640, height: 360, fps: { num: 25, den: 1 } };
  const afterSecond = applyCanvasFrom({
    ...afterVideo,
    assembly: { ...afterVideo.assembly, sources: [audio, video] },
  }, second);
  expect(afterSecond.assembly.width).toBe(1920);
  expect(afterSecond.assembly.fps).toEqual({ num: 30000, den: 1001 });
});
```

Prefira `import type { Source } from "./types.ts"` no topo em vez do import inline.

**Step 2: Rodar e ver falhar**

Run: `npx vitest run apps/cli/src/app/assembly/routes.test.ts -t "canvas vem do primeiro vídeo"`

Expected: FAIL — `applyCanvasFrom` não exportada, ou width continua 320.

**Step 3: Corrigir só applyCanvasFrom**

Trocar a função (exportar) por:

```ts
export function applyCanvasFrom(project: Project, source: Source): Project {
  if (!source.hasVideo) return project;
  const alreadyHasVideo = project.assembly.sources.some((item) => item.hasVideo);
  if (alreadyHasVideo) return project;
  const fps: Rate = source.fps ?? project.assembly.fps;
  const width = source.width && source.width % 2 === 0 ? source.width : project.assembly.width;
  const height = source.height && source.height % 2 === 0 ? source.height : project.assembly.height;
  return {
    ...project,
    assembly: { ...project.assembly, fps, width, height },
  };
}
```

Nada mais neste arquivo.

**Step 4: Rodar routes.test.ts**

Run: `npx vitest run apps/cli/src/app/assembly/routes.test.ts`

Expected: PASS.

**Step 5: Typecheck e commit**

Run: `pnpm run typecheck`

```bash
git add apps/cli/src/app/assembly/routes.ts apps/cli/src/app/assembly/routes.test.ts
git commit -m "fix: set assembly canvas from the first video source, not the first file"
```
