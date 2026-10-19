# Plataformas suportadas e cobertura de CI

O alvo de certificação do servidor é **Linux, Ubuntu 24.04, na VPS/Docker**.
O workflow ordinário [ci.yml](../.github/workflows/ci.yml) executa lint,
typecheck, smoke, a suíte JavaScript/TypeScript completa e os testes Python
com mocks em Linux, macOS e Windows a cada PR e push em `main`. Os testes
Python do render também rodam em Linux e macOS (dependem de `ps` e sinais
POSIX). A certificação exige o job correspondente verde; configurar um job
não é evidência de aprovação.

| Ambiente | Estatuto | Cobertura e pendências |
| --- | --- | --- |
| Linux / Ubuntu 24.04 | Alvo certificado do servidor VPS/Docker | Node 22 e FFmpeg do Ubuntu, mesma base do Dockerfile. A suíte ordinária inclui sincronismo AV, Drive/R2 e sidecars com mocks. Cada run registra as versões efetivas de Node, pnpm, Python, FFmpeg e ffprobe no log e no resumo do job. |
| macOS | Uso local, com pendência conhecida | Mantém o job completo. O aceite histórico do setup está no [guia](setup/GUIA.md#6-situação-por-plataforma). A fila de preparação falhou no SHA auditado; isso continua pendente, sem diagnóstico de causa e sem dispensa do teste. |
| Windows nativo | Uso local ainda não homologado | Mantém o job completo. Drive/R2 e o caminho funcional do sidecar de fala não estão certificados até correção e revalidação das falhas abaixo. |
| WSL2 | Avaliação sem homologação própria | O job Linux não certifica integração de caminhos, Python ou Resolve com o host Windows. Ver os limites no [guia de setup](setup/GUIA.md#6-situação-por-plataforma). |

O CI básico usa fixtures FFmpeg/lavfi e mocks de fala/visão, sem credenciais
reais nem download de modelos. O gold do motor se pula se o motor não estiver
instalado; os testes de render preparam o bundle offline em etapa posterior.
Isso não certifica inferência real, aceleração GPU/VideoToolbox nem integração
com Resolve. O [workflow Docker](../.github/workflows/docker.yml) mantém o smoke
do compose CPU e o build CUDA próprios; execução real em GPU requer a prova
descrita na [implantação](implantacao-docker.md).

## Triagem da referência auditada

O [run 39031838718](https://github.com/jhowtkd/decupa/actions/runs/39031838718)
testou `22bfd8a1e823fd026d91b4d07f931c82ee1d054f` em 17/10/2026:

| Job | Falhas observadas | Tratamento |
| --- | --- | --- |
| macOS | 1 em `project-new-http.test.ts`: preparo não entrou na fila global | Pendência conhecida de preparação. Não foi demonstrado que seja exclusiva do macOS; se reproduzir no Linux, é falha do alvo de produção também. |
| Windows | 1 em `drive-upload.test.ts`, 6 em `r2-upload.test.ts`, 1 em `pipeline-sidecar.test.ts` | Lacunas de compatibilidade/certificação Windows. O resultado desse job sozinho não demonstra oito defeitos de produção na VPS. Drive/R2 e sidecar continuam obrigatórios e bloqueantes no job Linux. |

Não se removem testes, não se usa `continue-on-error` e não se relaxa a
tolerância AV para tornar um sistema verde. Falhas também reproduzidas no
Linux são tratadas como falhas do alvo suportado. Um job vermelho permanece
vermelho até correção; a triagem acima delimita a evidência e não o isenta.

## Sincronismo no corte duro

A fixture de flashes/bipes em `scripts/segment-timing.test.ts` mantém o limite
de **menos de um quadro a 30 fps (33,3333 ms)** e confere duração, quantidade
de eventos e desvio após 5 e 20 cortes. O teste negativo mantém o antigo
`make_zero`, que acrescentava folga a cada segmento.

O desvio de 45,1875 ms no SHA auditado ocorre na junção: os segmentos isolados
estão sincronizados, mas o decoder entrega blocos AAC completos além da duração
declarada (um trecho de 2,5 s entrega 2,517333 s de amostras). O concat demuxer
posiciona o próximo segmento pela duração declarada; recodificar áudio sem
compensar a sobreposição dos timestamps acumula amostras e desloca os bipes.
Com 20 cortes, a mesma fixture chegava a 237,375 ms.

`concat_copy.py` usa `aresample=async=1:first_pts=0:min_hard_comp=0.001` para
aparar/preencher amostras segundo os timestamps, mantendo vídeo por cópia.
`async=1` não altera velocidade/tom; o limiar de 1 ms corrige as diferenças
menores que um bloco AAC (~21 ms a 48 kHz), ignoradas pelo padrão de 100 ms.
`first_pts=0` trata o atraso inicial. Veja a semântica na
[documentação do resampler FFmpeg](https://ffmpeg.org/ffmpeg-resampler.html#Resampler-Options).
Na fixture medida com FFmpeg 6.1.1 e 7.0.2, o máximo passou a 19,3333 ms tanto
em 5 quanto em 20 cortes. Isso valida este caminho/fixture, sem prometer sincronismo
para qualquer codec, taxa de quadros ou exportação.
