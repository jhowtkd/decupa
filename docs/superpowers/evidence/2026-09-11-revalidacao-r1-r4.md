# Revalidação independente de R1–R4

Data: 2026-09-11. Base `2b4300cafad46b5f70d8a0404329a58e03f5b23f` mais alterações não commitadas. **R2, R3 e R4 passaram. R1 está parcialmente corrigido; o aceite final continua pendente.**

Código do produto preservado, sem commit/push, chamadas pagas ou alteração do projeto Feira. Testes de falha e navegador usaram projetos sintéticos temporários. Os dois servidores e abas de QA foram encerrados, e o viewport foi restaurado.

Evidências e scripts: [work/revalidation-r1-r4-20260911](</Users/jhonatan/Repos/Video editor/work/revalidation-r1-r4-20260911>). SHA256 do diff de implementação examinado: `28df57ef7d462769c3ad73f7c596f8ac7178260ea26d69a906ec90c3dc68e4fc`. O snapshot exclui alterações de documentação alheias à implementação.

## Checks observados

- `env -u ZAI_API_KEY -u OPENAI_API_KEY pnpm exec vitest run apps/cli/src/app/assembly tests/assembly-flow.test.ts`: **146/146 testes, 16/16 arquivos, exit 0**, executados fora do sandbox. Não houve EPERM.
- `pnpm typecheck`: **PASS**, exit 0.
- Regressões anteriores: render inválido preserva a referência boa; exportação corrompida recupera o SHA aprovado; import HTTP retorna a fonte com caminho canonicalizado; catálogo corrigido usa IDs aceitos pelo servidor.

| Achado | Resultado independente |
|---|---|
| R1 — erro visual | PASS: cliente visual lança erro; duas fontes ficam visual=error, propose=0, render=0, nenhuma cena/prévia, estado interrupted. A retomada após erro também passa na suíte. |
| R1 — cobertura visual incompleta | **FALHA:** fonte de 3s com cobertura 0–2s fica visual=ready; proposta e prévia são produzidas. O cache mantém a lacuna na nova passagem pela etapa visual. |
| R2 — edição durante render | PASS no navegador com motor real e barreira controlada: remover cria revisão 2; restaurar durante render cria 3; liberar o render antigo produz um segundo render automaticamente. Estado final revision=previewRevision=3, operation=ready, player em `/project/output/3/mp4`. |
| R3 — ocorrência reincluída | PASS no navegador: remover Tom, incluir como `s1-t2`, selecionar somente essa ocorrência e remover funciona. Também foi possível restaurar a nova ocorrência e depois a antiga separadamente. Estado final revisão/prévia 6. Duas ocorrências explicitamente selecionadas continuam sendo rejeitadas como ambíguas, corretamente. |
| R4 — falha ao preparar substituta | PASS: EACCES ao escrever o temporário preservou OTIO e manifest da entrega anterior. O caso novo de falha de copyFile e recuperação seguinte passou na suíte. |

## R1 restante — P1 — cobertura incompleta é publicada como pronta e não se recupera

Locais: [preparation.ts:318](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/preparation.ts:318>), [preparation.ts:338](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/preparation.ts:338>) e [model.ts:152](</Users/jhonatan/Repos/Video editor/apps/cli/src/app/assembly/model.ts:152>).

Depois de calcular `visualCoverage`, o coordenador marca visual como ready mesmo com `missing` não vazio. A barreira nova verifica o estado, mas não a cobertura. O comentário que permite gaps não corresponde ao plano aprovado: a [tarefa 5](</Users/jhonatan/Repos/Video editor/docs/superpowers/plans/2026-09-11-fluxo-automatico-edicao-textual.md:338>) exige cobertura de cada intervalo solicitado, mantendo gaps como etapa parcial e retomando o necessário; a [tarefa 7](</Users/jhonatan/Repos/Video editor/docs/superpowers/plans/2026-09-11-fluxo-automatico-edicao-textual.md:404>) exige todas as análises necessárias prontas antes da proposta.

Reprodução controlada em `visual-gap.ts` e `visual-gap.json`:

1. Duas fontes de 3s. O provedor sintético devolve somente 0–2s para cada uma.
2. Ambas terminam com `missing=[{start:2,end:3}]` e visual=ready; **propose=1, render=1, uma cena, previewRevision=1**, estado attention.
3. Executar novamente a função real da etapa visual para uma dessas fontes, agora com provedor preparado para devolver cobertura completa: **describe=0**, pois o cache parcial é aceito integralmente; o intervalo 2–3s continua ausente.

O passo 3 verifica a mesma função usada na retomada, isoladamente, sem uma segunda proposta. O aviso attention não torna o cache recuperável nem informa quais intervalos faltam na tabela que mostra as etapas como prontas.

Correção necessária, dentro do contrato existente:

- Cobertura solicitada ausente deve manter a etapa incompleta e impedir nova proposta/render. `unavailable` explicitamente devolvido pode contar como resposta, sem virar evidência observada.
- Preservar resultados válidos e permitir que Retomar solicite os intervalos/janelas incompletos; não aceitar um cache parcial como janela concluída nem repetir janelas completas.
- Ajustar o teste que atualmente espera attention com prévia para refletir o contrato. Gate: primeira resposta parcial produz propose=render=0; retomada obtém a cobertura faltante, conserva o restante e só então chega à proposta/prévia. Sem retries infinitos.

## Interface e limites do aceite

Inspeção no navegador: tema claro e sem serifa; vídeo/texto lado a lado em 1280px e empilhados em 390px; ações de palavra quebram linha e continuam acessíveis. Não houve transbordamento horizontal nos estados examinados (scrollWidth 1265/375 com innerWidth 1280/390). A prévia anterior permaneceu no player durante as edições. Isso verifica estes estados, não constitui aprovação estética final.

O texto Nilton/Pinto/Tom destes projetos é um fixture de interação, sobre mídia sintética; não comprova fala ou alinhamento acústico. Correção com alinhador real, percurso Feira/Z.ai e import da entrega final no DaVinci continuam pendentes. A prova de frames da rodada anterior não foi repetida, pois esta rodada não alterou o motor. A autorização anterior de Z.ai continua válida para o mesmo escopo; o bloqueio atual é o comportamento de cobertura, não falta de autorização.
