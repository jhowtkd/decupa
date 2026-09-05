import type { Verdict } from "./claims.ts";
import type { InspectFlag } from "./inspect.ts";
import type { DensityCandidate, InspectVerdict } from "./model.ts";

export interface ReportInput {
  keepList: string;
  model: string;
  verdicts: Verdict[];
  density: {
    budgetSeconds: number;
    applied: DensityCandidate[];
    skipped: { candidate: DensityCandidate; why: string }[];
  } | null;
  reviewFlags?: InspectFlag[];
  inspect?: InspectVerdict[];
}

function formatApplied(v: Verdict): string {
  const c = v.claim;
  if (c.restated_by && (c.reason === "retake" || c.reason === "restart_block")) {
    return `- fica **${c.restated_by}** · sai **${c.unit_ids.join(", ")}** — \`${c.reason}\` — ${c.note}`;
  }
  return `- **${c.unit_ids.join(", ")}** — \`${c.reason}\` — ${c.note}`;
}

function sourceSection(
  title: string,
  source: Verdict["claim"]["source"],
  verdicts: Verdict[],
): string[] {
  const of = verdicts.filter((v) => (v.claim.source ?? "model") === source);
  const accepted = of.filter((v) => v.accepted);
  const rejected = of.filter((v) => !v.accepted);
  const lines: string[] = [`## ${title}`, ""];
  if (of.length === 0) {
    lines.push("Nada neste passe.", "");
    return lines;
  }
  if (accepted.length > 0) {
    lines.push("### Aplicado", "");
    for (const v of accepted) lines.push(formatApplied(v));
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
  return lines;
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = ["# Triagem", "", `- modelo: ${input.model}`, `- keep-list: \`${input.keepList}\``, ""];

  if (input.verdicts.length === 0) {
    lines.push("O modelo não reivindicou nada. Tudo foi mantido.", "");
  }

  lines.push(...sourceSection("Mecânico", "mechanical", input.verdicts));
  lines.push(...sourceSection("Modelo", "model", input.verdicts));

  lines.push("## Visual", "");
  const visualVerdicts = input.verdicts.filter((v) => v.claim.source === "visual");
  const inspect = input.inspect ?? [];
  if (visualVerdicts.length === 0 && inspect.length === 0) {
    lines.push("Nada neste passe.", "");
  } else {
    if (visualVerdicts.some((v) => v.accepted)) {
      lines.push("### Aplicado", "");
      for (const v of visualVerdicts.filter((x) => x.accepted)) lines.push(formatApplied(v));
      lines.push("");
    }
    if (visualVerdicts.some((v) => !v.accepted)) {
      lines.push("### Rejeitado (alegação não conferiu com o índice)", "");
      for (const v of visualVerdicts) {
        if (v.accepted) continue;
        lines.push(`- **${v.claim.unit_ids.join(", ")}** — \`${v.claim.reason}\` — ${v.claim.note}`);
        lines.push(`  - falhou: ${v.failed}`);
      }
      lines.push("");
    }
    if (inspect.length > 0) {
      lines.push("### Inspect", "");
      for (const v of inspect) {
        lines.push(`- **${v.unitId}** — \`${v.decision}\` — ${v.note}`);
      }
      lines.push("");
    }
  }

  lines.push("## Para revisão", "");
  const flags = input.reviewFlags ?? [];
  if (flags.length === 0) {
    lines.push("Nada para revisar.", "");
  } else {
    for (const f of flags) {
      lines.push(`- **${f.unitId}** — \`${f.code}\` (${f.source}) — ${f.message}`);
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
