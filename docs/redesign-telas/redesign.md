# Proposta de redesign · telas do decupa

Data: 2026-09-14 · Base: auditoria visual dos prints em `telas/` + jornada em
`fluxograma.md` + código (`apps/cli/src/app`, `apps/cli/src/mark-web`).

> Nota de método: o guia de gosto visual usado (design-taste-frontend) declara
> UI de produto denso fora do seu escopo central (ele mira landing/portfolio).
> Esta proposta usa dele o que se aplica a ferramenta de edição: auditoria
> antes de mexer, disciplina de tipografia e cor, consistência de tema,
> estados completos, contraste AA e caça a clichês de IA. Nada de receitas de
> landing page.

## Leitura de design (Design Read)

Redesign **overhaul visual** (a IA e os conceitos ficam; a linguagem visual é
refeita) de uma ferramenta de edição de vídeo para criadores solo, com uma
linguagem de **sala de corte escura**: superfície carvão quente, tipografia
confiante em três papéis, um único acento âmbar herdado do produto atual.
Sem framework: CSS nativo, mesmo stack do app.

**Dials:** VARIANCE 3 (grade previsível de ferramenta) · MOTION 2 (só feedback
de estado e transição de painel) · DENSITY 6 (cockpit legível).

**Por que overhaul e não preservação:** hoje são três linguagens diferentes
disfarçadas de produto (auditório abaixo). Não há marca visual a preservar
além do âmbar e do tom de voz do microcopy. O que se preserva é IA, conceitos,
atalhos e voz, não pixels.

## Auditoria do estado atual

| Tela | Tema | Tipo | Problemas centrais |
|---|---|---|---|
| Limpar (01, 02) | escuro, teal-carvão | prosa em serifa (Georgia) | 6 botões de mesmo peso no header; exportações misturadas com ações; stats enterrados; marcador de corte fraco; chips de trecho cortado ruidosos |
| Montar (03, 03b) | **claro** | sans de sistema | quebra de tema no meio do produto; botões apilhados (Excluir/Relink/Ver original); cenas sem ritmo; faixa (timeline) quase invisível; rótulos de fonte soltos no meio da prosa |
| Marcar (04) | escuro, mono | mono | a melhor das três; vídeo sem propósito evidente à esquerda; lista de marcas sem hierarquia |

Transversais:

1. **Quebra de Page Theme Lock**: limpar e marcar são escuros, montar é claro.
   O usuário atravessa um limiar de tema no meio do mesmo produto.
2. **Sem sistema de botões**: primário/secundário/perigo têm o mesmo peso em
   todas as telas; "cancelar" (destrutivo) tem peso visual igual a "exportar".
3. **Sem escala tipográfica**: tudo entre 11 e 16px, sem papel definido.
4. **Acento âmbar é a única constante de marca** (limpar e botão Salvar do
   marcar) e está correto: é o que sobrevive.
5. **Microcopy é a melhor coisa do produto**: "tirar", "trazer de volta",
   "ouvir junção", "vai cair", "olhe isto". Preservar integralmente.
6. Overuse do separador "·" em metadados; ícones unicode ad-hoc (↥↧, ×).

## O que fica de pé (não se negocia)

- O conceito texto-centrado: o texto é a mídia; cortar é editar prosa.
- Operação por teclado (as duas telas já são keyboard-first).
- Voz do microcopy em PT-BR.
- A pureza do marcar às cegas (sem transcrição na tela).
- O cadeado de entrega (assistir a prévia até o fim para aprovar).
- O âmbar `#F2C230` como acento único.

## Sistema proposto: "sala de corte"

### Tema e cor

Dark único nas três telas (Page Theme Lock). Rampa neutra **quente** (o atual
é teal-tingido; carvão quente casa com âmbar e com material de vídeo):

| Papel | Token | Valor |
|---|---|---|
| fundo da página | `bg-0` | `#111316` |
| painel | `bg-1` | `#181B20` |
| elevado / card | `bg-2` | `#20242B` |
| linha | `line` | `#2B3038` |
| texto | `ink` | `#E9E7E2` |
| texto secundário | `muted` | `#9AA0A9` |
| acento (único) | `accent` | `#F2C230` (texto sobre acento: `#1B1508`) |
| alerta semântico | `warn` | `#E0765C` |
| ok semântico | `ok` | `#63BE97` |

Sem pureza preta/branca, sem gradiente decorativo, sem segundo acento. Verde e
terracota são **semânticos** (estado), nunca decoração.

### Tipografia em três papéis

O conceito central do produto vira sistema: a prosa é a mídia, controles são
controles, dados são dados.

| Papel | Onde | Stack (sem download, ferramenta local) | Uso |
|---|---|---|---|
| **Material** | prosa editável do limpar e do montar | `Charter, "Iowan Old Style", Georgia, serif` 19-20px/1.65 | Só o texto que se edita. Serifa é escolha articulada: diferencia a mídia dos controles e dá autoridade de leitura |
| **Interface** | botões, rótulos, menus, help | `system-ui, -apple-system, sans-serif` 13-14px, pesos 400/600 | Todo o cromo ao redor |
| **Dados** | timecodes, contagens, durações, revisões | `ui-monospace, "SF Mono", Menlo, monospace` 12-13px, `tabular-nums` | "80s de 95s", "0.4-25.2s", "revisão 7", cursor do marcar |

Serifa só no material, sem exceção; isso mata a inconsistência atual (limpar
serifa × montar sans para a mesma natureza de conteúdo).

### Botões, forma e ícones

- Um sistema: **primário** (fundo âmbar, texto `#1B1508`), **secundário**
  (borda `line-strong`, fundo `bg-1`), **quieto** (ghost, `muted`), **perigo**
  (texto `warn`, sem preenchimento). Altura 32px, raio 6px.
- Raio único documentado: 6px em controles, 10px em cards/painéis. Nada de
  raio misturado sem regra.
- Ícones: Phosphor (`@phosphor-icons/web`), strokeWidth 1.5, substituindo os
  unicode ad-hoc.
- Contraste: todo texto passa AA sobre o fundo onde vive; botão âmbar leva
  texto quase-preto (ratio alto).

### Estados (o que hoje não existe)

- **Loading**: skeleton da prosa e da prévia (blocos cinza na forma final),
  nada de spinner circular genérico; a lista de etapas do ingest vira barra de
  progresso com etapa atual em sans + tempo em mono.
- **Empty**: montar sem fontes = dropzone em tela cheia com briefing embutido
  (o primeiro gesto do produto é colar o roteiro e arrastar mídia).
- **Erro**: banner inline no painel afetado; toast só para transientes.
- **Reduced motion**: toda transição respeita `prefers-reduced-motion`.

### Movimento

Nível 2: transições de painel (160ms ease-out), feedback de pressionado
(`scale 0.98`), playhead da faixa contínuo ao play. Motivação: feedback e
estado, nunca decoração.

## Mudanças por tela

### 1 · Limpar

| Hoje | Proposto |
|---|---|
| 6 botões iguais no header | Header em dois planos: à esquerda wordmark + estado; stats grandes em **dados** (mono): `12/15` trechos e `80s de 95s` como números display; à direita ações agrupadas: `sugerir cortes` (secundário) e **um** botão `Exportar` com menu (EDL/MP4/SRT/TXT); `cancelar` quieto no canto oposto |
| prosa 16px serifa, medida larga | Prosa a 20px/1.65, medida de leitura `max 34em`, parágrafo como unidade de cena |
| trecho cortado = chip tracejado com elipse | Corte inline: texto riscado e esmaecido no lugar, clique traz de volta; razão do corte da triagem vira tooltip no hover |
| marcador de junção = filete à esquerda | Marcador de corte numerado em **dados**: `corte 1 · -6,4s` com botão `ouvir junção`; pausa curta vira badge `warn` no próprio marcador |
| prévia da triagem colada no rodapé | Painel-card de rodapé com duas colunas (`vai cair` / `olhe isto`) e um primário `aplicar`; stats em mono no topo |
| exportações como 4 botãos | Menu de exportação com os 4 alvos; cada linha mostra formato e destino |

### 2 · Montar (a mudança maior)

| Hoje | Proposto |
|---|---|
| tema claro no meio de produto escuro | Dark único (rampa acima) |
| materiais com checkbox + select + 3 botões empilhados | Card de material: thumb + nome + meta em mono (`96s · pronto`); papel como **segmented control** (`Fala/Apoio`); ações num menu de overflow no hover; seleção múltipla vira barra contextual (`incluir · excluir` desaparecem quando nada está selecionado) |
| briefing solto no rodapé do rail | Primeira execução: empty state de tela cheia (dropzone + briefing juntos). Depois: linha recolhida `briefing · 60s alvo` no rail |
| cabeçalho de cena minúsculo com 3 ícones soltos | Cabeçalho de cena: número em **dados** (`cena 1`), objetivo em interface 15px/600, tempo em mono, ações num kebab; hierarquia de seção de verdade |
| prosa sans 14-16px | Prosa em **material** 20px serif; corte = riscado esmaecido inline (mesma gramática do limpar); correção de grafia = sublinhado pontilhado âmbar com estado no hover |
| `fala.mp4 · 0.4s-25.2s` como linha solta entre blocos | Fonte/timecode vira chip mono discreto no fim do bloco de cena, não um parágrafo órfão |
| zona "fora da montagem" repete prosa inteira | Inset recolhido no fim da cena: `não usado (n palavras) · incluir trecho`, com a prosa apagada dentro |
| faixa = banda fina escura | Faixa de 72-88px: régua de timecode em mono, blocos proporcionais por cena (largura = duração), waveform da fonte dentro do bloco, playhead âmbar contínuo, clique = seek. A sequência vira o segundo objeto mais importante da tela |
| contexto com 3 seções soltas | Pilha de cards: `prévia` (player + frescor em mono + `atualizar prévia` secundário + `aprovar prévia assistida` primário com estado travado explicado), `correções` (lista com estado semântico ok/warn), `ajuste` (pedido + `propor mudanças` primário quando autorizado) |

### 3 · Marcar

A tela mais próxima do alvo. Mudanças pequenas:

- Repousar no dark quente unificado (hoje é teal).
- Vídeo perde protagonismo: vira referência 40% à esquerda; a **onda com
  zoom é a hero** (60%), porque é nela que a medição acontece.
- Leitura do cursor vira o número display da tela: mono 28-32px `12 480 ms`.
- Marcas: chips mono na ordem, o próximo ao cursor destacado em âmbar.
- Barra de atalhos no rodapé permanece (é boa); reestilizada no sistema de
  quietos + dados.

## Anti-clichês conferidos

Sem roxo de IA, sem segundo acento, sem serif fora do material, sem gradiente
decorativo, sem spinner genérico, sem dots decorativos, sem em-dash no copy de
interface, um só raio, um só tema, contraste AA auditado por botão.

## Riscos e notas

- Charter/Iowan não existem no Linux; a stack cai para Georgia e depois para
  serifa do sistema. Se a queda incomodar, self-host de uma variável (uma
  família só, `font-display: swap`).
- O dark único no montar mexe em `page.css` inteiro; é o item de maior esforço
  e maior retorno.
- A faixa (task 7 pendente no código) deve nascer já no desenho novo: redesenhar
  a tela sem a timeline nova seria refazer duas vezes.
- Ordem sugerida de execução: tokens + botões (1 PR) → limpar (menor) →
  faixa + montar → marcar (polimento).

## Mockup

`mockups/montar.html` aplica o sistema à tela de montagem com os dados reais
do harness (cenas, cortes, correção, prévia). Print em
`telas/06-mockup-montar.png`.
