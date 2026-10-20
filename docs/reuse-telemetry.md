# Telemetria de reuso (F4-T7)

Execute na mesma Raiz de Projetos usada pelo servidor:

```sh
pnpm decupa reuse-report --projects-root /pasta/dos/projetos
```

O comando só lê `<projeto>/.decupa/metrics/*.jsonl` dos diretórios diretos dessa raiz. Não abre o editor, chama modelos, altera caches nem poda journals. A coleta cobre preparações, ASR automático ao adicionar mídia ou trocar o papel para fala, POST analyze, GET playback e análise necessária à proposta de template. Não reconstrói histórico anterior à instrumentação de cada caminho (F4-T7 e F4-T7-F1).

Os eventos `cache` de análise, visão e proxy acrescentam `sha256`, `configKey` e `durationMs` ao envelope existente. A chave é um SHA256 de configuração/versão, sem caminhos, prompt, endpoint, transcrição ou pedido da pessoa. Análise usa a chave do cache `analysis-v2`; visão usa identidade efetiva do cliente, versão e janela; proxy usa o contrato de reprodução H.264/AAC, yuv420p, largura máxima 960 e política de encode com fallback em software. Encoders diferentes que entregam esse mesmo contrato são comparáveis; a chave não promete bytes idênticos.

Visão sem identidade de modelo/provedor emite `configKey: null`, pois não há configuração segura para comparar. Falha de análise antes de obter a chave também emite identidade desconhecida. Esses eventos são ignorados pelo resumo, assim como caches antigos sem hash/chave, prévias e eventos genéricos do coordenador. Desde F4-T1, `hit-or-shared` inclui seguidores de uma execução single-flight viva; não representa um novo build.

O JSON de saída contém grupos por `stage + sha256 + configKey` (uma janela é um derivado visual). `projects` conta projetos distintos com sucesso, `builds` conta builds observados, `hits` inclui `hit-or-shared` e `errors` não gera oportunidade. Não expõe nomes ou caminhos de projetos.

| Campo | Interpretação |
| --- | --- |
| `reusableDerivatives` | Grupos com sucesso em pelo menos dois projetos |
| `reuseOpportunities` | Soma de `projects - 1` por grupo, sem valores negativos |
| `redundantBuilds` | Primeiro build observado em cada projeto adicional, excluindo o primeiro projeto com sucesso pela ordem de `atMs` |
| `estimatedSavingsMs` | Soma das durações medidas desses builds redundantes |
| `unmeasuredBuilds` (por grupo e no total) | Builds redundantes sem duração válida; não recebem duração inventada |
| `opportunitiesWithoutBuild` | Projetos adicionais com sucesso, mas sem build observado; a ausência de tempo não comprova economia zero |
| `byStage` | Totais separados de análise, proxy e visão; janelas visuais e fontes são unidades diferentes |
| `ignoredCacheEvents` | Cache sem identidade comparável, sem timestamp válido ou não aplicável |
| `malformedLines` / `unreadableJournals` | Linhas truncadas/inválidas e leituras que falharam, inclusive por limpeza concorrente |

Dois projetos com o mesmo derivado, builds de 900 ms e 1.200 ms nessa ordem: **1 derivado reaproveitável, 1 oportunidade e 1.200 ms estimados**. Hits locais e reconstruções repetidas dentro do mesmo projeto não somam economia entre projetos. Um hit em outro projeto comprova oportunidade, mas não recebe tempo de build inventado.

As durações de build excluem a espera pelo slot pesado inicial da análise; na visão somam extração, requests e publicação dentro dos respectivos slots, sem filas dos pools ou coordenador. O proxy mede dentro do slot de encode. O total visual de parede permanece disponível no evento `visual`, separado do tempo de trabalho em `cache`. Somar trabalho não prevê a redução do tempo total de um lote com etapas paralelas.

`estimatedSavingsMs` é um piso de trabalho duplicado entre os builds observados. Cada análise ou preparação abre e fecha seu próprio journal, inclusive após falha/cancelamento. O playback abre um journal por requisição HTTP, inclusive Range e seeks, e inicia o fechamento assim que a verificação/build do proxy termina; a conexão de vídeo aberta não mantém a amostragem de recursos. Os hits puros continuam registrados. Um build automático seguido de preparação fica registrado como build e depois hit; hits não ganham tempo de build inventado. `opportunitiesWithoutBuild` continua indicando histórico incompleto, por exemplo caches anteriores à coleta ou journals já expirados.

A biblioteca de templates também coleta análise e visão em `<raiz-templates>/<receita>/.decupa/metrics`. Os caches externos `speech.json` e `visual.json` emitem hits sem repetir os eventos dos builds internos; a visão usa as mesmas chaves por janela da preparação. Para resumir essa biblioteca, execute `pnpm decupa reuse-report --projects-root <raiz-templates>` (a raiz padrão é `~/.decupa/templates`). A biblioteca e a Raiz de Projetos são escopos de leitura separados; o comando não percorre automaticamente outras raízes. Um callback visual injetado sem identidade observável gera chave nula e não entra na estimativa.

Journals são uma amostra do histórico disponível, sujeita à retenção e a operações em curso. Diretórios/journals symlinkados não são seguidos. `unreadableJournals` também conta diretórios de métricas que não puderam ser listados. P6 (reuso efetivo) e F5 continuam condicionadas a decisão posterior.
