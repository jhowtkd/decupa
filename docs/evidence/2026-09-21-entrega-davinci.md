# Entrega DaVinci — evidência local

Branch: codex/templates-resolve. Implementação isolada, sem publicação.

- Handoff/store/revisions: 37 testes passaram.
- Ponte Python: 2 testes Vitest, incluindo 5 casos unittest offline com variantes de falha, passaram.
- Coordenação/export/routes: 55 testes passaram.
- Interface/contexto/state/api: 22 testes passaram. Typecheck passou.
- Consulta somente leitura ao módulo oficial `DaVinciResolveScript.scriptapp('Resolve')`: retornou sem conexão em 2026-09-21. Não foi criado nem alterado projeto no Resolve.
- Pendente: importação real, inspeção audiovisual, exportar/reabrir DRP e validar segunda revisão preservando a primeira. Testes offline não comprovam esses critérios.
