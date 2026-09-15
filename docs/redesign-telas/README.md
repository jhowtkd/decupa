# Redesign das telas · material de referência

Levantamento visual e de jornada das três telas web do decupa, feito em
2026-09-14 com dados **mockados** (nada de WhisperX nem modelo pago), para
servir de base ao redesign. Derivado do código em
`apps/cli/src/app/` e `apps/cli/src/mark-web/`.

## Telas — antes do redesign

Prints de 2026-09-14, no código `main` antes do redesign (ramo `redesign-telas` parte daqui):

| Print | Tela | O que mostra |
|---|---|---|
| [01-limpar-revisao.png](telas/01-limpar-revisao.png) | Limpar fala | Review pronto: prosa clicável, trechos cortados colapsados, junção com aviso, flag visual |
| [02-limpar-previa-triagem.png](telas/02-limpar-previa-triagem.png) | Limpar fala | Painel "prévia da triagem": stats, motivos, aplicar/descartar |
| [03-montar-editor.png](telas/03-montar-editor.png) | Montagem | Editor texto-centrado completo: rail, cenas, cortes riscados, b-roll, prévia renderizada |
| [03b-montar-texto-fim.png](telas/03b-montar-texto-fim.png) | Montagem (rolada) | Cena 3 com lacuna em destaque e zona "fora da montagem" |
| [04-marcar-picos.png](telas/04-marcar-picos.png) | Marcar fronteiras | Vídeo + onda com zoom, cursor, 3 marcas na lista, atalhos |

## Depois do redesign (2026-09-14, branch `redesign-telas`)

Mesmos estados, capturados no harness de mock (viewport 1440×900) após as tasks 1–7:

| Print | Tela | O que mudou |
|---|---|---|
| [01-limpar-revisao.png](depois/01-limpar-revisao.png) | Limpar fala | Header com hierarquia (tela + stats "12/15 trechos · 80s de 95s") e menu de export destacado; prosa em serifa com medida única; cortes riscados inline e junções numeradas ("corte 1 · −6,4s") no tema dark unificado |
| [02-limpar-previa-triagem.png](depois/02-limpar-previa-triagem.png) | Limpar fala | Prévia da triagem como faixa fixa no rodapé, com stats em monospace e colunas "vai cair" / "olhe isto" sobre o dark |
| [03-montar-editor.png](depois/03-montar-editor.png) | Montagem | Tema dark unificado; rail esquerdo em cards (Materiais, Briefing, Preparação, Entrega); coluna de contexto à direita (prévia, correções, ajuste); texto em serifa com cenas; faixa de sequência no rodapé com régua (0/20/40/60s) |
| [03b-montar-texto-fim.png](depois/03b-montar-texto-fim.png) | Montagem (rolada) | Cena 3 com lacuna em destaque e card "não usado (110 palavras)" fora da montagem, na mesma medida de leitura do texto |
| [04-marcar-picos.png](depois/04-marcar-picos.png) | Marcar fronteiras | Onda como hero da tela em dark, cursor em display monospace grande (2000 ms / 96.0 s), marcas na lateral e minimapa da extensão no rodapé |

## Jornada do usuário

- [fluxograma.md](fluxograma.md) — Mermaid por tela + jornada macro (GitHub renderiza direto).
- [fluxograma.html](fluxograma.html) — os mesmos diagramas renderizados (tema escuro); requer internet para o CDN do Mermaid.
- [telas/05-fluxograma.png](telas/05-fluxograma.png) — print da página renderizada.

## Proposta de redesign

- [redesign.md](redesign.md) — auditoria, leitura de design, tokens, tipo em três papéis e mudanças por tela.
- [mockups/montar.html](mockups/montar.html) — mockup do editor na nova linguagem, com os dados reais do harness.
- [telas/06-mockup-montar.png](telas/06-mockup-montar.png) — print do mockup (1440×900).
- Mockup ao vivo: <http://127.0.0.1:7794/mockups/montar.html>

## Ver ao vivo

O harness de mock sobe as três telas de verdade (dados fake):

```bash
node work/ui-screens/setup.ts   # recria mídias sintéticas + mocks
node work/ui-screens/serve.ts   # limpar 7791 · montar 7792 · marcar 7793
```

- Limpar: <http://127.0.0.1:7791/>
- Montar: <http://127.0.0.1:7792/>
- Marcar: <http://127.0.0.1:7793/>
- Fluxograma renderizado: <http://127.0.0.1:7794/fluxograma.html> (`python3 -m http.server 7794 --directory work/ui-screens`)

## Notas do comportamento atual (relevantes para o redesign)

- **Entrega da montagem é duplamente travada**: a UI só habilita "Aprovar prévia assistida" depois de assistir a prévia até o fim, e o servidor recusa export sem aprovação (`exportApproved`).
- **Exportar no limpar sempre replanifica** antes de gerar EDL/MP4/SRT/TXT.
- **Marcar nunca mostra transcrição nem predição** — medição às cegas, para não invalidar a medida-ouro do alinhador.
- A faixa de sequência do editor virou timeline com régua e playhead (task 7 do redesign; ver print [03-montar-editor.png](depois/03-montar-editor.png)).
- Na primeira carga da montagem o thumbnail devolve 409 transitório (proxy sendo gerado); recarregar resolve.
- O app de montagem auto-renderiza a prévia e faz bump de revisão sozinho ao abrir.
