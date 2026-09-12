---
name: decupa
description: Liga o editor Decupa (limpeza de fala ou montagem multiarquivo) e devolve a URL local. Use quando a pessoa pedir para abrir o Decupa, começar uma edição, ligar a montagem ou a tela de limpeza. Não use para decidir cortes no chat — a edição acontece na web.
---

# Decupa — arranque pelo agente

Você só liga o app e mostra a URL. Preparação e edição ficam no navegador.

## Se o MCP não estiver configurado

Peça para copiar `docs/skills/decupa/mcp.json.example` para a config MCP do host (Claude Code / Codex / opencode). O comando é `pnpm decupa mcp` na raiz deste repo. Sem o MCP, rode o equivalente no shell:

```bash
pnpm decupa doctor
pnpm decupa montar --project <pasta-absoluta>
# ou
pnpm decupa limpar --input <vídeo-absoluto>
```

Imprima a URL `http://127.0.0.1:<porta>` que o CLI mostrar. **Não** dependa de `open` no navegador — o contrato é a URL.

## Com o MCP

1. `doctor` — se houver ERR, mostre o `fix` e pare.
2. Se faltar chave de análise e a pessoa quiser triagem/proposta: `configure_provider` com `preset` (`zai` | `gemini` | `minimax` | `custom`). A chave não deve aparecer na conversa depois.
3. `start` com `mode: montar` + `project`, ou `mode: limpar` + `input`.
4. Mostre `url` na resposta. Não chame ferramenta de browser para abrir a página, a menos que a pessoa peça.
5. `stop` quando a pessoa encerrar.

Pagos: `allowPaidModel` / `allowPaidVisual` só com consentimento explícito. Não disparam chamada sozinhos.
