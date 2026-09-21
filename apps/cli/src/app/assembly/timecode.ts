import type { Rate, Source, SourceTimecode } from "./types.ts";

// "HH:MM:SS:FF" ou "HH:MM:SS;FF" (drop-frame NTSC). Aceita H com 1-2 dígitos
// e frame com 1-2 dígitos — câmeras reais gravam ambos os formatos.
const TIMECODE = /^(\d{1,2}):(\d{1,2}):(\d{1,2})([:;])(\d{1,2})$/;

/**
 * Taxa nominal do timecode: a de câmera usada na contagem de rótulos
 * (29.97 conta como 30, 59.94 como 60). Drop-frame só existe nessas taxas.
 */
export function nominalRate(rate: Rate | null): number | null {
  if (!rate) return null;
  const fps = rate.num / rate.den;
  for (const nominal of [30, 60]) {
    // tolera ±0,1%: 30000/1001 → 29.97… ≈ 30
    if (Math.abs(fps - nominal) / nominal < 0.0011) return nominal;
  }
  return Math.round(fps);
}

/**
 * Converte uma etiqueta HH:MM:SS:FF / HH:MM:SS;FF em quadros decorridos
 * desde 00:00 na taxa da fonte. Retorna `frames: null` para etiqueta
 * ilegível ou inválida — nunca inventa valor.
 *
 * Drop-frame (não drop de 30/60): os rótulos 0 e 1 (×2 por 60 fps) de cada
 * minuto não múltiplo de 10 não existem na contagem; a fórmula desconta
 * esses rótulos para devolver quadros reais decorridos.
 */
export function parseSourceTimecode(raw: string, rate: Rate | null): SourceTimecode {
  const dropFrame = raw.includes(";");
  const match = TIMECODE.exec(raw.trim());
  if (!match) return { raw, frames: null, dropFrame };
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const frames = Number(match[5]);
  const nominal = nominalRate(rate);
  if (hours > 23 || minutes > 59 || seconds > 59 || nominal == null || !rate || frames >= nominal) {
    return { raw, frames: null, dropFrame };
  }
  if (dropFrame) {
    const fps = rate.num / rate.den;
    // Drop-frame só é definido em taxas NTSC fracionárias (≈nominal*1000/1001).
    const isNtsc = nominal % 30 === 0 && Math.abs(fps * 1001 / 1000 - nominal) / nominal < 0.001;
    const droppedPerMinute = nominal / 30 * 2;
    const totalMinutes = hours * 60 + minutes;
    // Rótulos pulados existem só no segundo 0 de minuto não-múltiplo de 10;
    // `00:01:01;01` é válido, `00:01:00;01` não.
    if (!isNtsc || (minutes % 10 !== 0 && seconds === 0 && frames < droppedPerMinute)) {
      return { raw, frames: null, dropFrame };
    }
    // O rótulo conta quadros na taxa nominal; saltar 2 rótulos por minuto
    // não-múltiplo-de-10 aproxima a contagem dos quadros reais decorridos.
    const real =
      (totalMinutes * 60 + seconds) * nominal + frames
      - droppedPerMinute * (totalMinutes - Math.floor(totalMinutes / 10));
    return { raw, frames: real, dropFrame };
  }
  // Não-drop: o rótulo conta quadros reais na taxa nominal, um a um.
  return {
    raw,
    frames: (hours * 3600 + minutes * 60 + seconds) * nominal + frames,
    dropFrame,
  };
}

/**
 * Quadros do início da mídia (timecode ou 0). Em segundos — os escritores
 * OTIO convertem para a taxa da timeline preservando o instante exato.
 */
export function sourceMediaStartSeconds(
  source: Pick<Source, "fps"> & { timecode?: SourceTimecode | null },
): number | null {
  const timecode = source.timecode;
  if (!timecode || timecode.frames == null || !source.fps) return null;
  return timecode.frames / (source.fps.num / source.fps.den);
}
