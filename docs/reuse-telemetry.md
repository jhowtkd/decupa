# Telemetria de reuso (F4-T7)

Execute na mesma Raiz de Projetos usada pelo servidor:

```sh
pnpm decupa reuse-report --projects-root /pasta/dos/projetos
```

O comando só lê `<projeto>/.decupa/metrics/*.jsonl` dos diretórios diretos dessa raiz. Não abre o editor, chama modelos, altera caches nem poda journals. A coleta vem das preparações executadas depois desta versão; não reconstrói histórico anterior.

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

`estimatedSavingsMs` é um piso de trabalho duplicado entre os builds observados. A coleta atual deixa fora as análises automáticas ao adicionar mídia ou trocar seu papel para fala, POST analyze, GET playback fora da preparação e análise de templates. Nesses fluxos, a preparação posterior pode observar apenas hits: `opportunitiesWithoutBuild` expõe essa falta de observação, sem inventar tempos. Completar a coleta nesses caminhos requer decisão de alcance antes de usar o resumo para priorizar a P6.

Journals são uma amostra do histórico disponível, sujeita à retenção e a operações em curso. Diretórios/journals symlinkados não são seguidos. `unreadableJournals` também conta diretórios de métricas que não puderam ser listados. P6 (reuso efetivo) e F5 continuam condicionadas a decisão posterior.
