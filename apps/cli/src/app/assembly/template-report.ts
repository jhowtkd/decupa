/**
 * Relatório do template aplicado (#68): lê a receita e o resultado
 * gravados no aceite da proposta — nunca a versão viva da biblioteca.
 * Regras ativas mostram estado e motivo; associações com cenas são
 * navegáveis quando registradas e explicitamente indisponíveis quando
 * ausentes. Animações pendentes saem como handoff (destino Resolve/After
 * Effects), nunca como efeito produzido. Leitura pura — sem análise paga.
 */
import { buildHandoff, type HandoffItem } from "./handoff.ts";
import type { Project } from "./types.ts";

export type TemplateReportRule = {
  ruleId: string;
  category: string;
  instruction: string;
  status: "applied" | "adapted" | "unavailable";
  reason: string;
  /**
   * Cenas associadas registradas na proposta aceita (só as que ainda
   * existem); null quando a proposta não registrou associação.
   */
  sceneIds: string[] | null;
};

export type TemplateReportView = {
  /** Receita+revisão congeladas no aceite. */
  recipe: { id: string; revision: number; name: string } | null;
  rules: TemplateReportRule[];
  /** Handoff de animação pendente (destino, janela), nunca efeito pronto. */
  animations: HandoffItem[];
};

export function buildTemplateReport(project: Project): TemplateReportView {
  const recipe = project.template ?? null;
  if (!recipe) return { recipe: null, rules: [], animations: [] };
  const existing = new Set(project.scenes.map((scene) => scene.id));
  const entries = new Map((project.templateReport ?? []).map((entry) => [entry.ruleId, entry]));
  const rules = recipe.rules
    .filter((rule) => rule.enabled)
    .map((rule): TemplateReportRule => {
      const entry = entries.get(rule.id);
      const sceneIds = entry?.sceneIds?.filter((id) => existing.has(id)) ?? [];
      return {
        ruleId: rule.id,
        category: rule.category,
        instruction: rule.instruction,
        status: entry?.status ?? "unavailable",
        reason: entry?.reason ?? "sem resultado registrado na proposta aceita",
        sceneIds: sceneIds.length ? sceneIds : null,
      };
    });
  let animations: HandoffItem[] = [];
  try {
    animations = buildHandoff(project);
  } catch {
    // Cena com nota de animação sem clipes: o handoff fica vazio em vez
    // de derrubar o relatório inteiro.
    animations = [];
  }
  return {
    recipe: { id: recipe.id, revision: recipe.revision, name: recipe.name },
    rules,
    animations,
  };
}
