# Auditoria ICE do Decupa — 2026-09-12

> Documento-fonte do plano `docs/superpowers/plans/2026-09-12-correcoes-auditoria-ice.md`.
> Auditoria externa trazida pelo usuário; todas as alegações foram conferidas
> contra o código da branch `codex/editor-texto-centrado` em 2026-09-12 antes
> do plano ser escrito.

## 1. Diagnóstico do Produto e Principais Gargalos

O **Decupa** é uma ferramenta de edição de vídeo assistida por IA voltada a produtores e editores que operam em português do Brasil. O projeto encontra-se em transição entre dois paradigmas:
1. **Pipeline Clássico de Limpeza (`decupa limpar`)**: monoarquivo, focado em eliminação de retakes e silêncios via corte de unidades estruturais com exportação para MP4 e EDL (CMX3600).
2. **Editor Texto-Centrado Multiarquivo (`decupa montar`)**: multiarquivo, onde a transcrição fonética/lexical é a própria timeline (estilo Descript), suportando falas, imagem de apoio (B-roll), aprovação por revisão assistida e exportação OpenTimelineIO (OTIO) + MP4 de referência para continuidade no DaVinci Resolve.

### Principais Gargalos e Pontos Críticos Identificados

* **Precisão de Cortes e Qualidade Acústica/Editorial**: O mecanismo de corte textual (`words.ts`) calcula remoções palavra a palavra. Ao cortar uma frase ou sequência de palavras adjacentes, os intervalos interpalavras (pausas, respirações e silêncios) não são englobados pelo intervalo removido. Isso deixa **micro-fragmentos de áudio e vídeo de milissegundos** no resultado final, gerando ruídos, cliques acústicos e pequenos "flashes" de 1 quadro.
* **Composição de Apoio Visual (B-Roll)**: No módulo de compilação da montagem (`scenes.ts`), o ponto de entrada na fonte de um clipe de apoio (`srcStartSeconds`) soma erroneamente o offset de timeline da cena. Quando uma imagem de apoio é inserida após alguns segundos do início da cena, o sistema avança a fonte para além da sua própria duração e a **descarta inteiramente** sob a alegação de "sem duração na cena".
* **Intercâmbio DaVinci Resolve e FPS Fracionário**: Há uma assimetria severa entre os fluxos:
  * Em `decupa limpar`, arquivos gravados em 29,97 ou 23,976 fps (padrão de smartphones e câmeras NTSC) sofrem erro fatal irrecuperável na exportação de EDL.
  * Em `decupa montar`, o exportador OTIO emite `RationalTime` com taxas assimétricas (`rate: 1` para o início e `rate: fps` para a duração), o que pode induzir desvios de quadros ou rejeição de importação pelo parser nativo do DaVinci Resolve.
* **Sobrecarga de I/O de Disco**: O renderizador de prévia (`render.ts`) recalcula o hash SHA-256 integral de todos os arquivos brutos a cada re-renderização, ignorando o mecanismo de verificação rápida por `stat` (`verifySourceIdentity`) já criado em `media.ts`. Na exportação (`export.ts`), o arquivo bruto chega a ser lido integralmente duas vezes consecutivas.
* **Concorrência e Recuperação de Falhas**: A publicação em background de alinhamentos de texto (`publishCorrection`) descarta silenciosamente o resultado se o usuário realizar qualquer edição enquanto o modelo alinha, travando a correção em `pending` indefinidamente. Além disso, se o processo for reiniciado durante a preparação, o projeto permanece travado em `running`.
* **Lacuna de Validação em Execução Real**: A suíte de testes locais cobre amplamente contratos unitários (697 testes passando), mas toda a integração com o DaVinci Resolve e com chamadas de IA pagas permanece mockada ou avaliada apenas por FFmpeg sintético, sem validação automatizada fim a fim no DaVinci instalado.

---

## 2. Tabela de Melhorias Priorizadas (Método ICE)

> **Critério de cálculo**: ICE = Impacto × Confiança × Facilidade (escala de 1 a 10 cada).
> As melhorias estão ordenadas de forma decrescente pela pontuação ICE.

| # | Melhoria | Problema Observado | Evidência (Arquivo:Linha) | I | C | F | ICE |
|---|---|---|---|:---:|:---:|:---:|:---:|
| **1** | Corrigir ponto de entrada e descarte indevido de Apoio Visual (B-roll) na montagem | `srcStartSeconds` soma o offset da timeline ao início do span da fonte; apoios inseridos no meio da cena ultrapassam a duração da mídia e são deletados silenciosamente. | `apps/cli/src/app/assembly/scenes.ts:374-380` | 9 | 10 | 9 | **810** |
| **2** | Harmonizar taxas de tempo no OTIO para garantir conformidade com importador DaVinci | `clipItem` gera `source_range.start_time` com `rate: 1` (segundos flutuantes) e `duration` com `rate: fps`, arriscando rejeição ou arredondamento incorreto no Resolve. | `apps/cli/src/app/assembly/otio.ts:63-66` · `otio.test.ts:65-72` | 9 | 9 | 9 | **729** |
| **3** | Fundir intervalos ao cortar sequências de palavras contíguas (eliminar micro-slivers) | Ao remover múltiplas palavras adjacentes, os espaços e pausas intermediários são preservados, gerando fragmentos residuais de 1 frame e estalos de áudio. | `apps/cli/src/app/assembly/words.ts:153-167` · `words.test.ts:79-81` | 9 | 10 | 8 | **720** |
| **4** | Rebasear salvamento de `publishCorrection` para evitar correções travadas em `pending` | Edições concorrentes durante o alinhamento em background abortam o salvamento via CAS, descartando o resultado alinhado e deixando o status `pending` perpétuo. | `apps/cli/src/app/assembly/routes.ts:223-238` · `routes.ts:253` | 8 | 10 | 9 | **720** |
| **5** | Substituir hash SHA-256 integral obrigatório por `verifySourceIdentity` no render de prévia | `renderAssembly` lê e calcula o hash integral de arquivos de vários gigabytes a cada atualização de prévia; na exportação, as fontes são lidas duas vezes. | `apps/cli/src/app/assembly/render.ts:112-117` · `apps/cli/src/app/assembly/export.ts:121,176` | 8 | 10 | 9 | **720** |
| **6** | Habilitar exportação de cortes com FPS fracionário (29,97 / 23,976) no `decupa limpar` | Exportação de EDL no pipeline de limpeza falha com exceção ao receber taxas de quadros não inteiras, sem oferecer OTIO alternativo. | `apps/cli/src/app/edl.ts:37-42` · `apps/cli/src/app/pipeline.ts:430-435` | 8 | 10 | 8 | **640** |
| **7** | Isolar variáveis de ambiente nos testes para restaurar execução limpa de `pnpm test` | Executar `pnpm test` falha de imediato se o ambiente tiver `ZAI_API_KEY` (exigida pelo `doctor`), quebrando o comando padrão do repositório. | `tests/assembly-flow.test.ts:35-38` · `vitest.config.ts:3-9` | 6 | 10 | 10 | **600** |
| **8** | Tratar recuperação pós-falha de projetos com `preparation.status === "running"` | Se o servidor reiniciar ou cair durante a preparação, o projeto permanece indefinidamente como `running`, bloqueando a interface web de novas ações. | `apps/cli/src/app/assembly/preparation.ts:203` · `routes.ts:335-345` | 7 | 10 | 8 | **560** |
| **9** | Tornar resolução de picos de waveform dinâmica por duração em `waveform.ts` | Geração fixa de 1000 buckets gera resolução inútil (3,6s/bucket para 1h de vídeo), achatando os dados de áudio na faixa de navegação. | `apps/cli/src/app/assembly/waveform.ts:45` · `editor/sequencia.js:207-212` | 6 | 10 | 8 | **480** |
| **10** | Criar automação de teste de importação real de OTIO no DaVinci Resolve (Gate G6) | Todo o intercâmbio com DaVinci é verificado por decodificação FFmpeg sintética; a importação real permanece pendente sem harness automatizado. | `scripts/assembly-proof.ts:217-218` · `docs/superpowers/evidence/2026-09-11-r1-aceite-local.md:30` | 8 | 9 | 5 | **360** |

---

## 3. Detalhamento Técnico das 10 Melhorias

### 1. Correção do Cálculo de Entrada de Apoio Visual em `compileScenes`
* *Impacto (9)*: Impede que clipes de apoio sejam sumariamente apagados da edição ou reproduzam trechos descompassados da mídia original.
* *Confiança (10)*: Confirmado em `scenes.ts` linha 375: `srcStartSeconds = span.start + (item.offsetFrames * fpsDen) / fpsNum`. A variável `offsetFrames` representa o momento de entrada na timeline da cena, não o deslocamento no arquivo de origem.
* *Facilidade (9)*: Alteração estritamente localizada em poucas linhas dentro de `compileScenes`.
* **Menor Intervenção Suficiente**: Desvincular o offset temporal da cena do ponto de entrada do span da mídia de apoio, utilizando `span.start` e calculando a duração disponível na fonte como `span.end - span.start`.
* **Critério Verificável de Sucesso**: Teste unitário em `scenes.test.ts` compilando uma cena com apoio posicionado no meio, onde o span de apoio é curto, garantindo que a pista V2 receba o clipe completo sem descarte e com início em `0s` na fonte.

### 2. Harmonização de Taxas de Tempo no OTIO para DaVinci Resolve
* *Impacto (9)*: Garante que o intercâmbio de timeline editável para o DaVinci não sofra truncamento de segundos ou perda de sincronia labial.
* *Confiança (9)*: Em `otio.ts` linha 64, `source_range.start_time` possui `rate: 1` e valor fracionário, enquanto `duration` tem `rate: fps`. No ecossistema NLE, `TimeRange` com rates mistos é fonte clássica de inconsistências em importadores C++.
* *Facilidade (9)*: Mudança localizada na função `clipItem` de `otio.ts`.
* **Menor Intervenção Suficiente**: Em `clipItem`, expressar `start_time` usando o mesmo `rate` da timeline, com `value: Math.round(clip.sourceStartSeconds * fps)` e `rate: fps`.
* **Critério Verificável de Sucesso**: Atualização de `otio.test.ts` comprovando que `clip.source_range.start_time.rate === clip.source_range.duration.rate`.
* **Dependências**: Nenhuma.

### 3. Eliminação de Micro-Slivers Residuais ao Cortar Palavras Consecutivas
* *Impacto (9)*: Qualidade editorial direta. Elimina estalos de áudio e engasgos de vídeo nas emendas de corte textual.
* *Confiança (10)*: Confirmado em `words.test.ts:79-81`: ao remover `w1` [0.1, 0.4] e `w2` [0.42, 0.7], o array `removed` contém dois intervalos separados, preservando a lacuna de 20 ms [0.4, 0.42] como conteúdo mantido na mídia.
* *Facilidade (8)*: Exige ajustar a extração de intervalos para identificar contiguidade de seleção e cobrir as pausas intermediárias.
* **Menor Intervenção Suficiente**: Em `wordIntervalsInTake`, se duas ou mais palavras selecionadas forem vizinhas imediatas no catálogo lexical, agrupar o intervalo de corte do início da primeira palavra até o fim da última palavra da sequência.
* **Critério Verificável de Sucesso**: Teste unitário em `words.test.ts` verificando que a remoção de duas palavras contíguas produz um único intervalo contínuo cobrindo o intervalo interpalavras.

### 4. Rebase de Salvamento em `publishCorrection`
* *Impacto (8)*: Impede que correções textuais aplicadas pelo usuário fiquem eternamente em estado "pendente" caso haja qualquer interação concorrente.
* *Confiança (10)*: Código em `routes.ts:223-238` realiza `saveProject(dir, expectedRevision)` dentro de um bloco `try/catch` que apenas descarta o erro se a revisão divergir, sem revalidar sobre a revisão nova; e `alignCorrectionJob` retorna cedo se `current.revision !== expectedRevision` (linha 253).
* *Facilidade (9)*: Adotar o mesmo padrão de rebase com retry já implementado na Tarefa 11 em `preparation.ts:234-259`.
* **Menor Intervenção Suficiente**: Em `publishCorrection`, capturar a revisão mais recente do projeto via CAS e aplicar `settleCorrection` sobre o estado atual; descartar apenas quando a correção sumiu ou já foi resolvida.
* **Critério Verificável de Sucesso**: Teste de integração em `routes.test.ts` simulando avanço de revisão (ex.: corte de palavra) durante a execução de `alignCorrectionJob`, comprovando que o retorno final do projeto assenta a correção como `aligned`.
* **Dependências**: Nenhuma.

### 5. Otimização de I/O em Prévia e Exportação (Uso de `verifySourceIdentity`)
* *Impacto (8)*: Reduz drasticamente a latência e desgaste de disco durante a edição interativa de vídeos pesados (4K / múltiplos GBs).
* *Confiança (10)*: Confirmado em `render.ts:113`: `hashFile` é invocado diretamente para todas as fontes a cada chamada de render. Em `export.ts:121, 176`, as fontes são hashadas duas vezes na mesma rotina.
* *Facilidade (9)*: `verifySourceIdentity` já existe e está testada em `media.ts:25-44`.
* **Menor Intervenção Suficiente**: Substituir a chamada bruta de `hashFile` em `renderAssembly` por `await verifySourceIdentity(source)`. Em `exportApproved`, reutilizar o sha registrado nas fontes (identidade recém-verificada) em vez de recalcular.
* **Critério Verificável de Sucesso**: Teste unitário de mock comprovando que `renderAssembly` não relê a fonte quando tamanho e `mtimeMs` permanecem inalterados.
* **Dependências**: Nenhuma.

### 6. Desbloqueio de FPS Fracionário no `decupa limpar`
* *Impacto (8)*: Destrava o fluxo principal de entrega para editores que utilizam a ferramenta de limpeza em vídeos reais (29,97 fps de iPhone/Sony/Canon).
* *Confiança (10)*: Linhas 37–42 de `edl.ts` e linhas 430–435 de `pipeline.ts` bloqueiam ativamente a operação com `throw new Error(...)`.
* *Facilidade (8)*: O projeto já possui implementação funcional de OTIO (`otio.ts`) que lida com taxas racionais `{ num, den }`.
* **Menor Intervenção Suficiente**: Duas etapas: (1) Adicionar a opção de exportação em formato OTIO na rota de exportação de `server.ts`; (2) Implementar cálculo de timecode Drop-Frame em `edl.ts` para quando o usuário optar estritamente por EDL CMX3600 em 29,97 fps.
* **Critério Verificável de Sucesso**: Testes exportando corte de um arquivo com 29,97 fps sem emissão de erro, com timecode drop-frame validado ou arquivo OTIO gerado.
* **Dependências**: Nenhuma.

### 7. Isolamento de Ambiente no Runner do Vitest
* *Impacto (6)*: Evita atrito de desenvolvimento, alertas falsos em CI e garante que `pnpm test` rode limpo com um comando simples.
* *Confiança (10)*: Testado diretamente nesta análise: o teste `tests/assembly-flow.test.ts` falha imediatamente ao detectar `ZAI_API_KEY` exportada no ambiente do usuário.
* *Facilidade (10)*: Configuração simples de runner.
* **Menor Intervenção Suficiente**: Em `vitest.config.ts`, definir `env: { ZAI_API_KEY: "", OPENAI_API_KEY: "" }`.
* **Critério Verificável de Sucesso**: Execução de `pnpm test` finalizando com 100% de sucesso sem necessidade do prefixo `env -u`.
* **Dependências**: Nenhuma.

### 8. Recuperação Pós-Crash de Preparação Presa em `running`
* *Impacto (7)*: Evita travamento completo da interface do usuário após interrupções de processo ou quedas de energia.
* *Confiança (10)*: A especificação `2026-09-11-fluxo-automatico-edicao-textual.md` apontou isso como pendência, e `routes.ts` não possui reconciliação no bootstrap do servidor.
* *Facilidade (8)*: Verificação pontual no carregamento de projeto.
* **Menor Intervenção Suficiente**: No endpoint `/project`, se `project.preparation?.status === "running"` e não houver runner ativo no processo atual, transicionar o status atomicamente para `"interrupted"` com mensagem descritiva.
* **Critério Verificável de Sucesso**: Teste simulando carregamento de `project.json` com status `running` confirmando que a API retorna `interrupted` e libera o botão de retomada na UI.
* **Dependências**: Nenhuma.

### 9. Resolução Dinâmica de Waveform Conforme a Duração
* *Impacto (6)*: Melhora a legibilidade visual da navegação na faixa inferior da tela do editor.
* *Confiança (10)*: Verificado em `waveform.ts:45`: `const buckets = opts.buckets ?? 1000`.
* *Facilidade (8)*: Ajuste na quantidade de amostras agregadas por segundo.
* **Menor Intervenção Suficiente**: Em `buildPeaks`, calcular `buckets` com base na duração da fonte em segundos (ex.: `Math.max(500, Math.min(10000, Math.round(durationSeconds * 20)))`), mantendo densidade aproximada de 20 picos por segundo.
* **Critério Verificável de Sucesso**: Teste comparando a saída de `buildPeaks` para durações curtas e longas, garantindo detalhamento visível sem achatar o áudio.
* **Dependências**: Nenhuma.

### 10. Harness Automatizado de Importação Real no DaVinci Resolve (Gate G6)
* *Impacto (8)*: Fecha o ciclo de confiança do produto; confirma que a entrega editável prometida abre sem surpresas no software de destino.
* *Confiança (9)*: Evidências anteriores registram que a importação real nunca foi executada em script de automação (`2026-09-11-r1-aceite-local.md:30`).
* *Facilidade (5)*: Requer orquestração com a API Python do DaVinci Resolve (`DaVinciResolveScript`).
* **Menor Intervenção Suficiente**: Implementar um script em `scripts/davinci-verify.py` utilizando o módulo nativo do Resolve instalado em `/Applications/DaVinci Resolve/` para: criar projeto temporário, importar `timeline.otio`, inspecionar contagem de trilhas e checar se todas as mídias estão online.
* **Critério Verificável de Sucesso**: Execução do script retornando código de saída 0 e relatório JSON comprovando que as pistas e cortes importados batem com os dados do OTIO.
* **Dependências**: Exige que o DaVinci Resolve esteja em execução ou acessível via API de scripting do sistema local.

---

## 4. Três Primeiras Ações Recomendadas e Ordem de Execução

Embora o ranking ICE seja ordenado estritamente pela pontuação matemática de prioridade, a **ordem de execução prática** deve respeitar a disciplina de engenharia e a fundação dos testes:

1. **Isolar Variáveis de Ambiente no Vitest (Melhoria #7)** — nenhuma alteração deve ser iniciada sem que a suíte de testes de regressão esteja 100% verde no comando padrão (`pnpm test`).
2. **Corrigir Ponto de Entrada do Apoio Visual (Melhoria #1)** — maior impacto funcional e maior pontuação ICE; restauração imediata da proposta de valor da montagem.
3. **Fundir Intervalos ao Cortar Palavras Contíguas (Melhoria #3)** — qualidade editorial impecável na experiência de edição textual.

---

## 5. Fatos Confirmados, Inferências e Hipóteses

### Fatos Confirmados (Evidência Direta no Código e Execuções Locais)
1. `pnpm run typecheck` passou com código 0 (TypeScript estrito sem erros).
2. `node --experimental-strip-types apps/cli/src/index.ts doctor` executou com sucesso (Node 26.7.0, FFmpeg, UV, sidecars e chaves OK).
3. A suíte Vitest executou 698 testes locais: 697 passaram e 1 falhou (`tests/assembly-flow.test.ts:36`, devido à presença de `process.env.ZAI_API_KEY`).
4. O branch atual é `codex/editor-texto-centrado`, com as Tarefas 1 a 11 do plano de editor texto-centrado já implementadas e commitadas.
5. Em `apps/cli/src/app/assembly/scenes.ts:375`, a variável `item.offsetFrames` da cena é adicionada a `span.start` da fonte, gerando o descarte de apoio quando o offset supera o tamanho do span.
6. Em `apps/cli/src/app/assembly/render.ts:113`, `hashFile` roda de forma incondicional em todas as fontes a cada chamada de renderização de prévia.
7. Em `apps/cli/src/app/edl.ts:37`, qualquer FPS não inteiro dispara uma exceção explícita no pipeline de limpeza.

### Inferências (Deduções Lógicas Sustentadas pela Arquitetura)
1. O descarte de resultados em `publishCorrection` (`routes.ts:237`) ocorre sempre que o usuário continua editando o texto enquanto o alinhamento roda no processo secundário.
2. A leitura integral de áudio de 1 hora via `readPcm` em buffer Node.js de 1GB gera contenção de GC e degradação de desempenho em máquinas com menos memória.

### Hipóteses (Comportamentos Prováveis Pendentes de Validação Externa)
1. O DaVinci Resolve pode rejeitar ou desalinhar clipes do OTIO cujo `start_time` possua `rate: 1` e `duration` taxa fracionária, dependendo da versão exata instalada no Mac do usuário.
2. A criação de script de teste via API Python do DaVinci Resolve pode não funcionar se o scriptapp da versão Free restringir acesso (nota já registrada em `otio.ts:123`: "scriptapp(Resolve) pode devolver None neste Mac").

---

## 6. O que Foi Examinado e Validações Pendentes

### Escopo Efetivamente Examinado
* Árvore de diretórios completa, submódulos e configurações de workspace (`pnpm-workspace.yaml`, `package.json`, `tsconfig.json`).
* Estado do Git, branches locais e remotas, log recente e diff acumulado da branch `codex/editor-texto-centrado`.
* Especificações e planos arquiteturais em `docs/superpowers/specs/` e `docs/superpowers/plans/`.
* Histórico de evidências de testes anteriores em `docs/superpowers/evidence/`.
* Todo o módulo de montagem multiarquivo (`apps/cli/src/app/assembly/*`).
* Mecanismos de exportação de EDL e OTIO (`edl.ts`, `otio.ts`, `export.ts`).
* Utilitários de diagnóstico e mídia (`doctor.ts`, `probe.ts`, `audio.ts`, `render.ts`).
* Execução local de: `git status`, `git log`, `pnpm run typecheck`, `decupa doctor` e suíte completa de testes (`vitest run`).

### Validações que Permanecem Pendentes
* **Importação Real no DaVinci Resolve (Gate G6)**: nenhum arquivo OTIO da branch atual foi aberto visualmente no DaVinci para inspecionar conformidade de pistas e relink de mídia.
* **Chamadas a Provedores Pagos (Z.ai / GLM)**: nenhuma chamada externa com consumo de tokens reais foi realizada, em observância às restrições de custo e consentimento do projeto.
* **Validação Visual do Editor de Texto Centrado (Tarefa 12 do plano anterior)**: prova visual com mídia real e gravação de evidências fotográficas das 4 regiões da interface permanece pendente no ambiente do usuário.
