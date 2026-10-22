// Apoio dos testes HTTP da alternância legacy/studio. Não é suíte: o nome não casa com o include do vitest.
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blankProject } from "./assembly/routes.ts";
import { fixtureAssembly } from "./assembly/fixture.ts";
import { createProject } from "./assembly/store.ts";
import type { Project } from "./assembly/types.ts";

export type Variante = "legacy" | "studio";
export const VARIANTES: Variante[] = ["legacy", "studio"];
export const executor = { async run() { return { code: 0, stdout: "", stderr: "" }; } };

export const envDe = (variante: Variante): Record<string, string> =>
  variante === "studio" ? { DECUPA_EDITOR_UI: "studio" } : {};

/** Raiz com o Projeto `alpha`: uma cena, um take com palavras e um corte já existente. */
export async function seedRaiz(): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "editor-ui-http-"));
  const dir = join(root, "alpha");
  await mkdir(dir);
  const projeto: Project = blankProject("alpha-project");
  projeto.assembly.sources.push({ ...fixtureAssembly().sources[0]!, id: "src1", durationSeconds: 10 });
  projeto.analyses.push({
    sourceId: "src1",
    key: "k",
    speech: [{ id: "src1:u001", sourceId: "src1", start: 0, end: 2, text: "fala um" }],
    visual: [],
    status: "ready",
    words: [
      { id: "w1", sourceId: "src1", start: 0, end: 1, text: "fala", confidence: 0.9 },
      { id: "w2", sourceId: "src1", start: 1, end: 2, text: "um", confidence: 0.9 },
    ],
    wordsStatus: "ready",
    visualCoverage: { requested: [], returned: [], missing: [] },
  });
  projeto.scenes.push({
    id: "s1",
    objective: "abrir",
    rationale: "tema",
    speechIds: ["src1:u001"],
    takes: [{
      id: "t1", sourceId: "src1", speechId: "src1:u001",
      start: 0, end: 2, removed: [{ start: 0, end: 0.5 }], protected: [],
    }],
    visualEvidenceIds: [],
    support: [],
    gaps: [],
  });
  await createProject(dir, projeto);
  return { root, dir };
}
