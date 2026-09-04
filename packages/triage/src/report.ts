import type { DensityCandidate } from "./model.ts";
import type { Verdict } from "./claims.ts";

export interface ReportInput {
  keepList: string;
  model: string;
  verdicts: Verdict[];
  density: {
    budgetSeconds: number;
    applied: DensityCandidate[];
    skipped: { candidate: DensityCandidate; why: string }[];
  } | null;
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = ["# Triagem", "", `- modelo: ${input.model}`, `- keep-list: \`${input.keepList}\``, ""];

  const accepted = input.verdicts.filter((v) => v.accepted);
  const rejected = input.verdicts.filter((v) => !v.accepted);

  lines.push("## Passe 1 — estrutura", "");
  if (input.verdicts.length === 0) {
    lines.push("O modelo não reivindicou nada. Tudo foi mantido.", "");
  }
  if (accepted.length > 0) {
    lines.push("### Aplicado", "");
    for (const v of accepted) {
      lines.push(`- **${v.claim.unit_ids.join(", ")}** — \`${v.claim.reason}\` — ${v.claim.note}`);
    }
    lines.push("");
  }
  if (rejected.length > 0) {
    lines.push("### Rejeitado (alegação não conferiu com o índice)", "");
    for (const v of rejected) {
      if (v.accepted) continue;
      lines.push(`- **${v.claim.unit_ids.join(", ")}** — \`${v.claim.reason}\` — ${v.claim.note}`);
      lines.push(`  - falhou: ${v.failed}`);
    }
    lines.push("");
  }

  lines.push("## Passe 2 — densidade", "");
  if (!input.density) {
    lines.push("Não rodou: sem --target, então não havia condição de parada.", "");
  } else {
    lines.push(`Orçamento: ${input.density.budgetSeconds.toFixed(1)}s`, "");
    for (const c of input.density.applied) {
      lines.push(`- **${c.unit_ids.join(", ")}** (rank ${c.rank}) — ${c.note}`);
    }
    for (const s of input.density.skipped) {
      lines.push(`- ~~${s.candidate.unit_ids.join(", ")}~~ pulado: ${s.why}`);
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "A verificação rejeita alegação impossível. Ela **não** certifica alegação",
    "correta — a regra de pré-rolo aceitaria um trecho maior que engolisse o",
    "gancho do vídeo. Leia o `condense_script.md` inteiro antes de renderizar.",
    "",
  );

  return lines.join("\n");
}
