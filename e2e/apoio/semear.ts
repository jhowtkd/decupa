// Semeia Raízes de Projetos sintéticas para os testes de navegador. Roda fora
// do runner, do mesmo jeito que o CLI (strip-types), e imprime um JSON em stdout.
//
//   node --experimental-strip-types e2e/apoio/semear.ts <base> jornada
//   node --experimental-strip-types e2e/apoio/semear.ts <base> extensa
//   node --experimental-strip-types e2e/apoio/semear.ts <base> fila <n>
//
// <base> é a pasta temporária do teste: a Raiz fica em <base>/raiz e a mídia
// sintética (FFmpeg lavfi) em <base>/midia. A transcrição é semeada porque a
// preparação real precisa dos modelos de fala, que não existem no CI.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { blankProject } from "../../apps/cli/src/app/assembly/routes.ts";
import { compileScenes, validateProposal } from "../../apps/cli/src/app/assembly/scenes.ts";
import { createProject } from "../../apps/cli/src/app/assembly/store.ts";
import type { Analysis, Project, Source } from "../../apps/cli/src/app/assembly/types.ts";
import { buildPeaks, peaksPath } from "../../apps/cli/src/app/assembly/waveform.ts";
import { SpawnExecutor } from "../../apps/cli/src/app/pipeline.ts";

const run = promisify(execFile);
const ff = (args: string[]) => run("ffmpeg", ["-v", "error", "-y", ...args], { maxBuffer: 1 << 20 });

export type Semeado = {
  raiz: string;
  projetos: { id: string; dir: string; nome: string }[];
  arquivos?: string[];
  alvo?: { frase: string; cena: string; total: number };
};

async function fonte(id: string, path: string, name: string, role: Source["role"]): Promise<Source> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
  const info = JSON.parse(stdout) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
  const video = info.streams.find((s) => s.codec_type === "video");
  const audio = info.streams.find((s) => s.codec_type === "audio");
  const { size, mtimeMs } = await stat(path);
  return {
    id, path, sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
    durationSeconds: Number(info.format.duration), hasVideo: Boolean(video), hasAudio: Boolean(audio),
    fps: video ? { num: 25, den: 1 } : null, width: video?.width ?? null, height: video?.height ?? null,
    role, included: true, name, size, mtimeMs, timecode: null, rotation: 0,
  };
}

type Fala = { sourceId: string; inicio: number; fim: number; texto: string };

/** Análise pronta com uma fala por trecho e palavras espaçadas por igual dentro dele. */
function analise(sourceId: string, falas: Fala[]): Analysis {
  return {
    sourceId, key: sourceId, status: "ready", wordsStatus: "ready", visual: [],
    visualCoverage: { requested: [], returned: [], missing: [] },
    speech: falas.map((f, i) => ({ id: `${sourceId}:s${i + 1}`, sourceId, start: f.inicio, end: f.fim, text: f.texto })),
    words: falas.flatMap((f, i) => {
      const lista = f.texto.split(" ");
      const passo = (f.fim - f.inicio) / lista.length;
      return lista.map((text, j) => ({
        id: `${sourceId}:w${i}-${String(j).padStart(4, "0")}`, sourceId, text,
        start: Number((f.inicio + j * passo).toFixed(3)),
        end: Number((f.inicio + j * passo + passo * 0.85).toFixed(3)),
        confidence: 0.95,
      }));
    }),
  } as Analysis;
}

/** Projeto com as cenas propostas e a montagem compilada, como depois da preparação. */
async function gravar(raiz: string, id: string, nome: string, sources: Source[], analyses: Analysis[],
  cenas: { id: string; speechIds: string[]; objective: string }[]): Promise<{ id: string; dir: string; nome: string }> {
  const dir = join(raiz, id);
  await mkdir(dir);
  const p: Project = blankProject(randomUUID(), nome);
  const video = sources.find((s) => s.hasVideo);
  p.assembly = { ...p.assembly, name: nome, width: video?.width ?? 1280, height: video?.height ?? 720,
    canvasSourceId: video?.id ?? sources[0]!.id, canvasManual: false, sources };
  p.analyses = analyses;
  if (cenas.length) {
    p.scenes = validateProposal({ id: "semente", baseRevision: p.revision, changedSceneIds: cenas.map((c) => c.id), scenes: cenas }, p).scenes;
    p.assembly = { ...compileScenes(p, p.scenes), revision: p.revision };
  }
  await createProject(dir, p);
  return { id, dir, nome };
}

const FALAS = [
  "Bom dia a todos e obrigado por virem até aqui hoje.",
  "Vamos falar sobre a cidade e o que muda no próximo ano.",
  "A equipe trabalhou muito para chegar neste resultado.",
  "Para fechar, quero agradecer a quem tornou isso possível.",
];
const DEPOIMENTO = "Eu moro aqui há vinte anos e nunca vi tanta gente nas ruas.";

/** Cinco cenas de duas Mídias (vídeo com fala e um depoimento só em áudio). */
async function jornada(base: string): Promise<Semeado> {
  const raiz = join(base, "raiz");
  const midia = join(base, "midia");
  await mkdir(raiz, { recursive: true });
  await mkdir(midia, { recursive: true });
  const a = join(midia, "entrevista.mp4");
  const b = join(midia, "depoimento.m4a");
  await ff(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25:duration=24",
    "-f", "lavfi", "-i", "aevalsrc=exprs='0.5*sin(2*PI*180*t)*abs(sin(2*PI*0.7*t))':s=48000:d=24",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", a]);
  await ff(["-f", "lavfi", "-i", "aevalsrc=exprs='0.4*sin(2*PI*260*t)*abs(sin(2*PI*1.1*t))':s=48000:d=8", "-c:a", "aac", b]);
  const sources = [await fonte("a", a, "entrevista.mp4", "speech"), await fonte("b", b, "depoimento.m4a", "speech")];
  const trechos: [number, number][] = [[0.2, 4.2], [5, 11.5], [12, 15.5], [16.5, 23.5]];
  const analyses = [
    analise("a", FALAS.map((texto, i) => ({ sourceId: "a", inicio: trechos[i]![0], fim: trechos[i]![1], texto }))),
    analise("b", [{ sourceId: "b", inicio: 0.3, fim: 7.5, texto: DEPOIMENTO }]),
  ];
  const projeto = await gravar(raiz, "entrevista-e2e", "Entrevista E2E", sources, analyses, [
    { id: "s1", speechIds: ["a:s1"], objective: "Abertura" },
    { id: "s2", speechIds: ["b:s1"], objective: "Depoimento" },
    { id: "s3", speechIds: ["a:s2"], objective: "Cidade" },
    { id: "s4", speechIds: ["a:s3"], objective: "Equipe" },
    { id: "s5", speechIds: ["a:s4"], objective: "Fechamento" },
  ]);
  const exec = new SpawnExecutor();
  for (const s of sources) {
    await buildPeaks(exec, { proxyPath: s.path, sha256: s.sha256, outPath: peaksPath(projeto.dir, s.sha256), durationSeconds: s.durationSeconds });
  }
  return { raiz, projetos: [projeto] };
}

const VOCABULARIO = ["então", "a", "gente", "começou", "gravação", "não", "é", "isso", "montagem", "ação",
  "você", "também", "porque", "assim", "cidade", "equipe", "praça", "ruas", "ano", "trabalho"];
export const EXTENSA = { midias: 20, palavrasPorMidia: 2000, falasPorMidia: 10, passo: 0.4 };

/**
 * Transcrição extensa: 20 Mídias só de áudio × 2 000 palavras (40 000 no
 * total) em 200 cenas. A frase-alvo aparece uma vez, na última cena, bem
 * longe da janela virtualizada do texto.
 */
async function extensa(base: string): Promise<Semeado> {
  const raiz = join(base, "raiz");
  const midia = join(base, "midia");
  await mkdir(raiz, { recursive: true });
  await mkdir(midia, { recursive: true });
  const { midias, palavrasPorMidia, falasPorMidia, passo } = EXTENSA;
  const duracao = palavrasPorMidia * passo;
  const semente = join(midia, "semente.m4a");
  await ff(["-f", "lavfi", "-i", "sine=frequency=200:sample_rate=16000:duration=60", "-ac", "1", "-c:a", "aac", "-b:a", "24k", semente]);
  const frase = "farol amarelo";
  const porFala = palavrasPorMidia / falasPorMidia;
  const sources: Source[] = [];
  const analyses: Analysis[] = [];
  const cenas: { id: string; speechIds: string[]; objective: string }[] = [];
  for (let m = 0; m < midias; m++) {
    const id = `m${String(m + 1).padStart(2, "0")}`;
    const path = join(midia, `${id}.m4a`);
    // Cópia em laço da semente: rápido e com bytes próprios (o comentário muda o sha256).
    await ff(["-stream_loop", "-1", "-i", semente, "-t", String(duracao), "-c", "copy", "-metadata", `comment=${id}`, path]);
    sources.push(await fonte(id, path, `${id}.m4a`, "speech"));
    const falas: Fala[] = [];
    for (let f = 0; f < falasPorMidia; f++) {
      const palavras: string[] = [];
      for (let w = 0; w < porFala; w++) palavras.push(VOCABULARIO[(m * 7 + f * 3 + w * 11) % VOCABULARIO.length]!);
      if (m === midias - 1 && f === falasPorMidia - 1) palavras.splice(porFala - 20, 2, ...frase.split(" "));
      falas.push({ sourceId: id, inicio: f * porFala * passo, fim: (f + 1) * porFala * passo - 0.1, texto: palavras.join(" ") });
      cenas.push({ id: `c${m * falasPorMidia + f + 1}`, speechIds: [`${id}:s${f + 1}`], objective: `Trecho ${m * falasPorMidia + f + 1}` });
    }
    analyses.push(analise(id, falas));
  }
  const projeto = await gravar(raiz, "arquivo-extenso-e2e", "Arquivo extenso", sources, analyses, cenas);
  return { raiz, projetos: [projeto], alvo: { frase, cena: cenas.at(-1)!.id, total: 1 } };
}

/** Projeto vazio e `n` Mídias curtas, distintas, para a fila de envio. */
async function fila(base: string, n: number): Promise<Semeado> {
  const raiz = join(base, "raiz");
  const pasta = join(base, "fila");
  await mkdir(raiz, { recursive: true });
  await mkdir(pasta, { recursive: true });
  const semente = join(pasta, ".semente.mp4");
  await ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=1",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", semente]);
  const arquivos: string[] = [];
  for (let i = 1; i <= n; i++) {
    const path = join(pasta, `toma-${String(i).padStart(2, "0")}.mp4`);
    await ff(["-i", semente, "-c", "copy", "-metadata", `comment=toma-${i}`, path]);
    arquivos.push(path);
  }
  const dir = join(raiz, "fila-e2e");
  await mkdir(dir);
  await createProject(dir, blankProject(randomUUID(), "Fila E2E"));
  return { raiz, projetos: [{ id: "fila-e2e", dir, nome: "Fila E2E" }], arquivos };
}

const [base, cenario, n] = process.argv.slice(2);
if (!base || !cenario) {
  console.error("uso: semear.ts <base> <jornada|extensa|fila> [n]");
  process.exit(2);
}
const semeado = cenario === "jornada" ? await jornada(base)
  : cenario === "extensa" ? await extensa(base)
  : cenario === "fila" ? await fila(base, Number(n ?? 20))
  : null;
if (!semeado) {
  console.error(`cenário desconhecido: ${cenario}`);
  process.exit(2);
}
process.stdout.write(`${JSON.stringify(semeado)}\n`);
