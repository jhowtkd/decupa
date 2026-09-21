# Frente 1: processamento de mídia — Plano de implementação

> Para execução por agente: implementar tarefa a tarefa; usar revisão independente quando disponível e registrar evidências reais. Checkboxes representam trabalho ainda não executado.

**Goal:** Reduzir trabalho repetido e esperas de mídia sem modificar a edição resultante.

**Architecture:** Aproveitar B1–B4. Primeiro alterar busca e concorrência; depois separar apresentação, reutilizar derivados e manter modelos de fala carregados.

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

## Mapa e dependências

M1 é independente após medição. M2 precisa de B2/B3. M3 precisa de B2 e escritor único. M4 precisa de B3/B4. M5 e M6 seguem após o baseline. Nenhuma tarefa depende de acesso ao Jev.

### M1. Busca eficiente das janelas visuais

**Arquivos:** `apps/cli/src/app/assembly/model.ts`, `model.test.ts`; criar `tests/visual-window-seek.test.ts`.

**Mudança delimitada:** em `windowClip`, usar seek de entrada com transcodificação e busca precisa; preservar duração local, contexto, resolução e FPS atuais. Corrigir o comentário que trata toda busca de entrada como necessariamente imprecisa.

```ts
const args = ['-n', '-ss', String(window.fetchStart), '-accurate_seek',
  '-i', source.path, '-t', String(window.end - window.fetchStart),
  '-vf', "fps=1,scale='min(480,iw)':'min(480,ih)':force_original_aspect_ratio=decrease",
  '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tmp];
```

- [ ] Antes da mudança, escrever teste que exige `-ss` antes de `-i` e proíbe `-c copy` neste caminho. Rodar `pnpm exec vitest run apps/cli/src/app/assembly/model.test.ts` e verificar falha.
- [ ] Criar fixtures sintéticas via FFmpeg: CFR, VFR, início não zero, GOP longo e rotação; exigir quadro/tempo de origem correto nas janelas, contexto de 1 segundo e fim parcial.
- [ ] Aplicar a mudança mínima. Rejeitar entrada sem busca confiável ou usar o caminho legado por formato, sem alterar intervalos silenciosamente.
- [ ] Comparar amostras decodificadas e montagem/exportação antes/depois. Igualdade do MP4 comprimido não é requisito; identidade temporal e visual é.
- [ ] Executar benchmark alternando ordem e preservando configuração. Registrar versão do FFmpeg, hardware, repetições, entrada e argumentos. Não extrapolar o teste sintético fornecido para o app.
- [ ] Gates e commit: `perf(visual): use accurate input seeking for window extraction`.

### M2. Concorrência visual limitada e cache antes de extração

**Arquivos:** `apps/cli/src/app/assembly/model.ts`, `model.test.ts`, `apps/cli/src/triage.ts`; criar `tests/visual-concurrency.test.ts`.

**Contrato:** janelas/inspeções independentes utilizam ResourcePool; resultados continuam ordenados e aplicados no fim da fase. `inspect` continua no provedor visual atual.

- [ ] Testar limite de rede e de FFmpeg separadamente; uma janela esperando API não segura vaga de codificação. Testar `limit=1` com resultados idênticos ao legado.
- [ ] Executar `pnpm exec vitest run tests/visual-concurrency.test.ts` e observar falha antes da implementação.
- [ ] Trocar laços sequenciais por `mapBoundedOrdered`, mantendo validação local e fusão determinística por janela. `429/529` reduzem pressão, respeitam atraso e orçamento total; não fazer rajada de retries.
- [ ] Para inspeção, procurar artefato de frames validado pela identidade da fonte e versão do extrator antes de executar novamente FFmpeg. A identidade do modelo não substitui a identidade do vídeo.
- [ ] Persistir cada janela validada atomicamente. Em retomada, só janelas faltantes/incompletas são calculadas. Não transformar ausência de descrição em `unavailable` artificial.
- [ ] Garantir cancelamento real: parar novas tarefas e terminar subprocessos pertencentes ao trabalho; resposta atrasada não altera revisão mais recente.
- [ ] Gates e commit: `perf(visual): parallelize independent windows within shared budgets`.

```ts
expect(maxModelRequests).toBeLessThanOrEqual(3);
expect(maxFfmpegProcesses).toBeLessThanOrEqual(2);
expect(resultWithLimit3).toEqual(resultWithLimit1); // transporte roteirizado
expect(callsAfterWarmArtifactReplay).toBe(0);
```

### M3. Áudio não aguarda forma de onda e miniatura

**Arquivos:** `apps/cli/src/app/assembly/preparation.ts`, `preparation.test.ts`, `media.ts`, `waveform.ts`; criar `tests/preparation-performance.test.ts`.

- [ ] Escrever teste com `ensurePlayback`/waveform bloqueados por promessas e comprovar que a análise de áudio pode iniciar após verificação de identidade. O teste deve falhar no fluxo atual.
- [ ] Executar `pnpm exec vitest run tests/preparation-performance.test.ts`.
- [ ] Agendar apresentação como tarefa acompanhada de baixa prioridade, com erro coletado e cancelamento. Não usar promessa abandonada nem deixar rejeição sem tratamento.
- [ ] Respeitar dependências reais: preview final precisa de mídia reproduzível; proposta exige análises/cobertura obrigatórias. Não retirar a barreira de `runPreparation`.
- [ ] Aplicar estados de resultados pelo escritor único. Exibir explicitamente “áudio pronto, imagem em análise” quando aplicável; não declarar projeto pronto antes da validação exigida.
- [ ] Reexecutar testes de preparação, concorrência de revisões, cobertura incompleta, cancelamento e exportação. Commit: `perf(preparation): decouple presentation derivatives from audio startup`.

```ts
expect(audioStarted).toBe(true);
expect(waveformFinished).toBe(false);
expect(projectCanExportWithoutRequiredCoverage).toBe(false);
```

### M4. Um trabalho de análise reutilizável por mídia e finalidade

**Arquivos:** `assembly/media.ts`, `analysis.ts`, `model.ts`, `apps/cli/src/app/pipeline.ts`, `packages/transcript/src/transcribe.ts`, `apps/cli/src/condense/run.ts`; testes homônimos e `tests/media-reuse.test.ts` novo.

- [ ] Escrever casos de reaproveitamento da mesma mídia em dois projetos autorizados da mesma área de trabalho, troca de conteúdo no mesmo caminho, cancelamento e perda de arquivo.
- [ ] Rodar teste, depois implementar acesso aos derivados por B3. Nunca usar apenas existência do caminho como prova de validade.
- [ ] Criar uma trilha de análise visual reutilizável por perfil de amostragem. Avaliar geração em uma passagem do original e divisão em janelas como alternativa ao seek repetido; promover apenas após verificar alinhamento das amostras. Preservar perfis distintos de 1 FPS e 4 FPS quando necessários.
- [ ] Reutilizar PCM de áudio para ASR e waveform quando formatos forem compatíveis. Antes de reaproveitar no detector de silêncio, comparar ganho/canais/limiares com o caminho atual; não mudar decisões por conversão mono silenciosa.
- [ ] Tratar TTL/limite de disco e referências em uso. Mudança no pedido de montagem não invalida ASR/visão da fonte; mudança de fonte invalida os derivados dependentes.
- [ ] Gates e commit: `perf(media): reuse validated source analysis artifacts across operations`.

```ts
expect(secondProjectAsrRuns).toBe(0);
expect(changedSourceAsrRuns).toBe(1);
expect(metadataOnlyEditModelCalls).toBe(0);
```

### M5. Processo de fala com modelos residentes

**Arquivos:** refatorar `services/speech/transcribe.py` mantendo CLI; criar `services/speech/worker.py`, `services/speech/test_worker.py`, `packages/transcript/src/worker-client.ts`, `.test.ts`; modificar `transcribe.ts`, `apps/cli/src/condense/run.ts` e `app/pipeline.ts`.

**Contrato Python:** operações `transcribe` e `align`; modelo carregado por `(model, language, device, compute_type, version)`. IPC JSONL leva id, operação e caminhos locais autorizados; progresso vai para stderr. Resultado mantém words/unaligned/timestamps do contrato atual.

```python
class ModelRegistry:
    def __init__(self, load_asr, load_align):
        self.load_asr = load_asr
        self.load_align = load_align
        self.asr = {}
        self.align = {}
    def get_asr(self, key):
        if key not in self.asr:
            self.asr[key] = self.load_asr(key)
        return self.asr[key]
```

- [ ] Com carregadores fake, escrever `unittest` que solicita dois arquivos e exige um carregamento por chave; idioma/configuração diferente cria outra entrada; falha/reinício não devolve resposta de outra tarefa.
- [ ] Executar `python -m unittest discover -s services/speech -p 'test_worker.py'` antes da implementação.
- [ ] Extrair funções de transcrição/alinhamento sem alterar seus parâmetros. Worker gerenciado pelo coordenador tem uma tarefa pesada por instância, limite de RAM e expiração por inatividade configurável.
- [ ] Evitar falsa persistência: `runIngest` hoje inicia `condense-prep` em subprocesso. Integrar `runCondensePrep` como função ou conectá-lo ao mesmo serviço residente; worker criado dentro de cada subprocesso efêmero não resolve o problema.
- [ ] Preservar a CLI de processo único como alternativa. Cancelamento de operação não interrompível encerra somente o worker daquela tarefa; reinicia limpo e mantém fila/restantes.
- [ ] Expor dispositivo/configuração de forma explícita e detectada; CPU atual permanece fallback. Não ligar GPU/Metal automaticamente. Comparar alinhamento e qualidade antes de trocar backend.
- [ ] Rodar testes Python, Vitest e gates. Benchmark com modelos já carregados e arquivos inéditos, não repetição servida por cache. Commit: `perf(speech): reuse ASR and alignment models in managed worker`.

**Visão:** manter inicialmente MediaPipe em processos isolados. Antes de tornar Face/Hand residentes, testar reinicialização de tracking VIDEO e timestamps por fonte; não reutilizar estado temporal de um arquivo no próximo.

### M6. Prévia reutilizável e perfis de hardware testados

**Arquivos:** `assembly/render.ts`, `render.test.ts`, `revisions.ts`, `media.ts`, `apps/cli/src/doctor.ts`; criar `tests/preview-cache.test.ts`.

- [ ] Escrever teste: mesma montagem, fontes e perfil retornam prévia já validada; alteração efetiva de corte invalida; alteração só de metadado não renderiza.
- [ ] Chave da prévia deve conter montagem canônica, hash das fontes, resolução/FPS e versão do renderizador. Validar arquivo antes de reutilizar e preservar associação com a revisão atual.
- [ ] Manter orçamento distinto de análise e render. Prévia pode usar perfil leve explícito; exportação final continua original e não muda como efeito colateral.
- [ ] Acrescentar detecção de capacidades ao doctor; avaliar encode/decode por hardware em fixture real. Disponibilidade em `ffmpeg -hwaccels` não prova velocidade nem funcionamento naquela mídia.
- [ ] Comparar cor, orientação, resolução, sincronismo e precisão de cortes. Hardware que falha volta ao software com motivo visível.
- [ ] Gates e commit: `perf(preview): reuse validated renders and detect supported media profiles`.

## Portão de liberação da frente de mídia

Comparar baseline e candidato no mesmo hardware e nos mesmos cenários. Otimização aprovada preserva resultados estruturais com modelos roteirizados, contrato acústico e cobertura. Para modelos reais não determinísticos, fazer avaliação editorial separada. Publicar evidências por etapa e por lote. Não liberar troca de amostragem, backend ou perfil final apenas porque o processamento ficou menor.
