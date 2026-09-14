# ICE3-06 — Aprofundar `davinci-proof` (clipes + mídia online)

> Base: `661d8c1`. TDD onde der. Sem dependências novas. pt-BR nas mensagens. NÃO commitar; deixar diff dirty no worktree.

## Problema

O harness de Gate G6 só valida contagem de trilhas, nome e duração (`GetTrackCount`/`GetName`/frames). Um OTIO que importa com mídia OFFLINE ou com clipes faltando passa como `ok: true` — falso-verde no gate de confiança da entrega.

Evidência: `scripts/davinci-proof.py:60-80`.

## Escopo permitido

- PODE tocar: `scripts/davinci-proof.py` + UM arquivo novo de teste `scripts/davinci-proof.test.ts` (ou `tests/davinci-proof.test.ts` se o runner exigir — preferir ao lado do script).
- NÃO tocar: qualquer outro arquivo.

## Mudança

Estender `verify_otio_import(otio_path)` para, após importar:

1. Ler o OTIO (JSON) e contar clipes esperados por trilha (children `Clip.1` por `Track.1`, na ordem).
2. Na timeline importada, enumerar itens por trilha via API do Resolve (`timeline.GetItemListInTrack(trackType, trackIndex)` para `video`/`audio`, índices 1-based) e comparar quantidades com o OTIO.
3. Checar mídia online: para cada item, `item.GetMediaPoolItem()` não-nulo e, quando disponível, `GetClipProperty("File Path")` existente no disco (`os.path.exists`); divergência vira `ok: False` com detalhe por clipe.
4. Incluir no relatório: `expectedClips`, `actualClips`, `offline: [...]`.

Defensivo: qualquer chamada de API ausente na versão instalada deve gerar `ok: False` com mensagem clara (não exceção crua). Manter comportamento atual quando Resolve fechado (erro informativo, exit 2) e a limpeza do projeto efêmero (deletar em TODOS os caminhos, inclusive falha de validação — hoje falha de import deleta; manter e estender para falha de validação).

## Testes

`scripts/davinci-proof.test.ts`: sem Resolve, sem `listen`:

1. `otio inexistente retorna ok:false` — invoca o script python com caminho fake, espera exit 2 e JSON com `error` (usar `execFile` python3; pular se python3 ausente).
2. `validação conta clipes via stub` — criar stub `DaVinciResolveScript.py` em tmpdir (via `PYTHONPATH` ou o `RESOLVE_SCRIPT_API`? o script prepend `sys.path` só se o dir existir — usar stub injetando um módulo fake através de um wrapper: mais simples, adicionar ao script suporte a `DECUPA_RESOLVE_STUB` env apontando para um módulo stub; default mantém comportamento). Stub simula timeline com N itens e 1 offline → espera `ok:false` citando o clipe; stub tudo-online → `ok:true` com contagens.

Se `GetItemListInTrack` não existir na API instalada, documentar no relatório do agente e adaptar para a melhor API disponível (`GetVideoTrackCount` não serve — é contagem de trilhas, não de itens).

## Verificação

```bash
WT=/tmp/decupa-wt-06
ln -sfn "/Users/jhonatan/Repos/Video editor/node_modules" "$WT/node_modules"
sed -e "s#/Users/jhonatan/Repos/Video editor#$WT#g" -e "s#decupa-vite-cache#decupa-vite-cache-06#" /tmp/decupa-vitest.config.mjs > /tmp/decupa-vitest-06.mjs
cd "$WT" && pnpm exec vitest run --config /tmp/decupa-vitest-06.mjs scripts/davinci-proof.test.ts
cd "$WT" && ./node_modules/.bin/tsc --noEmit -p tsconfig.json && python3 -c "import ast; ast.parse(open('$WT/scripts/davinci-proof.py').read())"
```

## Critério de sucesso

- Testes novos falham antes (stub offline passa como ok no código antigo), passam depois. Typecheck + parse python OK. Validação com Resolve real fica como pendência documentada (não abrir o Resolve nesta tarefa).
