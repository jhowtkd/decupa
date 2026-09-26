import type { Project, Rate, Source } from "./types.ts";

/**
 * Tamanho de exibição da fonte: a rotação embutida (90/270°) troca
 * largura e altura — o formato segue como a mídia aparece, não os
 * quadros gravados.
 */
export function displaySize(source: Pick<Source, "hasVideo" | "width" | "height" | "rotation">): { width: number; height: number } | null {
  if (!source.hasVideo || !source.width || !source.height) return null;
  const quarterTurn = (((source.rotation ?? 0) % 180) + 360) % 180 !== 0;
  return quarterTurn
    ? { width: source.height, height: source.width }
    : { width: source.width, height: source.height };
}

/**
 * Fonte principal do formato: a primeira de fala com vídeo; quando não
 * há fala, a primeira com vídeo. Nenhuma com vídeo → null.
 */
export function principalVideoSource(sources: Source[]): Source | null {
  return sources.find((s) => s.role === "speech" && s.hasVideo)
    ?? sources.find((s) => s.hasVideo)
    ?? null;
}

/** Canvas sugerido por uma fonte: dimensões de exibição pares + taxa dela. */
export function canvasForSource(
  source: Source,
  fallback: { width: number; height: number; fps: Rate },
): { width: number; height: number; fps: Rate } {
  const size = displaySize(source);
  return {
    width: size && size.width % 2 === 0 ? size.width : fallback.width,
    height: size && size.height % 2 === 0 ? size.height : fallback.height,
    fps: source.fps ?? fallback.fps,
  };
}

/**
 * Política de formato: enquanto nenhuma escolha está registrada
 * (`canvasSourceId` indefinido e `canvasManual` falso), a fonte
 * principal com vídeo define o canvas. Depois disso o formato só muda
 * por ação explícita — materiais mistos nunca redimensionam a timeline
 * sozinhos.
 */
export function applyCanvasPolicy(project: Project): Project {
  const assembly = project.assembly;
  if (assembly.canvasSourceId !== undefined || assembly.canvasManual) return project;
  const principal = principalVideoSource(assembly.sources);
  if (!principal) return project;
  const canvas = canvasForSource(principal, assembly);
  return {
    ...project,
    assembly: {
      ...assembly,
      ...canvas,
      canvasSourceId: principal.id,
      canvasManual: false,
    },
  };
}
