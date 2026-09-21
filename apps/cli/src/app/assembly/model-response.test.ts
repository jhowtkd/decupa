import { expect, it } from "vitest";
import { parseModelJson } from "./model-response.ts";

it("extrai um objeto com cercas ou prosa sem alterar strings", () => {
  expect(parseModelJson('Segue:\n```json\n{"text":"chave { preservada }"}\n```\nExplicação.')).toEqual({ text: "chave { preservada }" });
});

it("não escolhe entre objetos ambíguos nem inventa reparos em JSON inválido", () => {
  for (const text of ['{"a":1}\n{"b":2}', '{"text":"aspas " erradas"}', 'sem JSON', '{"a":1']) {
    expect(() => parseModelJson(text)).toThrow();
  }
});
