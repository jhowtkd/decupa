import {
  authorizesCut,
  type TypeSafeQuestion,
  type TypeSafeRequest,
  type TypeSafeResult,
} from "@decupa/typesafe";
import type { EditCatalog } from "./catalog.ts";
import type { FastDecision } from "./routing.ts";

export type TypeSafeDecideClient = {
  decide(req: TypeSafeRequest): Promise<TypeSafeResult>;
};

export async function decideWithTypeSafe(
  catalog: EditCatalog,
  client: TypeSafeDecideClient,
): Promise<FastDecision> {
  const questions: Record<string, TypeSafeQuestion> = {};
  for (const candidate of catalog.candidates) {
    if (candidate.protected) continue;
    if (candidate.questionGroup === "protect" || candidate.questionGroup === "boundary") continue;
    questions[candidate.id] = {
      type: "noul",
      instructions: `Apply edit ${candidate.kind} to ${candidate.unitIds.join(",")}`,
    };
  }
  if (Object.keys(questions).length === 0) return { applyIds: [] };

  const result = await client.decide({
    state: { candidateIds: catalog.candidates.map((c) => c.id) },
    questions,
  });

  const applyIds: string[] = [];
  for (const [id, answer] of Object.entries(result.answers)) {
    if (answer.type === "noul" && authorizesCut(answer.noul)) applyIds.push(id);
  }
  return { applyIds };
}
