# Análise visual mais rápida Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduzir o tempo da análise visual com descrições compactas e evidência mensurável, preservando a qualidade do catálogo de b-roll.

**Architecture:** Instrumentar o fluxo existente; manter amostragem de produção a 1 fps e normalizar respostas compactas para os intervalos consumidos pelo editor. Identificar caches pelo modelo/perfil reais. Avaliar amostragem adaptativa, duas passagens e raciocínio reduzido somente num piloto isolado; promover apenas mudanças que cumpram o aceite.

**Tech Stack:** TypeScript, FFmpeg existente, Vitest, cliente OpenAI-compatible já instalado, arquivos JSON locais.

**Spec:** `docs/superpowers/specs/2026-09-21-analise-visual-rapida.md`

## Global Constraints

- Sem dependências novas e sem novas chamadas pagas durante implementação/testes automatizados.
- Não mudar resolução de frames, concorrência, montagem, renderização ou qualidade da exportação.
- Não tratar uma imagem isolada como prova de continuidade visual entre amostras.
- Preservar mídia, análises existentes, referências de apoio e alterações manuais.
- Experimentos pagos usam somente cópia isolada e autorização aplicável ao material e provedor.
- Redução de amostragem e duas passagens só podem virar padrão após avaliação de qualidade e plano específico de integração.

## Review Focus

- Janelas com contexto e duração fracionária: converter tempo local uma vez, sem inventar frame final; teste Task 2.
- Ação breve em cena estática: resumo não pode apagar a ação nem promover confiança; testes Task 2 e corpus Task 4.
- Fonte both ou papel alterado: amostragem esparsa não pode abastecer catálogo observado de b-roll; Task 4.
- Cancelamento/retry: tempos e tentativas precisam refletir falhas sem publicar resultado parcial obsoleto; Task 1.
- Modelo/perfil trocado e cenas com apoio manual: cache isolado e IDs anteriores preservados; Task 3.

---

## Mapa de arquivos e escopo

Modificar `apps/cli/src/app/assembly/model.ts` (describeSource, prompt, cache e normalização), `frames.ts` (propagação de sinal), `server.ts` (metadados do cliente visual), `packages/triage/src/analysis-client.ts` apenas se necessário expor configuração já resolvida sem segredos. Preferir reutilizar `analysisClientOptions` existente. Não alterar API pública de projeto.

Estender testes existentes `model.test.ts`, `frames.test.ts`, `broll.test.ts`, `preparation.test.ts`. Criar `scripts/visual-analysis-proof.ts` para o ensaio isolado e `scripts/visual-analysis-proof.test.ts` para a seleção determinística de amostras. Evidência em `docs/superpowers/evidence/2026-09-21-analise-visual-rapida.md`.

Preservar WIP: registrar status/diff antes de executar. Não commitá-lo junto com o trabalho. Só fazer commits dos hunks da tarefa. Todos os comandos abaixo partem da raiz do repo.

### Task 1: Medir o fluxo sem mudar a análise

**Files:** Modify `apps/cli/src/app/assembly/model.ts`, `apps/cli/src/app/assembly/frames.ts`; Test `apps/cli/src/app/assembly/model.test.ts`, `apps/cli/src/app/assembly/frames.test.ts`.

**Interfaces:** Adicionar export `VisualMetric` e opções `DescribeDeps.onMetric?: (metric: VisualMetric) => void`, `DescribeDeps.now?: () => number`. Preservar retorno `Promise<VisualSpan[]>`. `extractVisualFrames` recebe quinto argumento opcional `{signal?: AbortSignal}` e passa signal para exec.run.

```ts
export type VisualMetric = {
  sourceId: string; windowStart: number; windowEnd: number;
  phase: "extract" | "request" | "total";
  outcome: "ok" | "error" | "cancelled" | "cache-hit";
  elapsedMs: number; queueMs: number; frames: number; attempt: number;
};
```

- [ ] **Step 1: Escrever teste de telemetria.** Usar fixtures/exec fake já existentes em model.test.ts; callback coleta eventos, contador fake now avança no send. Verificar chamadas e cache:

```ts
const events: VisualMetric[] = [];
const onMetric = (event: VisualMetric) => events.push(event);
// Passar onMetric e now: () => clock no DescribeDeps das duas execuções da fixture.
expect(events.some(e => e.phase === "request" && e.attempt === 1)).toBe(true);
expect(events.at(-1)?.outcome).toBe("cache-hit");
expect(JSON.stringify(events)).not.toContain("data:image");
expect(events.every(e => e.elapsedMs >= 0 && e.queueMs >= 0)).toBe(true);
```

Adicionar casos usando o send fake existente: erro de transporte termina com evento error; AbortController termina cancelled; JSON inválido seguido de JSON válido gera duas tentativas. Não afirmar contagem HTTP a partir de send: retries internos do transporte são outra camada e devem ser medidos no piloto por fetchImpl.
- [ ] **Step 2: Executar RED.** `pnpm vitest run apps/cli/src/app/assembly/model.test.ts apps/cli/src/app/assembly/frames.test.ts --exclude '**/.muse/**'`. Esperado: falta de eventos/propagação do signal.
- [ ] **Step 3: Instrumentar no ponto certo.** Usar `performance.now` por padrão; capturar horário antes de entrar na pool e dentro do callback. Total da janela no finally; não somar tempos de janelas paralelas como wall time. Exemplo do bloco de request:

```ts
const queued = now();
const text = await pool.request(async () => {
  const started = now();
  const attempt = ++attempts;
  try {
    const response = await client.send(content, requestSignal);
    emit({phase:"request", outcome:"ok", elapsedMs:now()-started,
      queueMs:started-queued, attempt});
    return response;
  } catch (error) {
    emit({phase:"request", outcome:requestSignal?.aborted ? "cancelled" : "error",
      elapsedMs:now()-started, queueMs:started-queued, attempt});
    throw error;
  }
}, {signal: requestSignal});
```

`emit` é closure local que completa sourceId/windowStart/windowEnd/frames, chama onMetric dentro de try/catch e não deixa falha de observabilidade derrubar análise. `attempts` começa em zero por janela; `now = deps?.now ?? (() => performance.now())`. Extração usa mesma medição de fila e execução. Propagar signal também ao FFmpeg. Guardar isCurrent e throwIfAborted antes de escrita.
- [ ] **Step 4: Rodar GREEN.** Comandos do Step 2 e `pnpm typecheck`. Esperado: sucesso, nenhum acesso externo.
- [ ] **Step 5: Commit dos hunks.** `git commit -m "perf: measure visual analysis phases and cancellation"` após staging somente dos arquivos desta tarefa.

### Task 2: Descrições compactas sem perder granularidade do catálogo

**Files:** Modify `apps/cli/src/app/assembly/model.ts`; Test `apps/cli/src/app/assembly/model.test.ts`, `apps/cli/src/app/assembly/broll.test.ts`.

**Interfaces:** `DescribeDeps.profile?: "baseline" | "compact"`, default baseline até aceite. Export `normalizeCompactSpans(spans: VisualSpan[]): VisualSpan[]` após validação de limites/conflitos e conversão local→fonte. IDs definidos por parseLocalSpans somente após normalização. Não mudar o tipo VisualSpan nem consumidor HTTP.

- [ ] **Step 1: Testar intervalos e candidatos internos.** Acrescentar à fixture visual existente:

```ts
const span = {id:"old",sourceId:"s",start:19,end:22.4,text:"Público na feira",
  confidence:"observed" as const,tags:["público"]};
expect(normalizeCompactSpans([span]).map(s => [s.start,s.end]))
  .toEqual([[19,20],[20,21],[21,22],[22,22.4]]);
expect(normalizeCompactSpans([{...span,confidence:"uncertain"}])
  .every(s => s.confidence === "uncertain")).toBe(true);
```

Na fixture broll.test.ts, fornecer os spans normalizados observados de 0–10s e verificar candidato iniciando em 6s; uncertain/unavailable não produzem candidato. No teste de describeSource simular uma ação distinta 4–5s e verificar seu texto preservado entre trechos estáticos. Lacuna na resposta deve permanecer lacuna, nunca ser preenchida pelo normalizador.
- [ ] **Step 2: Executar RED.** `pnpm vitest run apps/cli/src/app/assembly/model.test.ts apps/cli/src/app/assembly/broll.test.ts --exclude '**/.muse/**'`.
- [ ] **Step 3: Implementar normalização e prompt opt-in.**

```ts
export function normalizeCompactSpans(spans: VisualSpan[]): VisualSpan[] {
  return spans.flatMap(span => {
    const cells: VisualSpan[] = [];
    for (let start = span.start; start < span.end;) {
      const end = Math.min(span.end, Math.floor(start) + 1);
      cells.push({...span, start, end});
      start = end;
    }
    return cells;
  });
}
```

Executar somente depois de validateVisual (números finitos e duração positiva). Prompt compact substitui a exigência de descrição por segundo por: “Agrupe intervalos consecutivos quando as imagens amostradas mostram o mesmo conteúdo. Use uma descrição curta por intervalo, sem repetir cenário. Preserve mudanças de ação, enquadramento e incerteza. Não preencha segundos sem evidência; não presuma continuidade de uma ação entre frames. Retorne spans com início/fim locais.” Manter todos os frames atuais a 1 fps e mesmas janelas. Não aplicar mergeAdjacent ao retorno compact após normalização: isso uniria novamente os candidatos internos. Manter comportamento baseline intacto enquanto comparação está pendente.
- [ ] **Step 4: Rodar GREEN e regressão de preparação.** Comandos do Step 2 mais `pnpm vitest run apps/cli/src/app/assembly/preparation.test.ts --exclude '**/.muse/**'`. Verificar janela com fetchStart 19, início 20 e fim 20.4; somente trecho solicitado publicado, sem dupla soma da origem.
- [ ] **Step 5: Commit.** `git commit -m "perf: add compact visual descriptions with stable temporal coverage"`.

### Task 3: Isolar caches por configuração real

**Files:** Modify `apps/cli/src/app/assembly/model.ts`, `apps/cli/src/app/server.ts`; Test `apps/cli/src/app/assembly/model.test.ts`, `apps/cli/src/app/assembly/preparation.test.ts`.

**Interfaces:** Cliente de DescribeDeps passa a expor metadados opcionais `model?: string`, `providerKey?: string`; chave identifica provider/baseURL sanitizada, sem credenciais/query. Clientes injetados sem identidade continuam funcionais, mas não leem/escrevem cache persistente. Cliente padrão resolve identidade usando `analysisClientOptions({stored})`, mesmo objeto usado para instanciar transporte. lazyPaidSend deve disponibilizar resolução do cliente sem fazer chamada de rede; não inferir identidade pelo default global.

- [ ] **Step 1: Teste de invalidação.** No teste com diretório/frames fake já existente, executar A, A, B, B variando client.model; contar chamadas. Repetir com mesmo modelo e providerKey diferente, depois profile compact. Critério:

```ts
expect(callsAfterSameIdentity).toBe(1);
expect(callsAfterNewModel).toBe(2);
expect(callsAfterNewProvider).toBe(3);
expect(callsAfterCompact).toBe(4);
```

Os contadores são capturados após cada await describeSource da fixture, uma janela por fonte. Adicionar projeto com apoio manual referenciando análise já salva: preparação não troca os IDs nem reanalisa automaticamente pela simples atualização do software. Nova configuração vale quando análise nova é explicitamente solicitada.
- [ ] **Step 2: Executar RED.** `pnpm vitest run apps/cli/src/app/assembly/model.test.ts apps/cli/src/app/assembly/preparation.test.ts --exclude '**/.muse/**'`.
- [ ] **Step 3: Versionar somente artefatos derivados novos.** Criar chave SHA256 de configuração; usar hash no diretório para evitar path traversal e separar caches antigos:

```ts
const identity = {version:"visual-v4",providerKey,model,profile,
  promptVersion:3,sampleFps:1,frameMaxSize:480};
const identityKey = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
```

Manter sha256 da mídia e limites da janela no envelope e validação. Baseline e compact têm diretórios diferentes. Nunca copiar cache antigo para identidade nova sem prova. Corrigir `parseWindowCache` para comparar a identidade resolvida, não ZAI_DEFAULT_MODEL. Mantém-se o projeto persistido intocado; nenhuma migração de cenas. Temporários exclusivos por chamada via randomUUID para não colidir entre tentativas.
- [ ] **Step 4: Rodar GREEN.** Testes Step 2, testes de server/provider existentes afetados e `pnpm typecheck`. Conferir que dados de cache/log não contêm chave de API.
- [ ] **Step 5: Commit.** `git commit -m "fix: key visual caches by actual provider model and profile"`.

### Task 4: Comparar estratégias em ensaio isolado

**Files:** Create `scripts/visual-analysis-proof.ts`, `scripts/visual-analysis-proof.test.ts`, `docs/superpowers/evidence/2026-09-21-analise-visual-rapida.md`.

**Interfaces:** Exportar do script `sampleFrames(frames: VisualFrame[], step: 1 | 3): VisualFrame[]`; `main` só roda quando executado diretamente. CLI exige `--project`, `--out`, `--arm baseline|compact|sparse|two-pass|low-effort` e `--allow-paid`; sem flag, apenas inventaria corpus e imprime pedido concreto sem fazer rede. Proteger main por comparação de fileURLToPath(import.meta.url) com resolve(process.argv[1]). Nenhum saveProject ou render.

- [ ] **Step 1: Testar seleção sem fabricar timestamps.**

```ts
const frames = [19,20,21,22,23,24].map(sourceSecond => ({sourceSecond,dataUrl:"fixture"}));
expect(sampleFrames(frames,3).map(f => f.sourceSecond)).toEqual([19,22,24]);
expect(sampleFrames(frames,1)).toEqual(frames);
expect(sampleFrames([],3)).toEqual([]);
```

- [ ] **Step 2: Executar RED.** `pnpm vitest run scripts/visual-analysis-proof.test.ts --exclude '**/.muse/**'`.
- [ ] **Step 3: Implementar seleção experimental.**

```ts
export function sampleFrames(frames: VisualFrame[], step: 1 | 3): VisualFrame[] {
  return frames.filter((_, i) => i % step === 0 || i === frames.length - 1);
}
```

Reutilizar extração a 1 fps no piloto e subamostrar em memória: este ensaio mede benefício de rede/geração, não a redução de custo de extração. Sparse só para role speech; support/both ficam 1 fps. Resultado sparse fica no relatório experimental, jamais em project.analyses ou cache de produção.

Braços: baseline atual; compact com 1 fps; sparse com descrição compacta; two-pass com leitura geral esparsa e detalhamento a 1 fps dos intervalos sugeridos, incluindo custo das duas chamadas; low-effort igual compact alterando apenas reasoning_effort. Usar fetchImpl wrapper do transporte existente para contabilizar todas as tentativas HTTP e usage, sem registrar payload/autorização. No braço low-effort, confirmar suporte do modelo na documentação oficial durante execução; se incompatível, marcar braço não executado, sem trocar modelo ou endpoint. Limite de rede continua 2, extração 2. Limitar cada braço à mesma amostra de no máximo 60s e três repetições; estimar número de chamadas antes da autorização do piloto.

Corpus deve conter entrevista estática, ação breve e mudança de plano, vídeo vertical, trecho final fracionário. Identificar trechos do material real em leitura local e registrar ações essenciais com tempos antes de comparar. Se faltarem essas condições no material acessível, registrar evidência insuficiente, sem promover novo default.

- [ ] **Step 4: Rodar GREEN offline.** Teste Step 2 e `pnpm typecheck`. Verificar com cliente fake que ausência de --allow-paid faz zero chamadas; two-pass contabiliza ambas e nenhuma execução escreve project.json. Comparar hash do projeto antes/depois.
- [ ] **Step 5: Piloto e decisão.** Somente após autorização aplicável: executar braços em cópia com caches próprios. Registrar wall total, queue/extract/request, tentativas HTTP, tokens reais se retornados, cache frio/quente, frames enviados, ações essenciais recuperadas e avaliações humanas de apoio. Não comparar cache quente de um braço com frio de outro. Se mediana cair ≥20% e nenhuma ação essencial/referência válida for perdida, promover apenas compact a default e rerodar regressões. Se não cumprir, baseline fica padrão. Sparse/two-pass/low-effort permanecem experimentais e recebem decisão documentada para plano de integração separado.
- [ ] **Step 6: Commit.** `git commit -m "test: compare visual analysis latency and evidence quality"`.

## Revisão do plano

Telemetria Task 1; descrições por cena e compatibilidade Task 2; identidade/cache Task 3; amostragem adaptativa, duas passagens, raciocínio e qualidade Task 4. Ganhos não são afirmados antes da medição. O piloto não altera o projeto do usuário. A concorrência não aumenta. A presença de todos os entrevistados pertence à edição narrativa, fora deste plano.
