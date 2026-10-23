// Fixtures comuns: pasta temporária própria do teste (apagada no fim, mesmo
// quando ele falha), semeadura fora do runner e servidores encerrados no fim.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test as base } from "@playwright/test";
import { REPO, Servidor, type OpcoesServidor } from "./servidor.ts";
import type { Semeado } from "./semear.ts";

const run = promisify(execFile);

/** Onde ficam as Raízes do E2E. Localmente pode apontar para um tmpfs (DECUPA_E2E_TMP). */
export const RAIZ_TEMPORARIA = process.env.DECUPA_E2E_TMP || tmpdir();

type Fixtures = {
  /** Pasta exclusiva do teste. */
  base: string;
  semear: (cenario: "jornada" | "extensa" | "fila", n?: number) => Promise<Semeado>;
  servidor: (opcoes: Omit<OpcoesServidor, "base">) => Promise<Servidor>;
};

export const test = base.extend<Fixtures>({
  // oxlint-disable-next-line no-empty-pattern -- o Playwright exige desestruturação no primeiro argumento da fixture.
  base: async ({}, use) => {
    const pasta = await mkdtemp(join(RAIZ_TEMPORARIA, "decupa-e2e-"));
    try {
      await use(pasta);
    } finally {
      await rm(pasta, { recursive: true, force: true });
    }
  },
  semear: async ({ base: pasta }, use) => {
    await use(async (cenario, n) => {
      const args = ["--experimental-strip-types", "--no-warnings", join(REPO, "e2e/apoio/semear.ts"), join(pasta, cenario), cenario];
      if (n !== undefined) args.push(String(n));
      const { stdout } = await run(process.execPath, args, { cwd: pasta, maxBuffer: 1 << 24 });
      return JSON.parse(stdout) as Semeado;
    });
  },
  servidor: async ({ base: pasta }, use, testInfo) => {
    const servidores: Servidor[] = [];
    try {
      await use(async (opcoes) => {
        const servidor = new Servidor({ ...opcoes, base: pasta });
        servidores.push(servidor);
        await servidor.subir();
        return servidor;
      });
    } finally {
      await Promise.allSettled(servidores.map((s) => s.parar()));
      if (testInfo.status !== testInfo.expectedStatus) {
        for (const [i, s] of servidores.entries()) {
          await testInfo.attach(`servidor-${i + 1}.log`, { body: s.log(), contentType: "text/plain" });
        }
      }
    }
  },
});

export { expect } from "@playwright/test";
