import { describe, expect, it } from "vitest";
import { applyCanvasPolicy, canvasForSource, displaySize, principalVideoSource } from "./canvas.ts";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import type { Source } from "./types.ts";

function source(over: Partial<Source>): Source {
  return { ...fixtureAssembly().sources[0]!, id: over.id ?? "x", ...over };
}

function projectWith(sources: Source[], canvas: Record<string, unknown> = {}) {
  const p = blankProject("p1");
  return { ...p, assembly: { ...p.assembly, sources, ...canvas } };
}

describe("displaySize — orientação considera rotação e dimensões de exibição", () => {
  it("rotação 90/270 troca largura e altura", () => {
    const base = { hasVideo: true, width: 1920, height: 1080 };
    expect(displaySize({ ...base, rotation: 0 })).toEqual({ width: 1920, height: 1080 });
    expect(displaySize({ ...base, rotation: 90 })).toEqual({ width: 1080, height: 1920 });
    expect(displaySize({ ...base, rotation: -90 })).toEqual({ width: 1080, height: 1920 });
    expect(displaySize({ ...base, rotation: 270 })).toEqual({ width: 1080, height: 1920 });
    expect(displaySize({ ...base, rotation: 180 })).toEqual({ width: 1920, height: 1080 });
  });

  it("sem vídeo ou dimensão devolve null", () => {
    expect(displaySize({ hasVideo: false, width: 1920, height: 1080 })).toBeNull();
    expect(displaySize({ hasVideo: true, width: null, height: 1080 })).toBeNull();
  });
});

describe("principalVideoSource — fonte principal do formato", () => {
  it("primeira de fala com vídeo vence apoio importado antes", () => {
    const apoio = source({ id: "b", role: "support", hasAudio: false });
    const fala = source({ id: "a", role: "speech", hasAudio: true });
    expect(principalVideoSource([apoio, fala])?.id).toBe("a");
    expect(principalVideoSource([fala, apoio])?.id).toBe("a");
  });

  it("sem fala, a primeira com vídeo vence", () => {
    const audio = source({ id: "au", hasVideo: false, hasAudio: true });
    const v1 = source({ id: "v1", hasVideo: true, role: "support", hasAudio: false });
    const v2 = source({ id: "v2", hasVideo: true, role: "support", hasAudio: false });
    expect(principalVideoSource([audio, v1, v2])?.id).toBe("v1");
    expect(principalVideoSource([audio])).toBeNull();
  });
});

describe("applyCanvasPolicy — formato só muda enquanto não escolhido", () => {
  const fala1080 = source({ id: "a", role: "speech", hasAudio: true, width: 1920, height: 1080, fps: { num: 30000, den: 1001 } });
  const vertical = source({ id: "v", role: "support", hasAudio: false, width: 1080, height: 1920, fps: { num: 25, den: 1 }, rotation: 0 });

  it("projeto novo adota a primeira fonte de fala com vídeo", () => {
    const next = applyCanvasPolicy(projectWith([source({ id: "b", role: "support", hasAudio: false, width: 640, height: 360 }), fala1080]));
    expect(next.assembly.width).toBe(1920);
    expect(next.assembly.height).toBe(1080);
    expect(next.assembly.fps).toEqual({ num: 30000, den: 1001 });
    expect(next.assembly.canvasSourceId).toBe("a");
    expect(next.assembly.canvasManual).toBe(false);
  });

  it("rotação da fonte principal produz canvas vertical", () => {
    const phone = source({ id: "p", role: "speech", hasVideo: true, width: 1920, height: 1080, rotation: 90 });
    const next = applyCanvasPolicy(projectWith([phone]));
    expect(next.assembly.width).toBe(1080);
    expect(next.assembly.height).toBe(1920);
    expect(next.assembly.canvasSourceId).toBe("p");
  });

  it("mistos depois da escolha não redimensionam silenciosamente", () => {
    const chosen = applyCanvasPolicy(projectWith([fala1080]));
    const next = applyCanvasPolicy({
      ...chosen,
      assembly: { ...chosen.assembly, sources: [fala1080, vertical] },
    });
    expect(next.assembly.width).toBe(1920);
    expect(next.assembly.height).toBe(1080);
  });

  it("escolha manual segura o formato mesmo com fonte principal nova", () => {
    const chosen = applyCanvasPolicy(projectWith([vertical]));
    const manual = {
      ...chosen,
      assembly: { ...chosen.assembly, canvasManual: true },
    };
    const next = applyCanvasPolicy({
      ...manual,
      assembly: { ...manual.assembly, sources: [vertical, fala1080] },
    });
    expect(next.assembly.width).toBe(1080);
    expect(next.assembly.height).toBe(1920);
  });

  it("sem fonte de vídeo o canvas mantém o padrão", () => {
    const audio = source({ id: "au", hasVideo: false });
    const next = applyCanvasPolicy(projectWith([audio]));
    expect(next.assembly.canvasSourceId).toBeUndefined();
    expect(next.assembly.width).toBe(320);
  });
});

describe("canvasForSource", () => {
  it("cai no fallback por dimensão quando a fonte tem ímpar", () => {
    const src = source({ id: "s", width: 1919, height: 1080, fps: { num: 25, den: 1 } });
    const canvas = canvasForSource(src, { width: 320, height: 240, fps: { num: 30, den: 1 } });
    expect(canvas).toEqual({ width: 320, height: 1080, fps: { num: 25, den: 1 } });
  });
});
