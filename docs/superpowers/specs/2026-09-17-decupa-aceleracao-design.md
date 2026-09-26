# Decupa: aceleração de mídia e decisões de IA

Data: 17 de setembro de 2026. Base inspecionada: `d2ed17015c06f3d8a13d64069b7bcbd89b4a61fa`.
Status: desenho e planos de implementação; nenhuma alteração publicada no repositório. Um experimento isolado de FFmpeg foi executado, descrito em `evidence/ffmpeg-seek-synthetic.json` a partir da raiz deste pacote.

## Objetivo e decisão de arquitetura

Reduzir o tempo até a primeira edição revisável e aumentar minutos de material processados por hora, sem piorar fidelidade semântica, alinhamento de palavras, integridade do arquivo ou trabalho de revisão humana.

Duas frentes independentes, apoiadas por instrumentação e coordenação comuns:

1. **Mídia:** evitar decodificação repetida, paralelizar apenas tarefas independentes, reutilizar análises e modelos carregados e retirar derivados de apresentação das dependências do áudio.
2. **Decisão:** regras locais e cache primeiro; Jev em tarefas textuais fechadas e validadas; provedor atual como alternativa para casos complexos. A rota rápida precisa dispensar uma chamada anterior, não simplesmente precedê-la.

Manter o editor web/local, CLI/MCP, WhisperX/alinhamento, motor de cortes e provedores existentes. Não fundir o Decupa com outro editor e não introduzir Redis/Kubernetes como condição para os primeiros ganhos.

## Evidências encontradas no código

Referências são relativas ao repositório no commit acima. Elas comprovam comportamento estático, não o peso de cada etapa no tempo real da máquina do usuário.

| Fonte | Comportamento confirmado | Consequência a investigar |
|---|---|---|
| `apps/cli/src/app/assembly/model.ts`, `windowClip` | Um FFmpeg por janela, lendo a fonte original; `-ss` depois de `-i`. | Decodificação e descarte do início antes de alcançar janelas tardias. |
| `apps/cli/src/app/assembly/model.ts`, `describeSource` | Janela seguinte aguarda recorte, envio e resposta da anterior. | Tempos de rede acumulados no caminho crítico. |
| `apps/cli/src/app/assembly/visual.ts`, `visualWindows` | Janelas de 20 s com 1 s anterior de contexto. | Vídeo de 10 min gera 30 janelas; número calculado, não benchmark. |
| `apps/cli/src/triage.ts`, `runTriage` | `extractFrames` e `model.inspect` aguardados dentro do laço. | Inspeções independentes podem compartilhar limite de concorrência. |
| `apps/cli/src/app/assembly/preparation.ts`, `runPreparation` | `ensurePlayback` e `buildPeaks` são aguardados antes do laço de áudio. | A forma de onda está na sequência bloqueante apesar do comentário de best-effort. |
| `packages/transcript/src/transcribe.ts` e `services/speech/transcribe.py` | Novo processo por transcrição; carrega ASR e alinhador; padrões CPU/int8/small. | Inicialização repetida entre arquivos distintos de um lote. |
| `apps/cli/src/condense/run.ts` | Transcrição e detecção de silêncio aguardadas em sequência. | Possível sobreposição/reuso de áudio, somente com equivalência acústica verificada. |
| `services/vision/visual_index.py` | Cria landmarks por processo; Face/Hand em modo VIDEO e CPU. | Reuso possível, mas tracking temporal não pode vazar entre arquivos. |
| `apps/cli/src/app/assembly/analysis.ts` e `model.ts` | Chaves/envelopes usam `ZAI_DEFAULT_MODEL`. | Separar identidade efetiva do provedor de derivados independentes de LLM. |
| `apps/cli/src/app/assembly/render.ts` | Render cria diretório de trabalho novo e arquivo de referência por execução. | Cache de prévia por conteúdo da montagem, não só número de revisão. |

## Invariantes obrigatórios

- Node `>=22.6`, `pnpm@10.32.1`, TypeScript compatível com `--experimental-strip-types`.
- Preservar `verifyClaims`, `validateAssembly`, referências por IDs, `restated_by`, proteções, revisões e cobertura visual exigida.
- Não reduzir FPS/resolução de análise, trocar o modelo de fala ou pular alinhamento como otimização silenciosa.
- Jev recebe texto/estado estruturado; não recebe nem interpreta vídeo diretamente.
- Fonte original não é alterada. Exportação final continua referenciando originais.
- Ausência de evidência é “não avaliado”/lacuna, nunca aprovação nem cobertura completa.
- Nenhuma API paga é chamada por teste de CI. Consentimento específico antes de enviar texto a um provedor novo.
- Logs padrão não contêm transcrições, bytes de mídia, prompts completos, credenciais ou URLs autenticadas.
- Recurso compartilhado é limitado no host, não multiplicado por janela, fonte, projeto e processo.
- Resultados fora de ordem só entram no projeto por escritor único com revisão e identidade de execução conferidas.
- Cancelamento libera recursos; resultado antigo não reaplica edição nem publica prévia sobre revisão nova.

## Fronteiras de implementação

A infraestrutura e as otimizações sem mudança editorial podem ser liberadas antes do Jev. A interface do provedor rápido fica desligada por padrão até autorização e avaliação com material representativo. Isso é uma condição de liberação, não uma justificativa para atrasar o trabalho de mídia.

Não substituir `TriageModel` inteiro por um cliente TypeSafe. `structure`, `density`, `inspect` e `proposeScenes` possuem necessidades diferentes. Primeiro piloto: decisões de estrutura em fontes de fala simples do fluxo Limpar, com cobertura e qualidade avaliadas. Montar mantém a geração de cenas atual; recebe os ganhos de mídia/concor­rência. Densidade e escolha assistida podem ser promovidas separadamente.

## Coordenação de trabalho

Identidade de tarefa: mídia + parâmetros + versão de etapa; identidade de aplicação: projeto + revisão + execução. A primeira permite reaproveitar cálculo; a segunda impede aplicar resultado velho.

Separar recursos `ffmpeg`, `speech`, `vision`, `model`. Valores iniciais de teste: 1 processo pesado de fala, 1 de visão, até 2 FFmpeg e até 3 chamadas de modelo por host/provedor. Não são promessa de capacidade nem defaults universais: comparar com limite 1 e ajustar à RAM, disco e limites de API. Tarefa aguardando rede não deve segurar vaga de FFmpeg.

Dentro de um processo, usar fila limitada e single-flight por chave. Entre processos CLI/MCP, adotar coordenador local único antes de anunciar limite global. Proibir multiplicação de pools privados. Persistir tarefas e artefatos para retomada; projetos não compartilham dados entre usuários ou áreas de trabalho sem configuração explícita.

## Cache e derivados

Armazenar mídia derivada por `sourceSha256 + finalidade + parâmetros + versão`. Separar áudio para ASR, amostras de visão, proxy de reprodução e exportação. Um vídeo de análise a 4 FPS não substitui reprodução normal nem mídia usada para alinhamento fino.

Cache de decisão inclui provedor, endpoint normalizado, modelo efetivo, versão de perguntas, versão de política, conteúdo/contexto e identidade da análise. Nunca incluir chave de API. Um alias mutável como `jev-latest` exige TTL/revalidação ou versão resolvida quando disponível.

Publicação: arquivo temporário exclusivo, validação, rename atômico. Single-flight e trava por artefato previnem corrida; referência de consumidores impede remoção enquanto alguém usa o arquivo. Cache de falha não pode virar sucesso permanente.

## Qualidade e cobertura

Não retirar a barreira visual de `runPreparation` para simular aceleração. A preparação de fontes pode ocorrer em paralelo; a proposta aguarda as etapas realmente obrigatórias. Waveform/miniatura podem chegar depois. Rascunho textual sem análise visual deve ter estado e nome distintos de montagem validada.

Preservar o piso de qualidade acústica existente. Comparar fronteiras de palavras com referência humana independente, não com a saída do próprio alinhador. Para Jev, avaliar remoções incorretas, remoções omitidas, condições/negações/números/proteções e retrabalho humano; concordar com a LLM antiga não é verdade de referência.

## Medição e liberação

Métricas: tempo até transcrição utilizável, primeira prévia revisável, exportação final, fila versus execução, p50/p95, minutos de origem por hora, pico de memória, contagem de FFmpeg/chamadas/model loads, taxa de reaproveitamento, falhas/retries e tempo humano até aprovação. Não somar spans paralelos para calcular duração total.

Cenários: primeira execução após instalação, execução com modelos carregados mas mídia inédita, repetição da mesma mídia, pequena alteração de edição e lote. Informar downloads iniciais separadamente.

Metas iniciais de engenharia, NÃO resultados medidos: reduzir em 30% o tempo mediano até a edição revisável no corpus/hardware acordados; buscar pelo menos 2× a vazão em lote onde o baseline mostra recursos ociosos; não aceitar aumento de p95 superior a 10% sem análise; nenhuma nova regressão de sentido no conjunto crítico. Reestimar metas após o baseline, não transformar números em promessa comercial.

Jev só promove uma categoria após reduzir tempo total da rota e preservar o padrão editorial na amostra retida. Se `T_jev + taxa_fallback × T_llm >= T_llm`, a rota não acelera e deve ser desativada/reprojetada. Avaliar também chamadas evitadas, e não apenas duração da chamada rápida.

## Fontes externas verificadas em 17/09/2026

- FFmpeg, opções `-ss` e `-accurate_seek`: `https://ffmpeg.org/ffmpeg.html`. Em transcodificação, seek de entrada com accurate_seek descarta a região entre ponto de busca e alvo; stream copy tem outra semântica. Validar CFR/VFR/PTS/rotação nos formatos do produto.
- TypeSafe, estado: `https://docs.typesafe.ai/concepts/state`. Texto/JSON, não imagem/áudio/vídeo.
- TypeSafe, API: `https://docs.typesafe.ai/api`. Contrato próprio, perguntas tipadas e erros 401/422/429/529.
- TypeSafe, quickstart: `https://docs.typesafe.ai/introduction/quickstart`. Endpoint `/v1/systemone`, `state`, `questions`, `answers`.
- WhisperX oficial: `https://github.com/m-bain/whisperX`. Reutilizar interfaces de modelo/alinhamento e verificar backend/dispositivo na versão instalada; não presumir aceleração Metal/MPS.

## Não realizado nesta entrega

Não houve alteração de código no GitHub, teste completo do aplicativo, acesso ao hardware do usuário, benchmark com seus vídeos ou chamada ao Jev. A clonagem no ambiente de execução falhou por resolução de rede; o código foi inspecionado pelo conector GitHub. O experimento de FFmpeg é local, sintético e independente do aplicativo.
