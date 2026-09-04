# Triagem semântica — design

Data: 2026-09-04
Estado: aprovado, aguardando plano de implementação

## Problema

O motor de condense decide por acústica e léxico. Ele acha gagueira, pausa,
repetição quase-verbatim e conectivo. Ele **não sabe do que o vídeo trata**, e
por isso não sabe quando o conteúdo ainda não começou.

Medido no material real (`work/ritmo/proxy.mp4`, 42 unidades):

```
u001   !     Eu esqueci o começo, perdão.
u005   !     Dicas pra você parar de ser chatão nas redes sociais.
```

Flags idênticas. Uma é o falante pedindo desculpa pro operador de câmera; a
outra é o gancho do vídeo. Nada acústico ou lexical separa as duas — só o
significado.

Hoje quem resolve isso é uma pessoa escrevendo `--keep u005-u031 u038-u041` na
mão. Esse é exatamente o trabalho que o projeto existe pra tirar do time.

## O que já resolve mecanicamente (não reconstruir)

O `condense_index` já entrega sinal parcial, e a triagem deve consumir isso em
vez de refazer:

- `trim_candidates` pegou `u042 "Ih, foi!"`, `u003 "Entende?"`, `u034`/`u036`
  ("restates u032, similarity 1.0") e `u027` sozinho.
- `topic_runs` agrupa unidades por keyword repetida — `u001`–`u004` não
  aparecem em nenhum grupo, o que é sinal fraco mas real de que não pertencem
  ao corpo do vídeo.
- As flags `D`/`F`/`s`/`!`/`V` por unidade.

O que ele **não** pegou: o pré-rolo. Mecanicamente, `u001`–`u004` são frases
normais, bem formadas, com duração normal.

## Princípio inegociável: IDs, nunca tempo

Os timestamps do Gemini são `MM:SS` — resolução de um segundo
([docs](https://ai.google.dev/gemini-api/docs/video-understanding)). Um corte
precisa de milissegundo, e a sessão que produziu este design já gastou quatro
iterações consertando erro de fim de palavra na casa de dezenas de
milissegundos.

Portanto: **o modelo nunca emite um tempo.** Ele emite `u001`. O código resolve
ID → tempo exato pelo `speech_index.json`. O vídeo entra pro modelo *ver*
contexto — está falando com o operador? apontou pra tela? — nunca pra medir.

Essa é a propriedade que mantém o LLM fora do caminho do corte.

## Arquitetura

```
speech_index.json ──┐
                    ├──> packages/triage ──> keep-list ──> condense.py plan
video (proxy)    ───┘         │
                              └──> out/triage.md (o que caiu, por quê,
                                   e quais alegações foram rejeitadas)
```

`packages/triage` (TypeScript, vitest). A chamada do Gemini fica atrás de uma
interface injetada:

```ts
interface TriageModel {
  structure(input: StructureRequest): Promise<StructureClaim[]>;
  density(input: DensityRequest): Promise<DensityCandidate[]>;
}
```

Toda a lógica testável — parse do índice, verificação de alegação, montagem do
keep-list — é função pura sobre o JSON do índice, e roda offline contra um
cliente falso. É o mesmo formato de `trimTrailingSilence` sobre `Interval[]`:
dado sintético, sem I/O, sem rede.

**Por que TypeScript e não Python ao lado do `condense.py`:** o que precisa de
teste não é a chamada da API, é a verificação. O repo tem vitest e zero
infraestrutura de teste Python. Colocar a camada verificadora onde não há como
testá-la seria o erro exato que este projeto vem evitando.

SDK: `@google/genai` v2.3.0+, que suporta `interactions.create` com vídeo e
`processing: "agentic"`.

## Passe 1 — estrutura, com alegação conferida

Entrada: as unidades como texto compacto + o vídeo (agentic).
Saída: JSON estruturado (`response_format` com `mime_type: "application/json"`
e schema; `generation_config: { seed: 0 }`), `reason` em enum fechado.

```json
{
  "unit_ids": ["u001", "u002", "u003", "u004"],
  "reason": "preroll",
  "restated_by": null,
  "note": "falando com o operador de câmera, não com quem assiste"
}
```

O código então confere cada alegação contra o índice:

| `reason` | Condição que o código exige |
|---|---|
| `preroll` | contíguo desde `u001`, e termina antes da primeira unidade citada por qualquer `topic_run` |
| `postroll` | contíguo até a última unidade, e começa depois da última unidade citada por qualquer `topic_run` |
| `restart_block` | ao menos duas unidades do bloco são quase-verbatim entre si (similaridade ≥ 0.8), e `restated_by` aponta pra uma unidade posterior que fica |
| `aside` | a unidade não pertence a nenhum `topic_run`, e tem conteúdo mantido dos dois lados |

Alegação que não passa **não é aplicada**. Vai pro `out/triage.md` como
rejeitada, com a condição que falhou.

### Ordem de avaliação

Duas regras — `aside` e `restart_block` — falam de "unidade que fica", mas a
verificação roda antes de existir keep-list. Resolver assim: "fica" significa
*não reivindicada por nenhuma alegação deste mesmo passe*. Avaliação em duas
etapas sobre o conjunto de alegações:

1. juntar todos os `unit_ids` reivindicados → o conjunto candidato a sair;
2. verificar cada alegação contra o índice mais esse conjunto.

Sem isso a ordem das alegações mudaria o resultado, e duas rodadas com as
mesmas alegações em ordem diferente divergiriam.

### Similaridade é nossa, não do motor

O índice expõe similaridade só como prosa em inglês dentro de
`trim_candidates[].reasons` (`"restates u032 (similarity 1.0)"`). Depender
disso acopla a verificação à redação do motor. `packages/triage` calcula a
própria — coeficiente de Dice sobre bigramas de tokens normalizados,
determinístico e testável. Limiar 0.8, constante nomeada e documentada (o
motor chamou 0.783 de "restates", então 0.8 fica na vizinhança certa).

### O que a verificação **não** faz

Ela rejeita alegação impossível. Ela não certifica alegação correta. A regra de
`preroll` aceitaria `u001`–`u005` tão bem quanto `u001`–`u004` — ela só prova
que o trecho está antes do corpo, não que o gancho não foi junto.

A leitura da prosa continua sendo a checagem de verdade. A verificação existe
pra que erro grosseiro não chegue lá, não pra substituir a leitura.

## Passe 2 — densidade, só com alvo

Roda **apenas** quando `--target` é dado. Sem alvo, "corta o que é redundante"
não tem condição de parada, e é assim que sai corte arbitrário.

Entrada: o que sobreviveu ao passe 1, mais o orçamento. O orçamento é
`lossless_floor_seconds − alvo`, **nessa ordem**: o piso lossless que o índice
calcula já é a duração que sobra depois de tirar toda pausa e hesitação sem
dropar conteúdo nenhum, então é dele que se mede quanto conteúdo ainda precisa
sair. Num material de 245,5s com piso de 120,2s e alvo de 90s, o orçamento é
30,2s — não 35,3s, que é o que dá ao subtrair a partir da duração da fonte.

Saída: candidatos ranqueados com motivo, aplicados até fechar a conta.

Restrições mecânicas: só unidade inteira, nunca parcial. Não é verificável por
máquina — desemboca no `condense_script.md`, que é o checkpoint escolhido.

## Cache

Chave: `sha256(vídeo) + sha256(índice) + versão do prompt + id do modelo + passe`,
mais o **orçamento** quando o passe é o de densidade. Gravado em
`out/triage_cache/<chave>.json`.

O orçamento precisa entrar na chave porque ele vai dentro do prompt do passe 2
("Orçamento: X segundos"), e o ranking que o modelo devolve é resposta àquela
pergunta. Sem isso, trocar `--target` daria cache hit e reusaria em silêncio
candidatos ranqueados para outro orçamento. Ele não entra na chave do passe 1,
que é o que faz trocar o alvo re-rodar só a densidade.

Re-rodar sai de graça. Trocar `--target` só re-roda o passe 2. E daqui a seis
meses dá pra ler exatamente o que o modelo disse e por quê — sem isso, uma
decisão de corte fica não-auditável, que é o custo que a escolha de mandar o
vídeo junto trouxe.

## Erros e degradação

| Situação | Comportamento |
|---|---|
| `GEMINI_API_KEY` ausente | falha com uma frase dizendo qual variável falta e que dá pra seguir sem triagem, montando o keep-list na mão |
| rede/API falha | mesma coisa; nunca cai em keep-list parcial silencioso |
| JSON inválido | o schema estruturado deve impedir; validar mesmo assim e falhar alto |
| modelo não reivindica nada | mantém tudo, e diz que manteve tudo |
| toda alegação rejeitada | degrada pra "sem triagem" e imprime cada rejeição |

Nunca aplicar keep-list parcialmente verificado sem dizer.

## Testes

- Funções puras contra fixtures sintéticas de índice.
- O cliente falso devolve respostas **erradas** de propósito — `preroll` no meio
  do vídeo, `restart_block` sem `restated_by`, `aside` na borda — pra exercitar
  cada caminho de rejeição.
- Similaridade testada isolada, com pares conhecidos.
- Aceitação: rodar neste vídeo e comparar com `u005-u031 u038-u041`, a resposta
  derivada na mão em 2026-09-04 e verificada por QC (`work/corte-contexto/`).

## Fora de escopo

- Montagem multi-material, B-roll, legenda.
- Decidir enquadramento ou corte visual — a triagem decide fala.
- Substituir a leitura do `condense_script.md`.
