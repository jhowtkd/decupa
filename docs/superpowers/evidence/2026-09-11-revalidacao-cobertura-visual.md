# Revalidação da cobertura visual e retomada

Data: 2026-09-11. Base `2b4300cafad46b5f70d8a0404329a58e03f5b23f` mais diff não commitado. **A barreira passou; a preservação do cache parcial ainda falha. R1 não pode ser fechado.**

Sem alteração no código do produto, commit/push, chamada paga ou alteração no projeto Feira. Evidências e scripts em [work/revalidation-coverage-20260911](</Users/jhonatan/Repos/Video editor/work/revalidation-coverage-20260911>). SHA256 do diff examinado: `9b8d930310e47d5d9996e9b9f1246e581d108d27f0407e0ea4ff6dcd00a2591e`.

## Verificação

- Suíte completa executada fora do sandbox: `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly tests/assembly-flow.test.ts` — **148/148 testes, 16/16 arquivos, exit 0**.
- `pnpm typecheck` — **PASS**, exit 0.
- A fonte incompleta fica visual=pending, nomeia os intervalos faltantes e impede proposta/render.
- Cache de fonte/janela completa não foi reenviado. Sem nova ação do usuário, não houve retry.
- Controle positivo pelo navegador: resposta integral na retomada chegou automaticamente a ready, uma cena e prévia 1. O MP4 gerado pelo motor real carregou no player com readyState=4 e duração de 1,2s.

## Achado único — P1 — IDs posicionais fazem a união apagar evidência válida

Local: [model.ts:198](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/model.ts:198>), em conjunto com [model.ts:147](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/model.ts:147>).

`parseLocalSpans` troca o ID de cada item por `fonte:w<início-da-janela>:<posição-na-resposta>`. Na chamada seguinte a numeração reinicia. Portanto, dois trechos diferentes que sejam o primeiro item de respostas diferentes recebem o mesmo ID. A união por `freshIds` remove o primeiro trecho antes de acrescentar o segundo.

Prova mínima em `merge-check.ts`:

1. Primeira resposta: 0–2s, texto “trecho anterior”, ID externo `first-interval`. ID armazenado: `fala:w0:0`.
2. Segunda resposta: 2–3s, texto “trecho faltante”, ID externo distinto `missing-interval`. ID armazenado: **o mesmo** `fala:w0:0`.
3. Resultado final contém somente 2–3s. A cobertura antes ausente era 2–3s; agora faltam 0–1s e 1–2s. A evidência válida anterior foi descartada.

## Reprodução no navegador

Servidor real do app com duas mídias sintéticas válidas de 3s, respostas de áudio/modelo controladas e motor/FFmpeg reais. Clientes de API injetados; nenhum serviço externo foi chamado. Os cliques foram feitos na UI, e o estado foi conferido por GET /project.

| Ação | Resposta visual da fonte de apoio | Estado observado | Chamadas acumuladas |
|---|---|---|---|
| Preparar montagem | 0–2s; fonte de fala cobre 0–3s | interrupted, apoio pending, falta 2–3s; zero cenas/prévia | visual 2, proposta 0, render 0 |
| Retomar | Somente 2–3s | **Continua interrupted; agora faltam 0–1s e 1–2s**, zero cenas/prévia | visual 3, proposta 0, render 0 |
| Retomar, controle positivo | 0–3s inteiro | ready, 6/6 etapas, uma cena, previewRevision=1 | visual 4, proposta 1, render 1 |

A fonte de fala permaneceu em cache nas duas retomadas; só a de apoio foi solicitada novamente. A perda e a mudança dos intervalos faltantes apareceram nos detalhes da preparação. Estados preservados em `browser-first.json`, `browser-complement.json` e `browser-full.json`.

## Correção e gate para fechar R1

Preservar os trechos anteriores ao receber intervalos complementares. A posição de um item dentro de uma nova resposta não pode determinar que ele substitui outro intervalo. Manter IDs válidos e únicos sem ampliar o contrato persistido desnecessariamente; resolver atualização/sobreposição pelo intervalo efetivamente descrito.

Estender o teste existente para usar **0–2s na primeira resposta e somente 2–3s na retomada**, inclusive com posições iguais nas respostas. O resultado deve conservar ambos os trechos, fechar a cobertura e permitir exatamente uma proposta/prévia. Uma terceira execução deve reutilizar o cache completo sem outra chamada visual. Os testes atuais recebem a janela inteira novamente, o que esconde a perda do trecho anterior.

R2–R4 permanecem aprovados conforme a rodada anterior; esta rodada examinou a alteração de cobertura. Alinhador real, Feira/Z.ai e entrega final no DaVinci seguem como gates de aceite posteriores à correção determinística.
