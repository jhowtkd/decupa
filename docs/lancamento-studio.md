# Lançamento gradual do Decupa Studio

O Decupa Studio é a interface nova da bancada, com as quatro etapas Materiais, Edição, Revisão e Entrega. Ele entra por configuração, sem migração de dados. Esta nota diz como levá-lo da primeira prova à interface padrão e como voltar atrás.

## Como a variante é escolhida

| `DECUPA_EDITOR_UI` | Interface servida |
| --- | --- |
| ausente ou `legacy` | a interface anterior, byte a byte igual |
| `studio` | o Decupa Studio |
| qualquer outro valor (`Studio`, `novo`…) | a interface anterior, com um aviso no log |

- **Onde se lê.** O servidor lê a variável no boot. Ela vale para a Montagem, o hub de Projetos com a gaveta, as Receitas, o login, as Configurações, a Limpeza de fala, Limpar arquivos e o marcador (`decupa mark --web`).
- **Onde se define.** No Docker, pelo `.env` (o `docker-compose.yml` já repassa); fora dele, no ambiente de quem roda `decupa serve`.
- **Como trocar.** Mudar a variável e **reiniciar o servidor**: não há troca a quente.
- **O que não muda.** Os dados não mudam de lugar nem de formato. O mesmo Projeto abre nas duas variantes, e o que for editado numa continua abrindo na outra. O teste de navegador `e2e/legacy.e2e.ts` comprova isso: corte, reordenação e Refazer feitos no studio aparecem na legacy, a legacy edita e desfaz por cima, e o studio volta a abrir o resultado.
- **Preferências locais.** As do studio (etapa, painéis e zoom, no navegador, em `decupa.studio.bancada.v1`) não guardam nada editorial e não afetam a legacy.
- **Fila de Materiais.** O manifesto da fila do studio (`decupa.materiais.v1`, no navegador) só é lido pelo studio: se a variante mudar com envios na fila, as entradas pendentes ou parciais reaparecem quando o studio voltar. **Troque de variante com a fila vazia.**

## Etapas

### 1. Aceite com cópias de Projetos

- Copie alguns Projetos reais, com a pasta inteira, para uma Raiz de Projetos **separada**. Não use a Raiz de produção.
- Suba uma instância à parte com `DECUPA_EDITOR_UI=studio` sobre essa Raiz.
- Escolha Projetos variados: curto e longo (uma hora de material ou mais), com muitas Mídias, com apoio (B-roll), já entregue, com correções de texto.
- Em cada cópia, percorra o roteiro:
  - abrir pelo hub;
  - selecionar e Cortar;
  - Desfazer e Refazer, depois recarregar a página;
  - reordenar uma cena pela alça;
  - conferir a Revisão (os cinco dados e a cobertura assistida);
  - aprovar;
  - preparar a Entrega e baixar vídeo, legendas e pacote;
  - conferir no DaVinci Resolve;
  - parar a instância, subir com `DECUPA_EDITOR_UI` ausente sobre a mesma Raiz e abrir as cópias na interface anterior.
- Registre os tempos de preparação de uma cópia com os modelos reais, que o CI não mede ([evidência dos ensaios](superpowers/evidence/2026-10-23-studio-ensaios.md)).

**Critério de saída:**
- nenhuma edição perdida ou trocada;
- os downloads correspondem à revisão aprovada;
- a cópia abre e edita nas duas variantes;
- as interações respondem bem no computador de quem vai usar.

### 2. Uso controlado

- Ligue o studio numa instância de trabalho real (`DECUPA_EDITOR_UI=studio` no `.env` e reinício), para um grupo pequeno e por um período combinado.
- A legacy continua disponível pela mesma variável.
- Acompanhe o "Ver atividade" e os logs do servidor, e colete os relatos.

**Bloqueios.** Qualquer um destes faz voltar à legacy:
- perda ou troca de edição;
- entrega de revisão diferente da aprovada;
- seleção ou busca que falha em transcrição extensa;
- projeto que não abre numa das variantes.

### 3. Promoção

- O studio passa a ser a configuração de todas as instâncias. Mudar o padrão do código (variável ausente ⇒ studio) é uma decisão à parte, numa versão própria.
- **A legacy continua disponível por duas versões estáveis depois da promoção**, sempre por `DECUPA_EDITOR_UI=legacy`.
- Só depois disso ela pode sair, num PR próprio, que retira os shells e os ramos `ui === "legacy"`.

## Como reverter

| Problema | Exemplos | Como voltar |
| --- | --- | --- |
| **Só de composição** (a interface do studio) | painel ou etapa que atrapalha, layout, foco, visual | `DECUPA_EDITOR_UI=legacy` (ou remover a linha) e reiniciar o servidor. Os Projetos continuam como estão. |
| **De servidor** (rotas, gravação, dados) | erro ao reordenar, desfazer ou refazer; legenda ou entrega errada; Projeto que não grava | voltar a **versão da aplicação** (imagem Docker ou commit anterior) e reiniciar. A variável não ajuda: a legacy usa o mesmo servidor. |

As rotas e campos novos do servidor valem nas duas variantes; a legacy só não os mostra:
- a ordem completa das cenas (`reorder-scenes`);
- o Refazer persistente (`undo.redo`);
- a legenda por revisão (`project/subtitles/<rev>`);
- o `.drp` por revisão.

Voltar a versão é seguro para os dados. O `project.json` gravado pela versão nova abre na anterior: `undo.redo` é opcional e ignorado, e a reordenação só muda a ordem de `scenes`. O ramo de Refazer some na versão anterior, e a primeira edição feita lá o encerra.

## Limites conhecidos no lançamento

- **Projetos muito grandes.** Com ~200 cenas e ~4 h de material, abrir o painel e trocar de etapa ficam acima de 100 ms (p95 ~118 e ~164 ms nos ensaios). A causa são as peças fixas (sticky) da faixa. Selecionar e buscar respondem bem. Ticket: `fora-da-pilha-faixa-projetos-grandes`.
- **Legenda fora do MP4.** A legenda do monitor serve para conferir e não é gravada no MP4; sai em `.vtt`/`.srt` na Entrega.
- **Correções sobrepostas.** Defeito anterior ao redesign, em ticket próprio (`fora-da-pilha-correcoes-sobrepostas`).
- **Temporários de teste.** A suíte de testes deixa temporários no `/tmp`; em ticket próprio (`fora-da-pilha-temporarios-de-teste`).

## Render nos testes de navegador (CI)

O job `e2e` usa o motor de render real, instalado do bundle do repositório. Se o render real quebrar no CI (o FFmpeg lá é o do apt), o plano B troca só o compositor por um MP4 liso na duração da timeline, sem commit: em **Settings → Secrets and variables → Actions → Variables**, crie a variável de repositório `DECUPA_E2E_MOTOR` com o valor `sintetico`. Apague a variável (ou deixe vazia) para voltar ao motor real. Ligar o plano B é decisão humana e fica registrado no PR que o usou.

## Passos humanos

Nenhum destes é feito pelos testes nem pelo CI:

1. Escolher e copiar os Projetos do aceite e subir a instância separada.
2. Percorrer o roteiro de aceite e registrar o resultado, inclusive a conferência no DaVinci Resolve real.
3. Medir a preparação com os modelos reais e o desempenho no computador de uso.
4. Conferir o primeiro run do job `e2e` no CI (Ubuntu) e registrar falhas e testes flaky na evidência da linha de base; se o render real falhar lá, decidir se liga o plano B (`DECUPA_E2E_MOTOR`).
5. Definir `DECUPA_EDITOR_UI` em cada ambiente (`.env`, Docker, serviço) e reiniciar.
6. Decidir a passagem de cada etapa (aceite → uso controlado → promoção) e avisar quem usa.
7. Contar as duas versões estáveis depois da promoção e decidir a remoção da legacy.
8. Priorizar os tickets fora da pilha listados acima.
