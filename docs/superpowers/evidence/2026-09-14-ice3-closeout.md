# ICE-3 — fechamento local

Base: `661d8c1`. Aplicados os patches 00-specs e 01–10 do handoff
`/Users/jhonatan/Repos/Videos_Adscale/ice3-entrega`.
Os três planos de inspiração não rastreados foram preservados fora do commit.

## Ajustes na revisão

- `davinci-proof`: consulta `GetClipProperty` no `MediaPoolItem`, conforme a documentação instalada do Resolve, e testa arquivo ausente com item existente.
- Retenção: recusa diretórios simbólicos (inclusive `history` e `exports`) e valores de retenção inválidos antes de remover derivados; duas regressões locais adicionadas.
- Política entregue: retenção padrão de três revisões recentes, mais revisões protegidas e exportadas; poda automática após render bem-sucedido. Nenhum projeto real foi podado nesta verificação.

## Verificação

- `pnpm typecheck`: exit 0.
- `git diff --check`: exit 0.
- Suíte fora do sandbox, com chaves de análise desativadas: **84 arquivos, 776 testes passaram**, exit 0, 34,69 s.
- Primeira execução no sandbox: 54 falhas de servidor; a execução completa fora dele elimina essas falhas.
- `node --experimental-strip-types apps/cli/src/index.ts doctor`: exit 0, todos os itens OK; somente diagnóstico local, sem chamada de análise.
- Testes de mídia usam FFmpeg real e fixtures locais. Testes do Resolve usam stub.

## Limites

Sem importação real no DaVinci, chamada paga, publicação ou push.
A validação local não representa aprovação audiovisual ou de importação real no Resolve.

## SHA-256 dos patches recebidos

- `00-specs.patch`: `ada947d7a2375506ba8101f4d5589306f98e20a9244c8ca4c77ce9bd7b16efce`
- `01.patch`: `27f14b830a4dac99ea998003e7bfd78549892015fbd0a9a35527754331254d78`
- `02.patch`: `9069d049af2c61c04e27481e716ff831cbb3d0db901c95ecef1e94d695e81fb2`
- `03.patch`: `64af7afa2a69cd545c3678154d3bcae65ae06d93b2499ea839c674e690eb98b6`
- `04.patch`: `b9b8c573951e255d664df419555900078588d9abbedbb93b4c0fa10915985487`
- `05.patch`: `564612cc79de6b02548f1f13565e340b2243ed747d5e1555a9dfcc73368925ec`
- `06.patch`: `c655c5f3bf20d4d39386b85932b8cfac2057afeb7f939478bb71f28a48bf45d1`
- `07.patch`: `3797cff6bcc521aa2229361efc1142bcb674a061a6346754391fd5437155dbbe`
- `08.patch`: `b38a471e24b54f73cbea5eba4c892c019ff60210e1917babf245f343e726ac17`
- `09.patch`: `46856e1ef5119ae0539b6249418ca0d4c3e8e5f8b92b35995752273c391977e9`
- `10.patch`: `bbdfb5873780281369612276600ee284e3ab0942045c24e61cb7485590c11cfa`
