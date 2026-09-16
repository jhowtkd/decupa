#!/usr/bin/env node
// Smoke de strip-types: importa os pontos de entrada TS do mesmo jeito que o
// runtime (`node --experimental-strip-types`), sem vitest/esbuild no caminho.
// O vitest transpila de verdade e aceita construções que o strip-only recusa
// (enums, namespaces, parameter properties...), então sem isto o CI fica verde
// enquanto o CLI não sobe. Sai 1 na primeira entrada que não importar.
//
// A lista espelha apps/cli/src/strip-types.test.ts: `index.ts` importa
// `triage.ts` e `app/server.ts` de forma dinâmica, então checar só a entrada
// principal não guardaria nada. `scripts/assembly-proof.ts` fica de fora de
// propósito: importar aquele módulo EXECUTA a prova (precisa de motor+ffmpeg).
// Arquivos passados como argumento substituem a lista (útil para depurar).
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRIES = [
  "apps/cli/src/index.ts",
  "apps/cli/src/triage.ts",
  "apps/cli/src/app/server.ts",
];

function importUnderStripTypes(entry) {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(entry).href)});`,
      ],
      { env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    child.on("close", (code) => done({ code: code ?? 1, stderr }));
  });
}

const entries = process.argv.slice(2).length > 0
  ? process.argv.slice(2).map((a) => resolve(a))
  : ENTRIES.map((rel) => join(ROOT, rel));

let failed = false;
for (const entry of entries) {
  const { code, stderr } = await importUnderStripTypes(entry);
  const stripError = /not supported in strip-only mode/.test(stderr);
  if (code === 0 && !stripError) {
    console.log(`ok: ${entry} importa sob --experimental-strip-types`);
  } else {
    failed = true;
    console.error(`FALHA: ${entry} não importa sob --experimental-strip-types (código ${code})`);
    const detail = stderr.trim().split("\n").slice(0, 10).join("\n");
    if (detail) console.error(detail);
  }
}
process.exitCode = failed ? 1 : 0;
