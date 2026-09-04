---
name: limpar-fala
description: Remove gagueira, cacoete e repetição de vídeo falado em PT-BR, mantendo a fala soando natural. Use quando o pedido for para "limpar", "cortar cacoete/gagueira", "deixar mais direto" ou "tirar os erres" de uma gravação de fala — entrevista, aula, talking-head, vídeo institucional. Não use para montagem de múltiplos materiais, legendagem sem corte, ou conteúdo majoritariamente em outro idioma (o léxico de disfluência é PT-BR; inglês/chinês funcionam nativamente no motor, mas sem o ajuste feito aqui).
---

# Limpar Fala

Você é quem toma a decisão editorial — o motor mede e corta, você decide o
quê. Este documento assume zero contexto além do que está escrito aqui.

## Pré-requisitos

- `VE_PLUGIN_ROOT` apontando pro clone de `jhowtkd/video-agent-kit-plugin`
  com o patch de léxico PT-BR aplicado (`condense_lang.py` com
  `FILLERS_HARD_PT`/`FILLERS_SOFT_PT`/etc.). Se não estiver setado, o default
  é `work/video-agent-kit-plugin` na raiz deste repo.
- O sidecar de fala do Decupa configurado (`services/speech`, ver seu
  próprio README) — é o WhisperX que gera a transcrição com tempo por
  palavra.
- `ffmpeg`/`ffprobe` no PATH.

Os comandos do procedimento (`pnpm decupa`, `python3 scripts/condense.py`)
partem da **raiz deste repo**. O motor grava `out/` e `.video_agent/` no cwd,
ou em `CLAUDE_PROJECT_DIR` se estiver setado. Para isolar um trabalho numa
pasta (ex. `work/meu-corte`) sem poluir a raiz, exporte o caminho absoluto
dessa pasta em `CLAUDE_PROJECT_DIR` e rode os comandos da raiz.

## O procedimento

### 1. Transcrever

```bash
pnpm decupa condense-prep --input <video ou wav> --out <pasta>/transcript.json
```

Isso roda o WhisperX do Decupa e já grava no formato que o motor espera.
Guarde o caminho de saída — as próximas etapas precisam dele.

### 2. Medir (`condense_index`)

```bash
python3 scripts/condense.py index <video> <pasta>/transcript.json
```

Leia o relatório inteiro, não só o resumo. Ele imprime uma tabela
`u001`–`uNNN` com flags por unidade:

| Flag | Significa |
|---|---|
| `D` | repetição quase-verbatim de uma unidade anterior |
| `F` | hesitação/gagueira dentro da unidade (já mecanicamente seguro de cortar) |
| `s` | soft filler — **sua decisão**, não corta sozinho |
| `Q` | é uma pergunta |
| `C` | abre com conectivo que aponta pra trás ("então", "mas", "e") |
| `A` | contém referência a algo dito antes ("isso", "esse") |
| `1`/`2` | abre/continua uma enumeração |
| `!` | **sem pontuação final — cortar logo depois desta unidade provavelmente corta no meio do pensamento** |
| `V` | referencia algo na tela ("olha aqui") — cortar perde o que foi mostrado |
| `x` | mais curta que o clipe mínimo — provavelmente interjeição, não decisão que vale a pena |

A seção BUDGET no relatório já diz quanto dá pra cortar só com tightening de
pausa e remoção de hesitação, sem tocar em conteúdo nenhum — leia antes de
decidir o quanto cortar.

### 2b. Triar (opcional, precisa de `GEMINI_API_KEY`)

```bash
pnpm decupa triage --index <pasta>/out/speech_index.json --video <vídeo> --out <pasta>/out
```

Devolve um keep-list proposto e `out/triage.md` com o que foi dropado, por
quê, e **quais alegações do modelo foram rejeitadas por não conferirem com o
índice**. Leia as rejeitadas: elas dizem onde o modelo estava errado, o que é
o melhor sinal que existe de que ele pode estar errado em outro lugar também.

O keep-list que sai daqui é ponto de partida do passo 3, não substituto dele.
A verificação rejeita alegação impossível; ela não certifica alegação correta.
Um pré-rolo grande demais que engula a frase de abertura passa na verificação
e só aparece na leitura da prosa, no passo 5.

### 3. Decidir o que fica (você, não o motor)

Monte ou ajuste a lista de unidades a manter (`keep`), como faixas: `u001-u003
u005-u022`. Regras que valem sempre:

- **Nunca termine um clipe numa unidade flagada `!`** sem checar o que vem
  depois — é exatamente onde um corte lê como frase truncada.
- Soft filler (`s`) é candidato, não veredito. Leia a unidade inteira antes
  de decidir se o "tipo"/"né"/"então" ali é cacoete ou conteúdo.
- Se dropar uma unidade, confira se a unidade seguinte abre com `C` ou `A` —
  se abrir, ela provavelmente está se referindo a algo que você acabou de
  cortar.

### 4. Planejar (`condense_plan`)

```bash
python3 scripts/condense.py plan <video> --keep u001-u003 u005-u022 --drop-fillers hard
```

`--drop-fillers hard` remove só a categoria mecanicamente segura (gagueira e
hesitação), nunca soft filler. Não use `aggressive` sem ter lido cada soft
filler que ele afetaria — `aggressive` corta soft filler marcado como
"standalone" automaticamente, e isso é decisão editorial, não mecânica.

### 5. **Ler `condense_script.md` inteiro, em voz alta ou não, antes de seguir**

Isso não é opcional e não é burocracia. Nesta mesma sessão, um corte que
parecia limpo pela tabela de flags (dropar uma unidade marcada `s`/`C`/`A`)
foi sinalizado pelo próprio `condense_plan` como `mid_thought_out`: a unidade
anterior não tinha pontuação final, e o corte lia como frase truncada. Só a
leitura da prosa contínua — não a tabela, não os flags — revelou o problema.

O arquivo fica em `out/condense_script.md`, na pasta de onde você rodou o
comando. Se alguma junção não soar como uma pessoa falando, **volte pro passo
3 e ajuste o keep-list** — não segue pro render torcendo pra dar certo.

### 6. Renderizar

```bash
python3 scripts/condense.py render <video> <saída.mp4>
```

Um encode bem-sucedido só prova que o filtro rodou. Não prova que o corte
soa como gente falando — isso é o próximo passo.

### 7. Verificar (`condense_qc`)

```bash
python3 scripts/condense.py qc <saída.mp4>
```

Isso audita o **arquivo renderizado**, não o plano. Gera duas imagens de
evidência (`join_frames.jpg`, `join_waveforms.png`) em
`.video_agent/condense_qc/<stem>/` — `<stem>` é o nome do mp4 sem extensão,
não ao lado do arquivo renderizado. **Abra as duas e olhe** antes de declarar
pronto. `QC PASS` na saída de texto não substitui olhar a
imagem: o relatório classifica o salto visual em cada corte como
subtle/visible/severe, mas só a imagem mostra se aquele "subtle" ainda
incomoda pra este material específico.

### 8. Entregar

Mande pro usuário o vídeo renderizado **e** as duas imagens de evidência —
não só o vídeo. A pessoa do outro lado não tem como confiar num "ficou bom"
sem ver o que você viu.

## O que esta skill não faz

Multi-material, montagem, geração de B-roll, legenda, tradução — o motor tem
outras skills próprias pra isso (`video-edit-assembly`,
`video-speech-workflows/talking-head-subtitles`). Esta skill é só o passe de
limpeza de fala.
