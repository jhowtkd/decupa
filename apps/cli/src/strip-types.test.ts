import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Toda entrada que o CLI pode alcançar. `index.ts` importa `triage.ts` e
 * `app/server.ts` de forma **dinâmica**, para que quem não usa triagem não
 * precise do `@google/genai` instalado — então importar só `index.ts` não
 * carrega nenhum dos dois, e uma guarda que testasse apenas a entrada não
 * guardaria nada.
 */
const ENTRIES = [
  join(HERE, "index.ts"),
  join(HERE, "triage.ts"),
  join(HERE, "app", "server.ts"),
];

function importUnderStripTypes(entry: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "-e", `await import(${JSON.stringify(pathToFileURL(entry).href)});`,
    ], { env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

/**
 * O `pnpm decupa` roda com `node --experimental-strip-types`, que é
 * strip-only: ele apaga anotações de tipo e nada mais. Construções que exigem
 * gerar código — parameter properties (`constructor(private x: T)`), enums,
 * namespaces, decorators — fazem o import morrer.
 *
 * O vitest transpila com esbuild, que aceita todas elas. Sem este teste, a
 * suíte inteira fica verde enquanto o CLI não sobe — foi exatamente o que
 * aconteceu em 2026-09-04: 295 testes passando e `decupa limpar` morrendo no
 * import com "TypeScript parameter property is not supported in strip-only
 * mode".
 */
describe("compatibilidade com strip-only mode", () => {
  it.each(ENTRIES)("%s importa sob --experimental-strip-types", async (entry) => {
    const { code, stderr } = await importUnderStripTypes(entry);
    expect(stderr).not.toMatch(/not supported in strip-only mode/);
    expect(code, stderr).toBe(0);
  }, 30_000);
});
