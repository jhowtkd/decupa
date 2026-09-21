import { createLimitedQueue } from "@decupa/queue";

/**
 * Orçamento único de mídia do servidor: um trabalho pesado por vez (proxy,
 * miniatura, prova de hardware ou render). Fila não reentrante — nunca
 * enfileirar um trabalho que aguarde outro trabalho desta mesma fila.
 */
export const mediaWork = createLimitedQueue(1);
