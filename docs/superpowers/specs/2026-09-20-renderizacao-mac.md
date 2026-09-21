# Renderização local sem saturar o Mac

## Objetivo
Corrigir o caminho de renderização do Decupa para aproveitar VideoToolbox e limitar recursos, preservando edição, arquivos originais e contrato de aprovação. O travamento foi relatado pelo usuário; não há medição contemporânea que identifique CPU, memória ou swap como causa exclusiva.

## Evidência do código
- `render.ts` pede detecção de hardware e transmite encoder/hwaccel ao adaptador Python.
- `hardware.ts` coloca `-hwaccel` depois de `-i` no teste de detecção, embora seja opção de entrada; exige áudio para aprovar vídeo, descartando clipes silenciosos.
- O motor `work/video-agent-kit-plugin/mcp/ve_tools/render.py` ignora os parâmetros de aceleração recebidos e fixa libx264.
- `build_project_ffmpeg_command` abre uma entrada para cada clipe e compõe todos por uma cadeia de overlays, inclusive os temporalmente sequenciais.
- `media.ts` cria até dois proxies em paralelo por software; a renderização usa originais.
- `export.ts` copia exatamente a prévia aprovada. Não existe uma etapa independente de master 4K.
- O motor é outro checkout, com modificações locais em render.py, condense.py e condense_lang.py. Preservar essas alterações; distribuir a correção por patch versionado, como scripts/engine/assembly-frame-boundaries.patch.

## Requisitos e limites globais
- Sem dependências novas, serviços externos ou chamadas pagas.
- Preservar originais, WIP, análises, cortes, revisão e aprovação.
- Exportar exatamente o MP4 assistido e aprovado; OTIO continua referenciando originais.
- Manter resolução e FPS do canvas atual; não prometer exportação 4K se o canvas for 720p.
- Um processo pesado de mídia por vez dentro do servidor Decupa; duas threads por decoder/encoder de software e uma thread de filtros.
- Composição em trechos de no máximo 5 segundos, processados sequencialmente; no máximo duas entradas de vídeo simultâneas no contrato V1/V2 atual.
- VideoToolbox só pode ser declarado ativo após encode real bem-sucedido; fallback software deve ser explícito e limitado.
- Não executar a montagem completa do usuário como primeiro teste.

## Desenho
Corrigir primeiro a seleção e propagação de hardware. Substituir a composição de toda a timeline pelo processamento sequencial de intervalos separados pelas bordas de V1/V2, subdivididos em até 5s. Reutilizar o compositor existente em cada intervalo, com timestamps locais e somente os clipes ativos. Concatenar vídeos normalizados e fazer o áudio global uma vez, preservando mixagem e sincronismo. Não manter uma segunda implementação completa de composição.

Proxies existentes ficam para reprodução da fonte e recebem limites de recursos. Não substituir originais por proxies com perdas no MP4 aprovado. Um modo separado de edição com proxies e render final exigiria outro contrato de revisão, portanto fica fora deste plano.

## Aceite
Comandos reais demonstram o encoder escolhido, limites e entradas limitadas. Resultado mantém frames de corte, orientação, duração, V2 e áudio; cancelamento encerra descendentes e deixa o último artefato válido. Executar primeiro fixture sintética curta, depois amostra de 10s de uma cópia do projeto. Registrar wall time, pico agregado de RSS dos descendentes, CPU e swap antes/depois. Interromper a amostra se RSS agregado passar de min(4 GiB, 25% da RAM física); este é limite do ensaio, não alegação de teto garantido em produção. Não executar benchmark deliberadamente sem limites para reproduzir o travamento. Só ampliar depois da amostra estável e interação do macOS responsiva, confirmada pelo usuário.
