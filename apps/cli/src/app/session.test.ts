import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimWorkDir,
  initialKeepList,
  keepPath,
  readKeepList,
  sourceManifestPath,
  sourceMismatch,
  writeKeepList,
} from "./session.ts";

describe("readKeepList", () => {
  it("devolve null quando não há sessão gravada", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-sess-"));
    expect(await readKeepList(dir)).toBeNull();
  });

  it("faz ida e volta da mesma string que o --keep consome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "decupa-sess-"));
    await writeKeepList(dir, "u001-u003 u005");
    expect(await readKeepList(dir)).toBe("u001-u003 u005");
  });

  it("trata arquivo em branco como ausência", async () => {
    // Um keep vazio não é "nada fica": é arquivo truncado. Devolvê-lo faria o
    // ingest planejar com --keep sem faixa nenhuma, e o motor estouraria numa
    // mensagem que não descreve o problema real.
    const dir = await mkdtemp(join(tmpdir(), "decupa-sess-"));
    await writeFile(keepPath(dir), "  \n", "utf8");
    expect(await readKeepList(dir)).toBeNull();
  });
});

describe("initialKeepList", () => {
  it("usa a sessão gravada quando ela existe", () => {
    expect(initialKeepList("u002-u003", ["u001", "u002", "u003"])).toBe("u002-u003");
  });

  it("sem sessão, começa com tudo, da primeira à última unidade", () => {
    expect(initialKeepList(null, ["u001", "u002", "u003"])).toBe("u001-u003");
  });

  it("estoura quando o índice não tem unidade nenhuma", () => {
    expect(() => initialKeepList(null, [])).toThrow(/unidade/);
  });

  it("índice vazio fala de português, não de rodar o condense.py", () => {
    expect(() => initialKeepList(null, [])).toThrow(/português/);
  });
});

// ---- mtime sozinho não é troca de vídeo (P2-1 da revisão) ----

const MIB = 1024 * 1024;

/** Vídeo de ~3 MiB com conteúdo aleatório, e a pasta de trabalho ao lado. */
async function fonteEPasta() {
  const dir = await mkdtemp(join(tmpdir(), "decupa-fonte-"));
  const input = join(dir, "v.mp4");
  const conteudo = randomBytes(3 * MIB);
  await writeFile(input, conteudo);
  return { dir, input, conteudo, workDir: join(dir, ".decupa-v.mp4") };
}

/** Só a data muda: cópia, sync de nuvem, `touch`. */
async function soMtime(input: string) {
  const antes = (await stat(input)).mtimeMs;
  const novo = new Date(antes + 60_000);
  await utimes(input, novo, novo);
  return novo.getTime();
}

async function lerManifesto(workDir: string) {
  return JSON.parse(await readFile(sourceManifestPath(workDir), "utf8")) as Record<string, unknown>;
}

describe("fonte com o mesmo conteúdo e outra data", () => {
  it("sourceMismatch devolve null e regrava o manifesto com o mtime novo", async () => {
    // Hoje só o utimes já dá 409 no meio da sessão e bloqueia o export.
    const { input, workDir } = await fonteEPasta();
    await claimWorkDir(workDir, input);
    const novoMtime = await soMtime(input);
    expect(await sourceMismatch(workDir, input)).toBeNull();
    expect((await lerManifesto(workDir)).mtimeMs).toBe((await stat(input)).mtimeMs);
    expect((await stat(input)).mtimeMs).toBeCloseTo(novoMtime, -1);
  });

  it("claimWorkDir não move a pasta e o keep.txt continua onde estava", async () => {
    // Hoje a pasta vai para .stale e a sessão (keep.txt, transcrição) se perde.
    const { input, workDir } = await fonteEPasta();
    await claimWorkDir(workDir, input);
    await writeFile(join(workDir, "keep.txt"), "u001-u003\n", "utf8");
    await soMtime(input);
    const resultado = await claimWorkDir(workDir, input);
    expect(resultado.staleDir).toBeUndefined();
    expect(await readFile(join(workDir, "keep.txt"), "utf8")).toBe("u001-u003\n");
    expect((await lerManifesto(workDir)).mtimeMs).toBe((await stat(input)).mtimeMs);
  });

  it("a primeira subida grava a amostra (sha256 hex) no source.json", async () => {
    const { input, workDir } = await fonteEPasta();
    await claimWorkDir(workDir, input);
    expect((await lerManifesto(workDir)).sample).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("fonte com o mesmo tamanho e conteúdo diferente", () => {
  it.each([
    ["primeiro MiB", 10],
    ["último MiB", 3 * MIB - 10],
  ])("byte trocado no %s continua sendo mismatch e a pasta vai para .stale", async (_nome, posicao) => {
    // Controle: a amostra não pode virar um "aceita tudo" quando só o mtime mudou.
    const { input, conteudo, workDir } = await fonteEPasta();
    await claimWorkDir(workDir, input);
    await writeFile(join(workDir, "keep.txt"), "u001\n", "utf8");
    const outro = Buffer.from(conteudo);
    outro[posicao] = outro[posicao]! ^ 0xff;
    await writeFile(input, outro);
    await soMtime(input);
    expect(await sourceMismatch(workDir, input)).toMatch(/mudou depois que o app abriu/);
    const resultado = await claimWorkDir(workDir, input);
    expect(resultado.staleDir).toBeDefined();
    await expect(readFile(join(workDir, "keep.txt"), "utf8")).rejects.toThrow();
    expect(await readFile(join(resultado.staleDir!, "keep.txt"), "utf8")).toBe("u001\n");
  });

  it("manifesto antigo, sem amostra, com mtime diferente continua mismatch", async () => {
    const { input, workDir } = await fonteEPasta();
    const { size, mtimeMs } = await stat(input);
    await mkdir(workDir, { recursive: true });
    await writeFile(sourceManifestPath(workDir), JSON.stringify({ path: input, size, mtimeMs: mtimeMs - 5_000 }), "utf8");
    expect(await sourceMismatch(workDir, input)).toMatch(/mudou depois que o app abriu/);
  });
});

describe("regravação do manifesto quando só a data mudou", () => {
  it("chamadas simultâneas de sourceMismatch não disputam o mesmo parcial", async () => {
    // Com parcial de nome fixo, duas regravações simultâneas se pisam e uma
    // rejeita com ENOENT no rename (no servidor, um 500). A corrida é
    // probabilística: por isso muitas rodadas com muitas chamadas cada.
    const { input, workDir } = await fonteEPasta();
    await claimWorkDir(workDir, input);
    const base = (await stat(input)).mtimeMs;
    for (let rodada = 1; rodada <= 20; rodada += 1) {
      const data = new Date(base + rodada * 60_000);
      await utimes(input, data, data);
      const resultados = await Promise.allSettled(
        Array.from({ length: 12 }, () => sourceMismatch(workDir, input)),
      );
      const rejeitadas = resultados.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason));
      expect(rejeitadas, `rodada ${rodada}`).toEqual([]);
      expect(resultados.map((r) => (r as PromiseFulfilledResult<string | null>).value), `rodada ${rodada}`)
        .toEqual(Array.from({ length: 12 }, () => null));
    }
    expect((await lerManifesto(workDir)).mtimeMs).toBe((await stat(input)).mtimeMs);
  }, 60_000);

  // root ignora chmod; no Windows o modo não impede a escrita.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "pasta somente leitura: a amostra bateu, então devolve null mesmo sem conseguir regravar",
    async () => {
      // A regravação do manifesto é melhor esforço: falhar em gravar não
      // pode transformar "o vídeo é o mesmo" em erro para quem pediu.
      const { input, workDir } = await fonteEPasta();
      await claimWorkDir(workDir, input);
      await soMtime(input);
      await chmod(workDir, 0o500);
      try {
        await expect(sourceMismatch(workDir, input)).resolves.toBeNull();
      } finally {
        await chmod(workDir, 0o700);
      }
    },
  );
});
