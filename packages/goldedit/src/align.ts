import { mergeIntervals, type Interval } from "@decupa/core";
import { DEFAULT_SAMPLE_RATE, readPcm } from "@decupa/media";
import { ncc } from "./ncc.ts";

export interface AlignOptions {
  raw: Int16Array;
  edited: Int16Array;
  sampleRate?: number;
  /** Tamanho da janela de casamento. 200 ms é o valor calibrado. */
  windowMs?: number;
  /** Passo entre janelas. Deve dividir windowMs para o viés ficar exato. */
  hopMs?: number;
  /** Até onde procurar à frente do cursor. Limita o custo em arquivos longos. */
  maxLookaheadMs?: number;
  /** Lacunas menores que isto são ruído de alinhamento, não corte. */
  minGapMs?: number;
  /** Passo da busca grosseira, em amostras. Menor = mais lento e mais preciso. */
  searchStepSamples?: number;
}

/**
 * Deriva os intervalos que foram removidos do bruto para produzir o editado.
 *
 * Percorre o editado em janelas, casando cada uma contra o bruto por NCC, com
 * um cursor que só anda para frente. Quando o melhor casamento pula à frente do
 * cursor, o pulo é um trecho removido.
 *
 * O ponto detectado fica atrasado em exatamente metade da janela — a última
 * janela que ainda casa é a que *começa* antes do corte. Daí a correção
 * `+windowMs/2`, verificada empiricamente: com ela o erro é 0 ms em fixture
 * sintético para windowMs de 200, 300 e 400.
 */
export function alignEdited(opts: AlignOptions): Interval[] {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const windowMs = opts.windowMs ?? 200;
  const hopMs = opts.hopMs ?? 50;
  const maxLookaheadMs = opts.maxLookaheadMs ?? 30_000;
  const minGapMs = opts.minGapMs ?? 120;
  const searchStep = opts.searchStepSamples ?? 8;

  const { raw, edited } = opts;
  const window = Math.round((windowMs * sampleRate) / 1000);
  const hop = Math.round((hopMs * sampleRate) / 1000);
  const lookahead = Math.round((maxLookaheadMs * sampleRate) / 1000);
  const biasCorrectionMs = Math.round(windowMs / 2);
  const toMs = (samples: number) => Math.round((samples * 1000) / sampleRate);

  const gaps: Interval[] = [];
  let cursor = 0;

  for (let editedStart = 0; editedStart + window <= edited.length; editedStart += hop) {
    const searchEnd = Math.min(cursor + lookahead, raw.length - window);
    if (searchEnd < cursor) break;

    let best = cursor;
    let bestScore = -2;

    for (let offset = cursor; offset <= searchEnd; offset += searchStep) {
      const score = ncc(edited, editedStart, raw, offset, window);
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }

    // Refino fino em torno do melhor candidato grosseiro.
    const refineLo = Math.max(cursor, best - searchStep);
    const refineHi = Math.min(searchEnd, best + searchStep);
    for (let offset = refineLo; offset <= refineHi; offset++) {
      const score = ncc(edited, editedStart, raw, offset, window);
      if (score > bestScore) {
        bestScore = score;
        best = offset;
      }
    }

    if (best > cursor) {
      gaps.push({
        startMs: toMs(cursor) + biasCorrectionMs,
        endMs: toMs(best) + biasCorrectionMs,
      });
    }
    cursor = best + hop;
  }

  return mergeIntervals(gaps, hopMs).filter(
    (gap) => gap.endMs - gap.startMs >= minGapMs,
  );
}

/** Mesma coisa, lendo os dois arquivos do disco. É o que a CLI usa. */
export async function alignEditedFiles(
  opts: { rawPath: string; editedPath: string } & Omit<AlignOptions, "raw" | "edited">,
): Promise<Interval[]> {
  const { rawPath, editedPath, ...rest } = opts;
  const sampleRate = rest.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const [raw, edited] = await Promise.all([
    readPcm({ input: rawPath, sampleRate }),
    readPcm({ input: editedPath, sampleRate }),
  ]);
  return alignEdited({ raw, edited, ...rest });
}
