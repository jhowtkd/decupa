import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { energyEnvelope, snapCut, type EnergyEnvelope } from "@decupa/acoustics";
import type { Executor } from "../pipeline.ts";
import type { Project, SpeechTake } from "./types.ts";
import { createFillerIndex, fillerTakeKey, fillerTargetKey, type FillerIndex } from "./filler-index.ts";
import { fillerCutResult, fillerReport, fillerSignature, fillerSelectionSignature, fillerSnapKey, cutFillerOccurrence, type FillerOccurrence, type FillerSnaps, type FillerTarget } from "./fillers.ts";

export type FillerSnapDeps = { exec: Executor; signal?: AbortSignal; cache?: FillerSnaps };

async function takePcm(project: Project, take: SpeechTake, deps: FillerSnapDeps): Promise<Int16Array> {
  const source = project.assembly.sources.find(s => s.id === take.sourceId);
  if (!source?.hasAudio) throw Error("fonte sem áudio");
  const dir = await mkdtemp(join(tmpdir(), "decupa-fillers-"));
  try {
    const output = join(dir, "take.pcm");
    const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const result = await deps.exec.run({ command: "ffmpeg", signal, args: [
      "-v", "error", "-ss", String(take.start), "-i", source.path, "-t", String(take.end - take.start),
      "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-y", output,
    ] });
    signal.throwIfAborted();
    if (result.code !== 0) throw Error("falha na leitura acústica");
    const bytes = await readFile(output);
    if (!bytes.length || bytes.length % 2) throw Error("PCM inválido");
    const pcm = new Int16Array(bytes.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
    return pcm;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** O snap procura energia só na folga de 50–80 ms de cada borda. */
function snapRange(take: SpeechTake, item: FillerOccurrence, envelope: EnergyEnvelope, index: FillerIndex) {
  const { words, positions } = index.source(take.sourceId);
  const first = positions.get(item.candidate.wordIds[0]!)!, last = positions.get(item.candidate.wordIds.at(-1)!)!;
  const before = words[first - 1], after = words[last + 1];
  const prev = before && before.end > take.start ? before : undefined, next = after && after.start < take.end ? after : undefined;
  const startLo = prev ? Math.max(take.start, prev.end + 0.05) : take.start;
  const startHi = prev ? Math.min(item.candidate.start, prev.end + 0.08) : take.start;
  const endLo = next ? Math.max(item.candidate.end, next.start - 0.08) : take.end;
  const endHi = next ? Math.min(take.end, next.start - 0.05) : take.end;
  if (startLo > startHi + 1e-9 || endLo > endHi + 1e-9 || startLo >= endHi) return "fronteira sem corredor livre";
  const boundary = (lo: number, hi: number) => {
    const target = (lo + hi) / 2;
    const result = snapCut({ envelope, targetMs: (target - take.start) * 1000, windowMs: Math.max(0, hi - lo) * 500 });
    return Math.max(lo, Math.min(hi, result.ms / 1000 + take.start));
  };
  return { start: boundary(startLo, Math.max(startLo, startHi)), end: boundary(Math.min(endLo, endHi), endHi) };
}

/** Nenhuma leitura de áudio fica dentro do escritor de project.json. */
export async function planFillerSnaps(project: Project, targets: FillerTarget[], deps: FillerSnapDeps): Promise<FillerSnaps> {
  if (!targets.length) return {};
  const index = createFillerIndex(project), snaps: FillerSnaps = {}, envelopeByTake = new Map<string, Promise<EnergyEnvelope>>();
  const occurrences = new Map(fillerReport(project, {}, { targets, index }).occurrences.map(o => [fillerTargetKey(o), o]));
  let planned = project;
  for (const target of targets) {
    deps.signal?.throwIfAborted();
    const item = occurrences.get(fillerTargetKey(target));
    if (!item) continue;
    const take = planned.scenes.find(s => s.id === item.sceneId)!.takes.find(t => t.id === item.takeId)!;
    const key = fillerSnapKey(item), signature = fillerSignature(project, take, index), selection = fillerSelectionSignature(planned, take);
    const abstain = (reason: string) => { snaps[key] = { signature, selection, abstain: true, reason }; };
    if (item.state !== "signal" && item.state !== "kept") { abstain(item.reason ?? "candidato indisponível para corte"); continue; }
    const cached = deps.cache?.[key];
    if (cached && !cached.transient && cached.signature === signature && cached.selection === selection) {
      snaps[key] = cached;
      planned = cutFillerOccurrence(planned, item, cached, "user", index);
      continue;
    }
    if (!index.sources.get(take.sourceId)?.hasAudio) { abstain("fonte sem áudio"); continue; }
    const takeKey = fillerTakeKey(item.sceneId, item.takeId);
    try {
      let pending = envelopeByTake.get(takeKey);
      if (!pending) { pending = takePcm(project, take, deps).then(pcm => energyEnvelope(pcm)); envelopeByTake.set(takeKey, pending); }
      const range = snapRange(take, item, await pending, index);
      if (typeof range === "string") { abstain(range); continue; }
      const result = fillerCutResult(planned, take, item.candidate, range, index);
      if (typeof result === "string") { abstain(result); continue; }
      snaps[key] = { signature, selection, range };
      planned = cutFillerOccurrence(planned, item, snaps[key], "user", index);
    } catch (error) {
      deps.signal?.throwIfAborted();
      // Falha de leitura não é evidência acústica: um novo GET permite tentar de novo.
      snaps[key] = { signature, selection, transient: true, abstain: true, reason: error instanceof Error && error.name === "TimeoutError" ? "leitura acústica excedeu 30 segundos; tente novamente" : "não foi possível conferir o áudio; tente novamente" };
    }
  }
  return snaps;
}
