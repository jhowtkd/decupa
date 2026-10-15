# Montagem sob /projects/:id Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fazer um único servidor de Montagem atender vários Projetos de uma Raiz de Projetos em `/projects/:id/`, sem alterar o escopo de Limpeza ou dos tickets seguintes.

**Architecture:** `startApp` ganhará um modo de servidor de Montagem por Raiz, com um registro lazy que valida `:id`, identifica pastas filhas com `project.json` e cria `createAssemblyRuntime` somente no primeiro acesso. O servidor manterá executor/coordinator compartilhados, roteará caminhos globais antes dos caminhos de Projeto e adaptará o prefixo para o runtime existente. O modo legado de um Projeto continuará disponível para preservar os fluxos e testes fora deste ticket.

**Tech Stack:** Node.js HTTP, TypeScript/JavaScript nativos, Vitest, `pnpm`, runtimes existentes de Montagem, `projectPath()` e `projectUrl()`.

**Spec:** Ticket #132 — Montagem sob `/projects/:id` numa Raiz de Projetos.

## Global Constraints

- Limpeza sob `/projects/:id`, `decupa serve`, descarregamento ocioso, worker de fala compartilhado e login ficam fora deste ticket.
- Testes devem observar a fronteira HTTP com porta 0, Raízes temporárias e dependências injetadas.
- `:id` deve ser um segmento único válido e resolver somente para uma pasta filha direta da Raiz.
- Não adicionar dependências nem fazer chamadas de rede.
- Comentários novos seguem o idioma e a densidade do código existente.

## Review Focus

- Percent-encoding e separadores codificados não podem escapar da Raiz; o teste de roteamento cobre `/projects/%2e%2e`, `/projects/a%2fb` e ids inválidos.
- Uma pasta válida sem `project.json` não deve ser criada implicitamente pelo servidor da Raiz; o teste de 404 fixa isso.
- Duas abas precisam manter estado e respostas no Projeto correto; o teste HTTP acessa dois Projetos na mesma porta.
- Cada import/estático que o navegador pede sob o prefixo precisa existir; o teste busca HTML, CSS, JS, helper e um módulo do editor.
- As rotas globais não podem ser capturadas pelo prefixo; o teste mantém `/templates*` e `/api/*` na raiz.

### Task 1: Servidor de Raiz e registro lazy de Montagens

**Files:**
- Create: `apps/cli/src/app/project-root.ts`
- Modify: `apps/cli/src/app/server.ts`
- Test: `apps/cli/src/app/project-root-http.test.ts`

**Interfaces:**
- Consumes: `createAssemblyRuntime`, `AssemblyDeps`, opções atuais de `startApp`, `guardLocalRequest` e rotas globais existentes.
- Produces: modo `startApp({ projectsRoot, projectId?, ... })`, registro que resolve `id` para pasta filha e roteia requests de Projeto com o prefixo removido.

- [x] **Step 1: Write the failing HTTP tests** para dois Projetos Montagem na mesma Raiz, criação lazy observável pela página, 404 de inexistente/sem manifesto e rejeição de ids maliciosos sem tocar fora da Raiz.
- [x] **Step 2: Run the focused test** com `pnpm -s vitest run apps/cli/src/app/project-root-http.test.ts` e confirmar falha por ausência do modo `projectsRoot`.
- [x] **Step 3: Implement the registry and root server seam** com validação antes de qualquer `stat/read`, resolução por filho direto, criação de runtime na primeira requisição, executor/coordinator compartilhados e fechamento dos runtimes criados.
- [x] **Step 4: Run the focused test** e confirmar PASS.
- [x] **Step 5: Commit** `feat: atende montagens por id na raiz de projetos`.

### Task 2: Prefixo completo para páginas e módulos do navegador

**Files:**
- Modify: `apps/cli/src/app/assembly/routes.ts`
- Modify: `apps/cli/src/app/server.ts`
- Modify: `apps/cli/src/app/project-url.ts`
- Modify: `apps/cli/src/app/project-path.js`
- Modify: `apps/cli/src/app/assembly/page.html`
- Modify: `apps/cli/src/app/assembly/page.js`
- Modify: `apps/cli/src/app/assembly/editor/*.js` somente onde houver caminho absoluto de Projeto
- Test: `apps/cli/src/app/project-root-http.test.ts`
- Test: teste estático existente ou novo em `apps/cli/src/app/project-path-static.test.ts`

**Interfaces:**
- Consumes: prefixo `/projects/<id>` fornecido pelo registro.
- Produces: HTML com meta correta, `projectUrl(path, prefix)` para respostas e todos os assets/imports de Montagem resolvidos sob o prefixo.

- [x] **Step 1: Extend the HTTP test** para buscar a página, extrair o prefixo/meta e buscar CSS, `page.js`, `project-path.js` e `editor/rail.js` através de `/projects/<id>/...`; a montagem já monta URLs de mídia pelo helper no navegador.
- [x] **Step 2: Run the focused test** e confirmar falha nos caminhos absolutos/rotas sem prefixo.
- [x] **Step 3: Implement prefix propagation** no runtime e no servidor, preservando âncoras e deixando links globais (`/settings`, `/templates`) na raiz.
- [x] **Step 4: Add/update the static guard** para rejeitar novos `/project`, `/media`, `/editor/` e `/jobs` absolutos fora do helper, sem falsos positivos para rotas globais.
- [x] **Step 5: Run focused HTTP/static tests** e confirmar PASS.
- [x] **Step 6: Commit** `fix: serve montagens com prefixo de projeto`.

### Task 3: CLI, MCP e abertura do navegador

**Files:**
- Modify: `apps/cli/src/index.ts`
- Modify: `apps/cli/src/mcp/tools.ts`
- Modify: `apps/cli/src/runtime.ts`
- Test: `apps/cli/src/runtime.test.ts` ou teste existente equivalente
- Test: `apps/cli/src/mcp/tools.test.ts`

**Interfaces:**
- Consumes: `startApp` em modo `projectsRoot` e id derivado do basename do `--project`.
- Produces: `decupa montar --projects-root ...` abrindo `/projects/<id>/`; MCP continua tentando a próxima porta livre e devolvendo URL prefixada.

- [x] **Step 1: Write failing tests** para `browserCommand` aceitar URL com `/projects/<id>/`, CLI/MCP devolverem URL prefixada e `--projects-root` sobrescrever a pasta-mãe.
- [x] **Step 2: Run focused tests** e confirmar falha.
- [x] **Step 3: Implement CLI/MCP option plumbing** sem adicionar `decupa serve` nem modificar Limpeza; manter erro amigável de `EADDRINUSE` na CLI e fallback existente no MCP.
- [x] **Step 4: Run focused tests** e confirmar PASS.
- [x] **Step 5: Commit** `feat: abre montagem na url do projeto`.

### Task 4: Regressão e verificação final

**Files:**
- Modify: somente testes que precisarem atualizar expectativas deliberadamente alteradas pelo ticket.

- [x] **Step 1: Run** `pnpm -s typecheck`.
- [x] **Step 2: Run** `pnpm -s vitest run apps/cli packages`.
- [x] **Step 3: Run** testes HTTP focados isoladamente se houver falha oscilante e distinguir regressão da mudança.
- [x] **Step 4: Inspect** `git diff`, confirmar que nenhum arquivo fora do worktree foi alterado e que o escopo excluído permanece intacto.
- [x] **Step 5: Commit** qualquer ajuste final pequeno em português, sempre incluindo `Co-Authored-By: ChatGPT gpt-5.6-luna <noreply@openai.com>`.
