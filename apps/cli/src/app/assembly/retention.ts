import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** Revisões não protegidas mantidas por padrão (além da atual e das exportadas). */
export const DEFAULT_KEPT_REVISIONS = 3;

export type RetentionOptions = {
  /** Quantas das revisões mais recentes manter (além das protegidas). Padrão: 3. */
  revisions?: number;
};

export type PruneResult = {
  /** Caminhos relativos podados, ex. `rev-1`, `history/rev-1.json`. */
  deleted: string[];
};

const REV_DIR = /^rev-(\d+)$/;
const REV_HISTORY = /^rev-(\d+)\.json$/;
const EXPORTED = /^\d+$/;

function motivo(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inteiro(valor: unknown): number | null {
  return typeof valor === "number" && Number.isInteger(valor) && valor >= 0 ? valor : null;
}

async function ehDiretorioReal(path: string): Promise<boolean> {
  // lstat nunca segue symlink: link simbólico não é diretório real.
  const st = await lstat(path).catch(() => null);
  return st !== null && st.isDirectory() && !st.isSymbolicLink();
}

async function ehArquivoReal(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  return st !== null && st.isFile() && !st.isSymbolicLink();
}

/**
 * Poda derivados antigos do projeto (`rev-N/`, `history/rev-N.json`).
 *
 * Mantém sempre: a revisão atual (`project.json`), revisões com diretório
 * em `exports/`, e as referenciadas por `previewArtifact`/`previewRevision`/
 * `finalApprovedRevision`. Das demais, mantém as `K` mais recentes.
 *
 * Segurança: só remove nomes casando exatamente `rev-<int>` (diretórios,
 * nunca symlinks) na raiz e `rev-<int>.json` (arquivos) em `history/`;
 * nunca toca `project.json`, `imports/`, `media/`, `analysis/` ou `exports/`.
 * Best-effort: falha de um delete não aborta os outros; havendo falhas, o
 * erro final (em pt-BR) lista cada uma.
 */
export async function pruneProject(
  dir: string,
  keep: RetentionOptions = {},
): Promise<PruneResult> {
  const k = keep.revisions ?? DEFAULT_KEPT_REVISIONS;

  if (!Number.isSafeInteger(k) || k < 0) throw new Error("retenção: revisions deve ser inteiro não negativo");
  for (const path of [dir, join(dir, "history"), join(dir, "exports")]) {
    const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (st && (!st.isDirectory() || st.isSymbolicLink())) {
      throw new Error(`retenção: diretório inválido ou simbólico: ${path}; nada foi podado`);
    }
  }

  let bruto: string;
  try {
    bruto = await readFile(join(dir, "project.json"), "utf8");
  } catch {
    throw new Error(`retenção: project.json ausente ou ilegível em ${dir}; nada foi podado`);
  }
  let projeto: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(bruto);
    if (typeof parsed !== "object" || parsed === null) throw new Error("inválido");
    projeto = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`retenção: project.json inválido em ${dir}; nada foi podado`);
  }
  const atual = inteiro(projeto["revision"]);
  if (atual === null) {
    throw new Error(`retenção: project.json sem revisão atual em ${dir}; nada foi podado`);
  }
  const protegidas = new Set<number>([atual]);
  for (const campo of ["previewRevision", "finalApprovedRevision"] as const) {
    const n = inteiro(projeto[campo]);
    if (n !== null) protegidas.add(n);
  }
  const artefato = projeto["previewArtifact"];
  if (typeof artefato === "object" && artefato !== null) {
    const n = inteiro((artefato as Record<string, unknown>)["revision"]);
    if (n !== null) protegidas.add(n);
  }

  // Revisões entregues: só contam diretórios reais em exports/ (nunca symlink).
  const exportadas = new Set<number>();
  const entradasExports = await readdir(join(dir, "exports")).catch(() => null);
  if (entradasExports !== null) {
    for (const nome of entradasExports) {
      if (!EXPORTED.test(nome)) continue;
      if (await ehDiretorioReal(join(dir, "exports", nome))) {
        exportadas.add(Number(nome));
      }
    }
  }

  // Revisões presentes: diretórios reais rev-<int> na raiz + history/rev-<int>.json.
  const entradasRaiz = await readdir(dir).catch(() => {
    throw new Error(`retenção: não foi possível listar ${dir}; nada foi podado`);
  });
  const dirsRev = new Map<number, string>();
  for (const nome of entradasRaiz) {
    const m = REV_DIR.exec(nome);
    if (!m) continue;
    if (await ehDiretorioReal(join(dir, nome))) {
      dirsRev.set(Number(m[1]), nome);
    }
  }
  const entradasHistory = await readdir(join(dir, "history")).catch(() => null);
  const arquivosHistory = new Map<number, string>();
  if (entradasHistory !== null) {
    for (const nome of entradasHistory) {
      const m = REV_HISTORY.exec(nome);
      if (!m) continue;
      if (await ehArquivoReal(join(dir, "history", nome))) {
        arquivosHistory.set(Number(m[1]), nome);
      }
    }
  }

  // K mais recentes (por número de revisão) + protegidas + exportadas.
  const conhecidas = new Set<number>([...dirsRev.keys(), ...arquivosHistory.keys()]);
  const recentes = [...conhecidas].sort((a, b) => b - a).slice(0, Math.max(0, k));
  const manter = new Set<number>([...protegidas, ...exportadas, ...recentes]);

  const alvos: string[] = [];
  for (const [n, nome] of [...dirsRev.entries()].sort((a, b) => a[0] - b[0])) {
    if (!manter.has(n)) alvos.push(nome);
  }
  for (const [n, nome] of [...arquivosHistory.entries()].sort((a, b) => a[0] - b[0])) {
    if (!manter.has(n)) alvos.push(`history/${nome}`);
  }

  const deleted: string[] = [];
  const falhas: string[] = [];
  for (const relativo of alvos) {
    try {
      // Revalida na hora de deletar: se virou symlink no meio do caminho, pula.
      const st = await lstat(join(dir, relativo)).catch(() => null);
      if (st === null || st.isSymbolicLink()) continue;
      await rm(join(dir, relativo), { recursive: true, force: true });
      deleted.push(relativo);
    } catch (err) {
      falhas.push(`${relativo}: ${motivo(err)}`);
    }
  }
  if (falhas.length > 0) {
    throw new Error(`falha ao podar derivados do projeto: ${falhas.join("; ")}`);
  }
  return { deleted };
}
