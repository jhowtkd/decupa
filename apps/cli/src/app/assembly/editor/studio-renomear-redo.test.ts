import { expect, it } from "vitest";
import { efeitosDeRenomear } from "./studio-renomear.js";

const projeto = { revision: 4, finalApprovedRevision: null, previewRevision: null } as never;
const AVISO = "O que foi desfeito deixa de poder ser refeito.";

it("com redoRevision o aviso do renomear diz que o desfeito não poderá ser refeito, no fim", () => {
  const efeitos = efeitosDeRenomear(projeto, 3, 5);
  expect(efeitos.at(-1)).toBe(AVISO);
});

it("sem redoRevision (omitido ou null) o aviso não aparece e o resto não muda", () => {
  const base = efeitosDeRenomear(projeto, 3);
  expect({
    omitido: base.includes(AVISO),
    nulo: efeitosDeRenomear(projeto, 3, null).includes(AVISO),
    comRedo: efeitosDeRenomear(projeto, 3, 5).slice(0, -1),
  }).toEqual({ omitido: false, nulo: false, comRedo: base });
});
