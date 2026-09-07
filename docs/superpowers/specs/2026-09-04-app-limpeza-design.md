# App de limpeza de fala — design

Data: 2026-09-04
Estado: aprovado, aguardando plano de implementação

## O que é

Uma página local onde você aponta um vídeo, lê o corte como prosa corrida,
desliga o que não quer, e exporta.

O produto **não é um editor de vídeo**. É uma tela de leitura. Essa distinção
foi cara de descobrir e é o que define todo o resto: o único passo do
procedimento de limpeza que não pode ser automatizado é ler o roteiro
condensado inteiro e perceber que uma junção não soa como gente falando. Todo
o resto — transcrever, medir, planejar, renderizar, verificar — já é comando.
O app existe para dar uma superfície boa àquele passo, não para reimplementar
os outros.

## Por que não o OpenCut

A ideia original era usar o OpenCut como base do editor web. Descartada: o
repositório está arquivado, 73 dos 81 arquivos de código são componentes
shadcn/ui, e — decisivo — ele é um editor de timeline. A decisão que esta
ferramenta pede é sobre **texto**, não sobre tempo. Adotar uma casca de
timeline seria brigar com a forma dela em cada tela.

## Forma

Servidor `node:http` dentro de `apps/cli`, servindo uma página sem build step.
Segue o padrão que `apps/cli/src/mark-web/server.ts` já estabeleceu no repo
(200 linhas, `createServer`, `page.html` servido como string).

Não usa framework de front-end. A UI é uma página com uma lista de trechos;
React compraria componentização que este escopo não precisa e cobraria um
passo de build que atrapalha o "instala e roda".

```
navegador ──HTTP──> apps/cli/src/app/server.ts
                          │
                          ├─> pipeline.ts ──> pnpm decupa condense-prep   (WhisperX)
                          │                ──> scripts/condense.py index
                          │                ──> scripts/condense.py plan
                          │                ──> scripts/condense.py render|qc
                          │                ──> decupa triage (opcional)
                          └─> jobs.ts (estado em memória)
```

## A tela

Uma página, dois estados — processando e revisando. A tela de escolher arquivo,
que pareceria óbvia, não existe.

**0. Escolher o vídeo — fora da página.** O vídeo entra pela linha de comando:

```bash
decupa limpar --input <vídeo> [--port 7788]
```

O servidor sobe, imprime a URL e abre o navegador. Mesma forma de
`decupa mark --web`.

Isso não é preguiça de fazer uma tela de seleção: **`<input type="file">` não
entrega caminho de arquivo ao JavaScript**, por design do navegador. Um app que
escolhesse o vídeo pela página teria que recebê-lo por upload — e upload de
material de cliente para um servidor, ainda que local, é exatamente o que a
decisão de rodar na máquina de cada um existe para evitar. Deixar isso
implícito faria o implementador "resolver" com upload.

**2. Processando.** Barra com o estágio atual (transcrevendo / medindo /
planejando). A transcrição leva minutos; sem estágio nomeado, o usuário não
sabe se travou.

**3. Revisar.** O corte como **prosa corrida**, não como lista. Cada unidade é
um trecho de texto com um X discreto.

Clicar remove a unidade do fluxo: ela **colapsa** para um marcador fino no
lugar, e o texto vizinho se fecha em volta. A prosa que resta é a prosa que vai
ao ar, lida sem ruído — que é o ponto inteiro da tela. Riscar e manter o texto
visível seria o oposto: você continuaria lendo o corte antigo.

**O marcador carrega identidade.** Ele mostra as primeiras palavras da unidade
e o texto inteiro no hover, e clicar restaura. Um marcador anônimo não serve:
num corte real saem de 8 a 15 unidades, e achar qual restaurar entre marcadores
idênticos vira caça ao tesouro. O custo disso não é irritação, é
comportamental — a pessoa para de colapsar por medo de não achar de volta, e a
tela perde a razão de existir.

O que a página precisa para isso não é o `condense_script.md` renderizado, e
sim dado estruturado: cada unidade com `id`, texto, se está mantida, e onde
caem as junções com seus avisos. Isso se monta cruzando os `clips` do plano
(que trazem `unit_ids`) com as `units` do índice (que trazem o texto).

Isso é a tradução literal do passo 5 do procedimento — e a razão de ser prosa e
não cartões está medida: numa sessão real, um corte revisado pela tabela de
flags deixou passar dez segundos de pré-rolo, e só a leitura contínua revelou
um bloco de gagueira que nenhum flag indicava. Cartões com metadados
reproduziriam o formato que falhou.

Um botão **"sugerir cortes"** chama a triagem. Sem chave de API o botão explica
isso e some do caminho; o app inteiro funciona sem ele, porque montar o
keep-list clicando é barato. Triagem é acelerador, não pré-requisito.

A sugestão entra como **prévia, não como aplicação muda**: mostra quantas
unidades cairiam e quais, com o motivo que o modelo deu, e você aceita ou
descarta. O keep-list da triagem é ponto de partida do julgamento, não veredito
— e as notas do modelo confabulam detalhe quando ele não entende a unidade
(medido: classificou um aparte corretamente e inventou o assunto, diferente em
cada rodada). Aplicar em silêncio esconderia exatamente o que precisa ser lido.

## O loop de revisão

Clique **não** dispara `condense_plan`. Ele muda estado local: a unidade sai da
prosa na hora, sem ida ao servidor.

O re-plano acontece com **debounce de 250 ms** depois do último clique, e
atualiza `joins`, `outputSeconds` e os avisos. Isso é possível porque
`condense_plan` custa pouco — medido em 0,174 s no material de referência (42
unidades, 4 minutos), contra 2,455 s do índice, que roda uma vez só. Se em
material bem maior o plano passar de ~1 s, o debounce degrada para um botão
"atualizar junções"; a decisão foi medida, não estipulada.

Isso importa porque **os avisos de junção pertencem ao corte atual**. Um
`mid_thought_out` calculado com o keep-list antigo aponta para uma junção que
não existe mais — pior que não mostrar nada, porque parece informação.

**Exportar sempre re-planeja antes**, ignorando o debounce. Nenhum arquivo sai
de um plano que não corresponde ao que está na tela.

## Servidor e job

| Rota | O quê |
|---|---|
| `GET /` | a página |
| `POST /jobs` | `{videoPath}` → `{jobId}`; começa transcrição→índice→plano |
| `GET /jobs/:id` | `{stage, error?, review?}` — a página faz polling |
| `POST /jobs/:id/keep` | `{keepList}` → re-planeja, devolve o `review` novo |
| `POST /jobs/:id/triage` | roda a triagem, devolve keep-list sugerido + motivos, para prévia |
| `POST /jobs/:id/export` | `{kind: "mp4"\|"edl"\|"transcript"}` → `{downloadUrl, path}` |
| `GET /jobs/:id/download/:kind` | serve o arquivo exportado |
| `POST /jobs/:id/cancel` | mata o processo em andamento |

`keepList` no corpo do `POST /keep` é **a mesma string que o `--keep` do motor
consome** (`"u001-u003 u005-u022"`), não um array. Uma borda, um formato: o
servidor repassa sem traduzir, e o que a tela produz é o que o comando aceita.

`export` devolve URL de download além do caminho. Terminar num JSON com um path
absoluto obrigaria a pessoa a sair do navegador e ir procurar no Finder, e o
app inteiro existe para não fazer isso.

`cancel` existe porque a transcrição leva minutos: apontar o arquivo errado sem
poder desistir transforma um erro de digitação em espera forçada.

Um job por vez, estado em memória, sem banco e sem fila. É app local de um
usuário; persistência e concorrência seriam complexidade sem cliente. Reiniciar
o servidor perde o job em andamento — aceitável, porque re-rodar é barato
depois que a transcrição está em cache no disco do motor.

O servidor **não** reimplementa nenhuma etapa: ele invoca os mesmos comandos do
SKILL.md, com os mesmos parâmetros — incluindo `--drop-fillers hard` no plano,
que é o default da skill.

**O app cobre os passos 1 a 6 da skill.** Os passos 7 (QC) e 8 (entregar) ficam
de fora do v1: o QC audita o MP4 renderizado e gera evidência visual das
junções, e a saída principal aqui é o EDL, onde quem ajusta continuidade é o
editor na ferramenta dele. Dentro desses seis passos, se o app e o
procedimento manual divergirem, é bug do app.

Duas etapas do procedimento que o app **tem** que fazer, e que não aparecem
como comando no SKILL porque lá são preparação:

- **Proxy de triagem.** A skill é explícita: mandar o vídeo original quebra
  (11,2 MB viram 14,9 MB em base64 e voltam como erro genérico do provedor).
  O pipeline gera o proxy a `fps=1,scale=270:480` antes de chamar a triagem.
- **Diretório de trabalho por job.** O motor grava `out/` e `.video_agent/` no
  cwd, ou em `CLAUDE_PROJECT_DIR`. Sem um diretório por vídeo, dois trabalhos
  no mesmo cwd se sobrescrevem — e a afirmação de que "re-rodar é barato porque
  a transcrição está em cache" fica sem endereço. Cada job recebe o seu.

## As três saídas

- **MP4** — `condense.py render`. Zero código novo.
- **Transcrição limpa** — o motor já grava `condensed_transcript.json`; o app
  serve como texto.
- **EDL** — o único código novo. Formato CMX3600, que Premiere e DaVinci
  importam sem plugin. Sai dos `clips` que o plano já produz, que já trazem
  `start`/`end` em segundos de fonte. Precisa do frame rate (via `ffprobe`) para
  converter segundos em timecode.

  **Escopo do v1, deliberadamente estreito:** frame rate inteiro, um canal de
  vídeo, non-drop-frame, um reel só, verificado no DaVinci Resolve. Drop-frame
  29,97, faixas de áudio separadas e as manias de importação do Premiere são um
  projeto próprio — deixar isso em aberto faria o EDL virar um segundo projeto
  no meio do primeiro. Se o material for 29,97, o v1 avisa em vez de gerar
  timecode errado em silêncio.

O EDL é provavelmente o mais valioso dos três: entrega os cortes na timeline da
ferramenta onde o editor já trabalha, com o material original intacto, em vez de
um MP4 que ninguém consegue mais ajustar.

## Decomposição

| Arquivo | Responsabilidade |
|---|---|
| `apps/cli/src/app/edl.ts` | clips + fps → texto CMX3600. Puro. |
| `apps/cli/src/app/review.ts` | plano + índice → o `review` que a página consome. Puro. |
| `apps/cli/src/app/jobs.ts` | máquina de estados do job. Pura. |
| `apps/cli/src/app/pipeline.ts` | invoca os comandos, traduz saída em estágio |
| `apps/cli/src/app/server.ts` | rotas |
| `apps/cli/src/app/page.html` | a página |

O formato do `review`:

```ts
interface Review {
  units: { id: string; text: string; kept: boolean; start: number; end: number }[];
  joins: {
    afterUnitId: string;          // plan.joins[].outgoing_unit
    incomingUnitId: string;
    removedSeconds: number;
    outgoingTail: string;         // as últimas palavras antes do corte
    incomingHead: string;         // as primeiras depois
    sourceOut: number;            // plan.joins[].source_out — player da junção
    sourceIn: number;
    flags: { code: string; severity: string; message: string; hint: string }[];
  }[];
  outputSeconds: number;
  sourceSeconds: number;
}
```

`units` vem em ordem de fonte e inclui as dropadas — é o que permite restaurar
sem re-planejar.

`flags` são **objetos, não strings**: o plano emite `{code, severity, message,
hint}`, e o `hint` é o que diz o que fazer a respeito. Achatar para string
jogaria fora a única parte acionável.

`outgoingTail` e `incomingHead` vêm prontos do plano e são literalmente as
palavras dos dois lados da junção (`"do terno numa praia, né?"` ┃ `"Dessa
forma, não escala"`). São eles que fazem o aviso aparecer *onde dá para
julgá-lo*, em vez de numa lista à parte que ninguém lê.

As três primeiras são função pura e carregam os testes. `pipeline.ts` recebe um
executor injetável, então testa sem rodar WhisperX.

## Erros

| Situação | Comportamento |
|---|---|
| arquivo não existe | erro na tela antes de começar o job |
| `ffmpeg`/`ffprobe` ausente | diz qual falta e como instalar |
| sidecar de fala fora do ar | diz isso, não "falhou" |
| motor de condense ausente | diz que `VE_PLUGIN_ROOT` não aponta pra nada |
| etapa do motor sai != 0 | mostra a saída dela, não uma mensagem genérica |
| sem chave de triagem | o botão explica; o resto do app segue |

Nenhuma etapa falha em silêncio devolvendo resultado vazio. Foi o modo de falha
que a triagem já expôs: resposta vazia lida como "nada a cortar" é
indistinguível de análise que rodou e não achou problema.

## Som na revisão

A tela continua validando **texto** em primeiro lugar. Ler a prosa pega frase
truncada, pré-rolo, bloco de gagueira e referência órfã. Respiração cortada,
salto de ruído de sala e mudança de altura de voz numa junção só aparecem
ouvindo.

Por isso a página serve o arquivo de entrada em `GET /media` e oferece um
player pontual: ouvir o trecho no hover, e ouvir a junção (~0,7 s antes do
`source_out` e ~0,7 s depois do `source_in`). O vídeo não ganha coluna. Quem
exporta MP4 ainda pode rodar `condense.py qc`; quem exporta EDL ainda ouve no
Premiere ou no Resolve, onde vai ajustar de qualquer forma.

## Fora do escopo do v1

Múltiplos vídeos, projeto salvo em disco, desfazer, ajuste de corte quadro a
quadro, b-roll, legenda, montagem. Nada disso é o passe de limpeza de fala, que
é o que este app faz.

## Dívida conhecida, deliberada

O motor de condense mora em `work/video-agent-kit-plugin`, **que está no
gitignore**. Funciona para quem já tem o clone; não funciona para "instala via
pacote". No v1 ele é pré-requisito documentado, ao lado do `ffmpeg` e do
sidecar de fala.

Empacotar o motor de verdade é projeto próprio, e a ordem certa é fazê-lo
quando alguém além do autor for instalar — construir distribuição para uma
ferramenta que ainda não se provou em mais de um vídeo seria a ordem inversa.
