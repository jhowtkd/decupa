# Base comum: medição e orçamento de recursos — Plano de implementação

> Para execução por agente: implementar tarefa a tarefa; usar revisão independente quando disponível e registrar evidências reais. Checkboxes representam trabalho ainda não executado.

**Goal:** Medir tempo real e controlar recursos antes de paralelizar as duas frentes.

**Architecture:** Instrumentação sem alterar decisões, orçamento por host, artefatos versionados e aplicação de resultados serializada.

**Tech Stack:** Node/TypeScript, Vitest, Python, FFmpeg, sidecars existentes.

**Spec:** `docs/superpowers/specs/2026-09-17-decupa-aceleracao-design.md`


## Restrições globais

Aplicar os invariantes do design. Base `d2ed17015c06f3d8a13d64069b7bcbd89b4a61fa`; antes de editar, comparar HEAD e adaptar diferenças sem apagar alterações existentes. Node `>=22.6`, `pnpm@10.32.1`. Nada de API paga em CI, mudanças na `main` diretamente, retirada de validadores, redução silenciosa de qualidade ou promessa de percentual não medido.

Comandos existentes de validação global:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm smoke
pnpm test
```

Esses comandos não foram executados nesta entrega. Arquivos identificados como novos abaixo ainda não existem no repositório. Os snippets descrevem os contratos a implementar; não são uma alegação de patch aplicado. Executar cada tarefa com teste que falha, implementação mínima, teste que passa e commit isolado.

## Mapa de arquivos

Criar `apps/cli/src/performance/{trace,resource-pool,artifact-cache}.ts` e testes homônimos. Integrar pontos de medição em `apps/cli/src/app/pipeline.ts`, `apps/cli/src/triage.ts` e `apps/cli/src/app/assembly/preparation.ts`. Reutilizar `saveProject` de `assembly/store.ts`; não duplicar o estado do projeto. Criar testes de carga em `tests/performance-flow.test.ts` e um executor de benchmark em `scripts/benchmark-decupa.mjs`.

### B1. Traços de desempenho, sem conteúdo sensível

**Arquivos:** criar `performance/trace.ts`, `trace.test.ts`; modificar `pipeline.ts`, `triage.ts`, `assembly/preparation.ts`.

**Contrato:** cada tentativa gera eventos de fila/início/fim com monotonic clock, `jobId`, `stage`, `attempt`, `parentSpanId`, `outcome`, `cacheHit`, `backend` e quantidade de bytes, sem texto do material. Falha no coletor não interrompe a edição.

```ts
export type StageName = 'queue' | 'probe' | 'audio_extract' | 'asr_load'
  | 'asr' | 'align' | 'index' | 'vision' | 'proxy' | 'visual_window'
  | 'model' | 'proposal' | 'waveform' | 'preview' | 'export';
export type StageEvent = {
  jobId: string; spanId: string; parentSpanId?: string;
  stage: StageName; attempt: number; atMs: number;
  kind: 'queued' | 'started' | 'finished';
  outcome?: 'ok' | 'error' | 'cancelled'; cacheHit?: boolean;
};
```

- [ ] Escrever teste com relógio/sink injetáveis: erro da tarefa ainda emite um fim; erro do sink não muda o retorno da tarefa; cancelamento tem categoria própria.
- [ ] Executar `pnpm exec vitest run apps/cli/src/performance/trace.test.ts` e guardar a falha inicial.
- [ ] Implementar wrapper `measureStage(context, stage, task)` com `try/catch/finally`; usar `performance.now()` para duração e data ISO somente como metadado. Estado final emitido uma única vez.
- [ ] Instrumentar os pontos existentes sem mover trabalho nem modificar argumentos. Acrescentar subetapas de Python via stderr estruturado, não misturando JSON de resultado em stdout.
- [ ] Reexecutar testes e gates globais. Commit: `feat(perf): instrument pipeline stage timing without changing edits`.

Teste mínimo de contrato após construir o coletor:

```ts
expect(events.filter(e => e.kind === 'finished')).toHaveLength(1);
expect(events.some(e => e.outcome === 'error')).toBe(true);
expect(JSON.stringify(events)).not.toContain('texto privado da transcrição');
```

### B2. Fila limitada, cancelamento e escritor único

**Arquivos:** criar `performance/resource-pool.ts`, `resource-pool.test.ts`; integrar em `triage.ts`, `assembly/model.ts` e `assembly/preparation.ts`.

**Contratos a produzir:** `ResourcePool.run<T>(resource, jobId, signal, task): Promise<T>` e `mapBoundedOrdered<T,R>(items, limit, signal, task): Promise<R[]>`. A lista devolvida segue a ordem de entrada mesmo quando chamadas terminam fora de ordem.

- [ ] Criar testes com promessas controladas, não limites frágeis em milissegundos. Bloquear a primeira tarefa; comprovar que só `limit` começaram. Liberar a terceira antes da segunda e exigir ordem final estável.
- [ ] Testar cancelamento de item na fila, erro de tarefa e consumidor que abandona single-flight. Nenhum slot pode vazar; uma tarefa cancelada não cancela trabalho compartilhado de outro consumidor.
- [ ] Executar `pnpm exec vitest run apps/cli/src/performance/resource-pool.test.ts` antes de implementar.
- [ ] Implementar filas separadas e aquisição por etapa. Não reservar vaga de CPU durante espera de rede. Não usar `Promise.all` irrestrito.
- [ ] Fazer consumidores devolverem resultados imutáveis. Somente o coordenador chama `saveProject`, conferindo revisão e execução, evitando que laços paralelos compartilhem a variável mutável `current`.
- [ ] Manter limite por processo identificado como tal até B4; não anunciar limite por máquina antes do coordenador local. Testar `limit=1` como caminho de comparação.
- [ ] Gates e commit: `feat(perf): bound work and serialize project result application`.

```ts
expect(maxRunning).toBeLessThanOrEqual(2);
expect(results.map(r => r.id)).toEqual(['a', 'b', 'c']);
expect(pool.active('ffmpeg')).toBe(0);
```

### B3. Cache por etapa com publicação atômica

**Arquivos:** criar `performance/artifact-cache.ts`, `.test.ts`; modificar `assembly/analysis.ts`, `assembly/model.ts`, `assembly/media.ts`, `packages/triage/src/cache.ts` e respectivos testes.

**Contrato:** `artifactKey({sourceSha256, purpose, version, parameters})` com JSON canônico; `getOrBuildArtifact(key, signal, build, validate)` retorna somente artefato íntegro. Parâmetros efetivos de análise e perguntas são versionados.

- [ ] Escrever testes: duas solicitações iguais geram uma construção; arquivo truncado reconstrói; cancelamento no meio não publica; provedor/modelo diferente invalida só análise correspondente; alterar ordem da montagem não retranscreve fontes.
- [ ] Executar os testes antes de implementar.
- [ ] Implementar tmp com UUID + rename, validação e manifest. Falha é registrável, não reaproveitável como sucesso. Diferenciar `unknown`, `missing` e `ready`.
- [ ] Substituir uso de `ZAI_DEFAULT_MODEL` como identidade de chamada por identidade efetiva no cache visual/semântico. Não incluir provedor de LLM na chave de transcrição ou proxy.
- [ ] Registrar fingerprints de amostragem e janela, inclusive `fetchStart`. Cache existente só migra quando identidade é comprovada; caso contrário, miss explícito.
- [ ] Gates e commit: `fix(cache): key artifacts by source stage and effective configuration`.

```ts
expect(artifactKey({...base, purpose:'asr'})).toBe(artifactKey({...base, purpose:'asr'}));
expect(artifactKey({...base, purpose:'preview'})).not.toBe(artifactKey({...base, purpose:'vision'}));
expect(buildCalls).toBe(1); // dois consumidores simultâneos da mesma chave
```

### B4. Coordenação local e benchmark de lotes

**Arquivos:** criar `performance/coordinator.ts`, `.test.ts`, `scripts/benchmark-decupa.mjs`, `tests/performance-flow.test.ts`; integrar inicialização/encerramento via `apps/cli/src/index.ts` e arranque MCP existente.

**Contrato:** coordenador local único por área de trabalho, com tarefas persistidas, autenticação local e limite compartilhado entre processos. A versão inicial pode centralizar execução num único processo supervisor; não criar um scheduler por janela.

- [ ] Criar teste iniciando dois clientes isolados: ambos disputam o mesmo limite. Simular morte/reinício e garantir retomada de estágio incompleto sem refazer os concluídos.
- [ ] Criar manifesto de benchmark com `caseId`, caminho autorizado, duração, perfil, hash, cenário cache e hardware. Nenhum comando com arquivo fictício deve ser apresentado como benchmark realizado.
- [ ] Implementar lease de trabalho, heartbeat e publicação cercada por identificador de tentativa. Tarefa abandonada pode ser retomada, mas sua antiga execução não publica resultado.
- [ ] Dar prioridade à edição interativa com limite justo para lote. Persistir apenas estado de trabalho; resultado editorial continua no armazenamento já existente.
- [ ] Medir lotes de 1, 5 e 20 arquivos, registrando minutos de fonte/hora, p50/p95, uso de RAM e falhas. Separar cold start, warm model e warm artifact.
- [ ] Gates e commit: `feat(perf): coordinate local batch resources and record workload benchmarks`.

Critério estrutural: 20 tarefas terminam, ou exibem falha específica; nenhuma fica silenciosamente perdida. Sob saturação, fila cresce de forma visível e limitada, não o número de processos nem a RAM indefinidamente. Percentis de corpus pequeno são descritivos; reportar tamanho da amostra.
