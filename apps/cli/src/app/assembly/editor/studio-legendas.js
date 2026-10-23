// Legenda do studio (DECUPA_EDITOR_UI=studio). O <track> entra no
// #previewPlayer único e acompanha a revisão do vídeo carregado (data-rev),
// nunca a revisão atual: uma prévia antiga leva a legenda dela ou fica sem
// track, com o motivo na linha sob o monitor. O player não é recriado e o src
// não é tocado. A faixa recebe os cues da revisão atual pela chave
// "legendasFaixa" do estado. Tudo vem de GET project/subtitles, o mesmo
// gerador da exportação; nada aqui processa nem cobra.
import { projectHeaders, projectPath } from "../project-path.js";
// Texto (b) do plano: o monitor confere a legenda, o MP4 sai sem ela. A frase
// mora em rail.js, a mesma do diálogo de formato e da Entrega.
import { LEGENDA_FORA_DO_MP4 } from "./rail.js";

/**
 * O que muda a legenda sem mudar a revisão (pura): a correção que termina de
 * alinhar em segundo plano e a análise refeita de uma fonte (gravadas sem
 * subir a revisão) trocam as palavras na mesma revisão.
 */
export function assinaturaLegenda(project) {
  return project.revision + ":" + (project.corrections || []).map((item) => item.id + "=" + item.status).join(",")
    + "|" + (project.analyses || []).map((item) => item.sourceId + ":" + item.key + ":" + item.wordsStatus).join(",");
}

/** Motivo da entrega para revisão sem fala (o mesmo texto de subtitleRecord). */
const SEM_FALA = "sem falas retidas na montagem";

/**
 * Resposta de GET project/subtitles/<rev>/json → resultado (pura).
 * `pronto` traz vttSha e cues; `sem-fala` é a revisão sem fala retida (como
 * a entrega registra); `indisponivel` é o gerador que falhou, com o motivo;
 * `sem-revisao` é a revisão sem como gerar a legenda.
 */
export function resultadoDaResposta(status, body) {
  if (status === 200 && body?.legendas?.status === "pronto") {
    return { estado: "pronto", origem: body.origem, vttSha: body.legendas.vttSha, cues: Array.isArray(body.cues) ? body.cues : [] };
  }
  if (status === 200) {
    const motivo = body?.legendas?.motivo || SEM_FALA;
    return { estado: motivo === SEM_FALA ? "sem-fala" : "indisponivel", motivo, cues: [] };
  }
  if (status === 404) return { estado: "sem-revisao", motivo: body?.error || "legenda indisponível", cues: [] };
  return { estado: "erro", motivo: body?.error || "erro " + status, cues: [] };
}

/**
 * Linha sob o monitor (pura): de que revisão é a legenda do vídeo carregado,
 * ou por que ele está sem legenda. Sem prévia no player, some.
 */
export function linhaDoMonitor({ videoRev, atual, resultado }) {
  if (videoRev == null) return { hidden: true, tom: "", texto: "" };
  const v = "v" + videoRev;
  const exibida = videoRev !== atual ? " (prévia exibida)" : "";
  if (!resultado || resultado.estado === "carregando") return { hidden: false, tom: "carregando", texto: "Carregando a legenda da " + v + "…" };
  if (resultado.estado === "pronto") {
    return { hidden: false, tom: "pronto", texto: "Legenda da " + v + exibida + " no monitor. " + LEGENDA_FORA_DO_MP4 };
  }
  if (resultado.estado === "erro") {
    return { hidden: false, tom: "sem", texto: "Sem legenda no monitor: não foi possível carregar a legenda da " + v + "." };
  }
  return { hidden: false, tom: "sem", texto: "Sem legenda no monitor para a " + v + exibida + ": " + resultado.motivo + "." };
}

/** O <track> que este módulo pôs no player (só um por vez). */
function trackDo(el) {
  return el.querySelector("track[data-legenda]");
}

/**
 * Liga o track ao player e a faixa ao estado. `player.el()` é o
 * #previewPlayer único. Devolve `sincronizar` para quem precisa forçar.
 */
export function mountLegendas({ state, player, fetchFn = (url, init) => fetch(url, init) }) {
  // Por revisão: o pedido e, enquanto ela é a atual, a assinatura com que foi
  // feito. Revisão passada não muda mais: o que veio quando era atual vale.
  const cache = new Map();
  function buscar(revision) {
    const p = state.get("project");
    const atual = p && p.revision === revision ? assinaturaLegenda(p) : null;
    const hit = cache.get(revision);
    if (hit && (atual === null || hit.assinatura === atual)) return hit.pedido;
    const pedido = (async () => {
      try {
        const res = await fetchFn(projectPath("project/subtitles/" + revision + "/json"), { headers: projectHeaders() });
        const body = await res.json().catch(() => null);
        return resultadoDaResposta(res.status, body);
      } catch (err) {
        return { estado: "erro", motivo: (err && err.message) || String(err), cues: [] };
      }
    })();
    cache.set(revision, { assinatura: atual, pedido });
    // Erro de rede não fica guardado: o próximo aviso tenta de novo.
    void pedido.then((resultado) => { if (resultado.estado === "erro" && cache.get(revision)?.pedido === pedido) cache.delete(revision); });
    // Guarda poucas revisões: a atual, a da prévia e alguma recém-passada.
    while (cache.size > 6) cache.delete(cache.keys().next().value);
    return pedido;
  }

  const linha = () => document.getElementById("legendaMonitor");
  function pintar(view) {
    const el = linha();
    if (!el) return;
    el.hidden = view.hidden;
    el.dataset.tom = view.tom;
    el.textContent = view.texto;
  }

  /** Troca o track só quando a revisão ou o conteúdo mudam; nunca toca no src do vídeo. */
  function colocarTrack(el, alvo) {
    const atual = trackDo(el);
    if (atual && alvo && atual.dataset.legenda === String(alvo.revision) && atual.dataset.sha === alvo.vttSha) return;
    atual?.remove();
    if (!alvo) return;
    const track = document.createElement("track");
    track.setAttribute("kind", "subtitles");
    track.setAttribute("srclang", "pt-BR");
    track.setAttribute("label", "Legenda da v" + alvo.revision);
    track.setAttribute("default", "");
    track.dataset.legenda = String(alvo.revision);
    track.dataset.sha = alvo.vttSha;
    track.setAttribute("src", projectPath("project/subtitles/" + alvo.revision + "/vtt"));
    track.addEventListener("error", () => {
      if (trackDo(el) !== track) return;
      track.remove();
      pintar(linhaDoMonitor({ videoRev: alvo.revision, atual: state.get("project")?.revision, resultado: { estado: "erro" } }));
    });
    el.append(track);
    // O track recém-posto começa desligado: mostra (a pessoa ainda pode
    // desligar pelo botão de legendas do player).
    if (track.track) track.track.mode = "showing";
  }

  let vez = 0;
  async function sincronizar() {
    const el = player.el();
    const p = state.get("project");
    if (!el) return;
    const rev = el.getAttribute("data-rev");
    const videoRev = rev != null && /^\d+$/.test(rev) ? Number(rev) : null;
    const minha = ++vez;
    if (videoRev == null || !p) {
      colocarTrack(el, null);
      pintar(linhaDoMonitor({ videoRev: null }));
      return;
    }
    const posto = trackDo(el);
    if (!posto || posto.dataset.legenda !== String(videoRev)) {
      // Vídeo novo: a legenda do anterior sai já, antes da resposta.
      colocarTrack(el, null);
      pintar(linhaDoMonitor({ videoRev, atual: p.revision, resultado: { estado: "carregando" } }));
    }
    const resultado = await buscar(videoRev);
    if (minha !== vez) return;
    colocarTrack(el, resultado.estado === "pronto" ? { revision: videoRev, vttSha: resultado.vttSha } : null);
    pintar(linhaDoMonitor({ videoRev, atual: state.get("project")?.revision, resultado }));
  }

  let vezFaixa = 0;
  let ultimoDaFaixa;
  async function faixa(p) {
    const minha = ++vezFaixa;
    if (!p || !p.scenes?.length) {
      if (ultimoDaFaixa !== null) state.set("legendasFaixa", (ultimoDaFaixa = null));
      return;
    }
    const resultado = await buscar(p.revision);
    if (minha !== vezFaixa) return;
    const proximo = { revision: p.revision, ...resultado };
    if (JSON.stringify(proximo) === JSON.stringify(ultimoDaFaixa)) return;
    state.set("legendasFaixa", (ultimoDaFaixa = proximo));
  }

  // O vídeo muda por src novo (loadstart), src removido (emptied) ou só pelo
  // data-rev; o observador cobre o atributo onde o navegador o tem.
  const el = player.el();
  if (el) {
    el.addEventListener("loadstart", () => void sincronizar());
    el.addEventListener("emptied", () => void sincronizar());
    if (typeof MutationObserver === "function") {
      new MutationObserver(() => void sincronizar()).observe(el, { attributes: true, attributeFilter: ["data-rev"] });
    }
  }
  state.subscribe("project", (p) => {
    void faixa(p);
    void sincronizar();
  });
  void faixa(state.get("project"));
  void sincronizar();
  return { sincronizar };
}
