import type { SpeechIndex } from "./speech-index.ts";

/**
 * Muda sempre que o texto das instruções mudar — entra na chave de cache,
 * senão uma decisão velha sobreviveria a uma mudança de prompt.
 */
export const PROMPT_VERSION = "v2";

export const STRUCTURE_INSTRUCTIONS = `Você está vendo um vídeo de uma pessoa falando para a câmera, e a transcrição dele dividida em unidades numeradas.

Sua tarefa: identificar o que NÃO é o conteúdo do vídeo.

Categorias, e só elas:

- "preroll": o começo, antes do vídeo de fato começar. A pessoa falando com quem está operando a câmera, se preparando, pedindo desculpa, contando que vai começar. Vem sempre no início e é contíguo.
- "postroll": o mesmo no fim — comemorar que gravou, perguntar se ficou bom, falar com a sala.
- "aside": um comentário fora do assunto no meio do vídeo, dirigido a alguém presente e não a quem assiste.
- "restart_block": a pessoa tropeça e recomeça a mesma frase várias vezes, e mais adiante consegue dizê-la inteira. Reivindique as tentativas falhas e aponte em "restated_by" a unidade que diz a frase completa.
- "retake": a pessoa grava de novo a mesma frase, mesmo que seja uma unidade só. Reivindique a tentativa que sai e aponte em "restated_by" a que fica. Fica o take de depois, salvo se o de depois for pior (ar morto, visual ruim).
- "dead_air": unidade quase sem fala, só respiro ou espera — o índice já marca isso.
- "director_cue": fala com o operador no meio do vídeo. Pistas: "corta essa", "vou repetir", "calma aí", "perdão", "agora vai", "ih foi".

Regras:

- Você identifica unidades por "unit_ids" (ex: ["u001","u002"]). NUNCA devolva tempo, timestamp, MM:SS ou segundos — o tempo exato vem do índice, não de você.
- Se algo é o assunto do vídeo, deixe passar. Na dúvida, não reivindique.
- Cada alegação precisa ser contígua.
- Retake de uma unidade só: mesmo assim reivindique, com "restated_by".
- Em "note", uma frase curta em português dizendo por que aquilo não é o vídeo.
- Se nada se encaixar, devolva lista vazia.

O vídeo está junto para você ver o contexto — se a pessoa está olhando para a câmera ou para o lado, se está ajeitando alguma coisa, se aponta para algo na tela. Use isso para decidir, nunca para medir tempo.`;

export const INSPECT_INSTRUCTIONS = `Você está vendo 3 ou 4 fotogramas de UMA unidade de fala. A visão local ficou na faixa ambígua: não tem certeza se a pessoa olha para a câmera ou para o operador.

Julgue só estes fotogramas.

- "drop": está claramente olhando para o lado ou para baixo, ou falando com quem opera a câmera — não é conteúdo para quem assiste.
- "keep": está falando para a câmera.
- "unsure": não dá para decidir.

Regras:
- Nunca devolva tempo, timestamp, MM:SS ou segundos.
- "note" em português, uma frase curta.
- Não invente o que não aparece nos fotogramas.
- Responda JSON: {"unitId":"u0NN","decision":"drop|keep|unsure","note":"..."}.`;

/** Uma unidade por linha: id, começo, duração e texto. */
export function buildUnitsBlock(index: SpeechIndex): string {
  return index.units
    .map((u) => {
      const text = u.text.replace(/\s+/g, " ").trim();
      return `${u.id} | ${u.start.toFixed(1)}s +${u.duration.toFixed(1)}s | ${text}`;
    })
    .join("\n");
}
