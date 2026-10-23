// Rastreio "assistido de verdade" (#103), separado de quem mostra a cobertura.
// Só conta a reprodução real da prévia atual, provada pelo played do player:
// a cobertura (playback.js) junta os trechos tocados; seek para a frente não
// entra, voltar zera, e trocar de src (Original ou revisão nova) recomeça do
// zero. Os listeners entram uma vez por <video>: o player é único e nunca sai
// do documento, então trocar de etapa ou repintar um painel não os repete nem
// zera a contagem. O resultado vai para o estado, e só de lá é lido:
// "watched" (`{revision, ended}`, o gate de watched.js) e "watchCoverage"
// (`{revision, covered, duration, complete, ratio, label}`, da prévia que está
// no player).
import { coverageComplete, coveredSeconds, newCoverage, playbackReading } from "./playback.js";
import { watchProgress } from "./progress.js";
import { watchedState } from "./watched.js";

/** Um rastreio por elemento: montar de novo devolve o mesmo, sem listener a mais. */
const rastreios = new WeakMap();

/**
 * Liga o rastreio ao player da prévia. `restart(at, source)` é para quem troca
 * o src (a revisão nova começa em `at` sem crédito); o loadstart cobre o resto.
 * @param {{ state: any, video: any }} deps
 * @returns {{ restart: (at: number, source: string | null) => void }}
 */
export function mountCobertura({ state, video }) {
  const existente = rastreios.get(video);
  if (existente) return existente;
  let coverage = newCoverage();

  function isPreviewSrc(project) {
    return !!project && project.previewRevision != null
      && video.getAttribute("data-rev") === String(project.previewRevision);
  }
  function markWatched() {
    const project = state.get("project");
    if (!isPreviewSrc(project)) return;
    state.set("watched", { revision: project.previewRevision, ended: true });
  }
  function resetWatched() {
    state.set("watched", { revision: null, ended: false });
  }
  function playedRanges() {
    const ranges = [];
    for (let i = 0; i < video.played.length; i++) {
      ranges.push([video.played.start(i), video.played.end(i)]);
    }
    return ranges;
  }

  /**
   * Publica a cobertura da prévia no player; só notifica quando algo muda.
   * `ratio` e `label` são o que o anel e os painéis mostram; `covered`,
   * `duration` e `complete` são os fatos brutos da mesma leitura.
   */
  function publish() {
    const project = state.get("project");
    const revision = coverage.source == null ? null : Number(coverage.source);
    const status = watchedState(project, state.get("watched"));
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const covered = coveredSeconds(coverage, video.duration);
    const watched = status.watched && revision === project?.previewRevision;
    const progress = watchProgress(covered, video.duration, watched);
    const complete = coverageComplete(coverage, video.duration);
    const previous = state.get("watchCoverage");
    if (previous?.revision === revision && previous?.ratio === progress.ratio && previous?.label === progress.label
      && previous?.covered === covered && previous?.complete === complete && previous?.duration === duration) return;
    state.set("watchCoverage", { revision, covered, duration, complete, ...progress });
  }

  /**
   * O assistido acompanha a cobertura contra a duração de agora: marca quando
   * cobre e revoga quando deixa de cobrir (metadados que mudam a duração).
   */
  function settleWatched(project) {
    const watched = state.get("watched");
    const marked = watched?.ended === true && watched.revision === project.previewRevision;
    const complete = coverageComplete(coverage, video.duration);
    if (complete && !marked) markWatched();
    else if (!complete && watched?.ended) resetWatched();
    publish();
  }
  /** Uma leitura do player; `seek` marca posição vinda de salto (seeking/seeked). */
  function readPlayback(seek) {
    const project = state.get("project");
    if (!Number.isFinite(video.currentTime) || !isPreviewSrc(project)) return;
    const reading = playbackReading(coverage, video.currentTime, {
      played: playedRanges(), rate: video.playbackRate, seek,
      source: video.getAttribute("data-rev"),
    });
    coverage = reading.coverage;
    if (reading.reset) resetWatched();
    settleWatched(project);
  }
  video.addEventListener("timeupdate", () => readPlayback(video.seeking));
  video.addEventListener("seeking", () => readPlayback(true));
  video.addEventListener("seeked", () => readPlayback(true));
  video.addEventListener("ended", () => readPlayback(false));
  // Fecha o trecho na velocidade antiga antes de a nova valer (sem retroagir).
  video.addEventListener("ratechange", () => readPlayback(false));
  const onDuration = () => {
    const project = state.get("project");
    if (isPreviewSrc(project)) settleWatched(project);
  };
  video.addEventListener("durationchange", onDuration);
  video.addEventListener("loadstart", () => {
    coverage = newCoverage(0, { source: video.getAttribute("data-rev") });
    resetWatched();
    publish();
  });
  video.addEventListener("loadedmetadata", onDuration);
  // Revisão nova ou assistido revogado mudam o rótulo, não a contagem.
  state.subscribe("project", publish);
  state.subscribe("watched", publish);

  const rastreio = {
    restart(at, source) {
      // A posição mantida na troca não foi tocada nesta prévia: a contagem recomeça.
      coverage = newCoverage(Number.isFinite(at) ? at : 0, { source });
      // Troca de src invalida o "assistido" (o loadstart cobre o resto).
      resetWatched();
      publish();
    },
  };
  rastreios.set(video, rastreio);
  return rastreio;
}
