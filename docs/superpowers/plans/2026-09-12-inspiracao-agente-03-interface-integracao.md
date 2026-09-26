# Agente 3 — interface, endpoints e integração final

Branch de trabalho: `codex/inspiracao-integracao`.

## Leitura e execução

Leia esta divisão e a especificação aprovada: `/Users/jhonatan/Repos/Video editor/docs/superpowers/specs/2026-09-12-inspiracao-de-edicao-design.md`. O plano original está em `/Users/jhonatan/Repos/Video editor/docs/superpowers/plans/2026-09-12-inspiracao-de-edicao.md`. As tarefas completas da sua frente estão copiadas abaixo. **As regras de propriedade e integração desta divisão prevalecem sobre as listas de arquivos das tarefas originais.**

Execute com `superpowers:executing-plans`, sem criar outros agentes. A feature e o desenho estão aprovados; não reinicie brainstorming. Você não está sozinho no repositório: preserve trabalho alheio, não reverta mudanças dos outros e não edite fora da sua propriedade. Faça correções na origem sob responsabilidade do autor.

Base comum para os três: `6f99d21337866f9a9ed7aa635b349ec51f078642`. Crie seu próprio worktree a partir desse commit, seguindo a skill de worktrees. Leia este arquivo pelo caminho absoluto acima antes de trocar de checkout: estas divisões podem não existir no commit base. Não use o checkout original para implementação nem mude sua branch. Não crie stubs de produção ou contratos duplicados para contornar uma dependência ainda não entregue.

Não faça push, merge em main, chamadas pagas, instalação de dependências ou edição do compositor externo. Testes usam dados sintéticos e caminhos temporários. Não altere o plano original nem os arquivos dos outros agentes; reporte progresso no resultado da tarefa.

## Propriedade global

- **Agente 1:** `apps/cli/src/app/inspiration/{types,store,signals,analyze}.ts` e testes adjacentes.
- **Agente 2:** `inspiration/{apply,apply.test}.ts`; `assembly/{types,store,scenes,preparation,revisions,music,render,otio,export}.ts` e respectivos testes, quando necessários à feature. Nenhum arquivo de UI ou rotas.
- **Agente 3:** `inspiration/{routes,routes.test}.ts`, `assembly/{routes,routes.test}.ts`, `apps/cli/src/app/server.ts` e teste do servidor se necessário; `assembly/page.{js,html,css}`, módulos/testes do editor necessários à feature; `docs/skills/decupa/SKILL.md` e evidência final.
- Pacotes compartilhados, dependências, configurações e outros arquivos ficam fora da divisão. Se um bloqueio exigir mudança, descreva arquivo e alteração para coordenar antes de escrever.

## Protocolo de entrega e integração

Entregue a lista **ordenada dos seus próprios commits**, branch, caminho do worktree, comandos/resultados dos testes e pendências concretas. Nunca inclua commits importados de outro agente na sua lista de autoria.

1. Agente 1 publica primeiro o checkpoint **A-core** com Tarefas 1 e 2 implementadas e verificadas; depois continua Tarefa 3.
2. Agente 2 pode implementar Tarefa 4 imediatamente; importa os commits A-core em seu worktree para concluir Tarefas 5 e 6. Se ainda não recebeu os SHAs, peça somente essa entrega; continue trabalho independente. Não fabrique funções dos módulos do agente 1.
3. Agente 3 pode implementar UI com mocks restritos a testes. Para integrar, importa primeiro **todos os commits próprios do agente 1**, depois **somente os commits próprios do agente 2**, em ordem. Isso evita aplicar A-core duas vezes. Não faça merge cego de branches.
4. Agente 3 é responsável pela entrega integrada e verifica testes/fluxo real. Correções em módulos dos agentes 1 e 2 retornam ao respectivo autor, que entrega commit adicional; agente 3 importa e verifica. Não assumir transferência de propriedade.
5. Caso os SHAs ainda não tenham sido encaminhados, indicar qual checkpoint falta. Não declarar feature concluída só porque a frente isolada passou.

Os contratos de `EditingStyle`, `AnalysisDeps`, `AudioEvent`, `visualSequence`, `Project.music` e `StyleApplication` são os do plano original. `AudioEvent` é exportado por `inspiration/signals.ts`, `StyleApplication` por `inspiration/apply.ts`. Agente 2 é o único autor dos campos em `assembly/types.ts`. Agente 3 usa esses contratos sem redefini-los. Qualquer ajuste necessário de assinatura deve ser informado aos consumidores antes de integração.

## Sua entrega

Implemente Tarefa 7 e conduza Tarefa 8. Assuma também os trechos de **UI** da Tarefa 4 e de **seleção/rotas** da Tarefa 5. Você é responsável pelo resultado integrado, sem reimplementar os módulos dos outros agentes.

Enquanto espera os commits, inspecione o servidor/editor, prepare o painel e testes da interface com dados sintéticos no teste. Não implemente storage, analisador, schema de projeto, compilação, snapshot ou processamento de música. Integre com as implementações reais assim que forem entregues, respeitando a ordem A→B do protocolo.

`inspiration/routes.ts` recebe os serviços reais por import/injeção; `assembly/routes.ts` apenas faz a ligação ao runtime existente. Preserve guardas de origem, parsing limitado e respostas 409. O endpoint de aplicação usa `snapshotStyle` e o mecanismo atual de revisão; a trilha usa `prepareMusic`, seguido do mesmo mecanismo. Não altere `assembly/store.ts` para compensar um contrato ausente: solicite correção ao agente 2.

Inclua cenas de `visualSequence` no editor textual, com duração, nome e controles de mover/excluir, mesmo sem palavras. Inclua música, offset/ganho, receita editável e evidências num player próprio. Não confunda reprodução da referência com aprovação da prévia.

Inclua `stylesRoot` e dependências do analisador em `startApp`/`startAssemblyApp`/`AssemblyDeps` para que testes nunca escrevam na biblioteca real. `analyze` deve reutilizar autorização concedida àquela referência/lote, permitir retomada e impedir que o cancelamento mate outro job.

Ao receber os commits, execute verificação integrada completa, não apenas seu teste de UI. Registre as provas em `docs/superpowers/evidence/2026-09-12-inspiracao-de-edicao.md`, com pendências reais explícitas. Análise paga precisa de autorização e arquivos fornecidos; aprovação editorial continua sendo do usuário. Se faltar uma dessas entradas, entregue o fluxo local verificado sem declarar aceitação real concluída.

## Global Constraints

- Um vídeo de referência por estilo; um estilo pode ser aplicado em vários projetos.
- Adaptação livre ao material disponível, preservando o sentido das falas.
- O usuário escolhe a trilha do novo projeto. O estilo orienta sua relação com a montagem.
- Análise retomável; cobertura incompleta e incerteza aparecem explicitamente.
- Não guardar todos os quadros como imagens permanentes.
- Testes automatizados usam arquivos sintéticos e transportes simulados, sem chamadas pagas.
- Projetos sem estilo mantêm o comportamento atual.
- Sem framework, serviço ou dependência nova. Se alguma se revelar indispensável, apresentar a necessidade concreta antes de adicioná-la.
- Não modificar o checkout `work/video-agent-kit-plugin`, outros planos ICE, `.gitignore` ou trabalho alheio. Stage explícito dos arquivos de cada tarefa.
- Execução em checkout isolado conforme a skill de worktrees; não executar este plano automaticamente ao escrevê-lo.

---

## Tarefas originais atribuídas

### Tarefa 7: Fluxo completo no editor e endpoints locais

**Files:** criar `inspiration/{routes,routes.test}.ts`, `assembly/editor/{inspiracao.js,inspiracao.test.ts}`; alterar `assembly/{routes.ts,page.js,page.html,page.css}`, `assembly/editor/texto.js` se necessário. Alterar também `apps/cli/src/app/server.ts`: propagar `stylesRoot?: string` e `inspirationDeps?: AnalysisDeps` de `startApp`/`startAssemblyApp` até `AssemblyDeps` e `createAssemblyRuntime`. Usar essas injeções em testes; no uso normal, resolver a raiz local e o cliente configurado.

**Interfaces:** `mountInspiracao({state,api,root})` usa state/api existentes e elemento DOM raiz; rotas sob `/project/inspiration`, com biblioteca compartilhada injetável. Handler novo é chamado pelo runtime antes do fallback; não copiar o servidor.

| Método e sufixo | Entrada | Resultado |
|---|---|---|
| GET `/styles` | nenhuma | lista de estilos |
| POST `/select` | `{name}` | seletor nativo, um vídeo, rascunho |
| GET `/:id` | ID validado | receita + estado do job |
| GET `/:id/media` | ID validado | stream da referência registrada, suporte a Range |
| POST `/:id/analyze` | `{modelOptIn,visualOptIn}` | 202 + estado; inicia/retoma |
| POST `/:id/cancel` | nenhuma | cancela somente esse job |
| POST `/:id/edit` | `{expectedRevision,edits:[{id,instruction,enabled}]}` | receita revisada |
| POST `/:id/relink` | `{expectedRevision}` | seletor nativo, valida hash |
| POST `/:id/apply` | `{baseRevision}` | projeto com snapshot do estilo |
| POST `/music` | `{baseRevision,startSeconds,gain,select:boolean}` | seleciona/atualiza trilha; nenhuma chamada de IA |
| POST `/music/clear` | `{baseRevision}` | remove associação/pista, conserva mídia |

- [ ] Testar rotas com `startApp` e injeção de seletor/transporte como `assembly/routes.test.ts`; raiz da biblioteca sempre temporária. Teste inicial da lista:

```ts
const res = await fetch(`${base}/project/inspiration/styles`);
expect(res.status).toBe(200);
expect(await res.json()).toEqual({ styles: [] });
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/inspiration/routes.test.ts`; esperar 404 antes da fiação.
- [ ] Implementar handler com guardas HTTP/origin/body já usados no servidor. Nunca aceitar caminho arbitrário do cliente para streaming; resolver somente referência registrada. Seletor retorna cancelamento sem criar estado. `analyze` exige permissões da referência/lote, sem herdar autorização de outra referência. Duplicatas do mesmo job adotam job existente; cancelar não mata render ou job de outra referência. Guardar permissões concedidas com o job, sem credenciais na biblioteca. Reusar grants da retomada no mesmo escopo.
- [ ] Criar painel com botão “Inspiração de edição”, campo de nome, selecionar referência, progresso/cancelar/retomar, quatro grupos de regras, player próprio e seleção de estilo no projeto. Player separado não interfere no controle de “prévia assistida”. Construir texto do modelo com `textContent`; campos e botões nativos, foco no erro e `aria-live` para progresso. Não reconstruir campos em edição ao receber polling; conflito 409 conserva rascunho local e oferece recarregar.

```js
const button = document.createElement('button');
button.type = 'button';
button.textContent = 'Ver evidência';
button.addEventListener('click', () => {
  referencePlayer.currentTime = evidence.start;
  referencePlayer.play().catch(() => {});
});
```

- [ ] Adicionar seleção da trilha, offset em segundos e ganho com label, aviso sem trilha e aviso música curta. Aplicar estilo salva snapshot e permite “Propor montagem”; não disparar pago ao selecionar estilo. Mostrar relatório por regra com acesso às cenas. Polling só enquanto job ativo; fechar painel não perde trabalho nem exige duplicação de chamadas.
- [ ] Testes: fluxo select→analyze→edit→apply, cancelamento, 409, rejeição de path traversal, mídia ausente/relink, consentimento ausente sem chamadas, botão de evidência e render seguro contra HTML. Reusar padrão de testes DOM existente, sem nova dependência. Rodar testes inspiration, teste novo da UI e testes routes/editor existentes; `pnpm typecheck`. Commit arquivos desta tarefa.

### Tarefa 8: Verificação integrada e aceitação editorial

**Files:** testes existentes alterados somente se encontrarem regressão; criar `docs/superpowers/evidence/2026-09-12-inspiracao-de-edicao.md` com resultados reais e atualizar `docs/skills/decupa/SKILL.md` com acesso à função, sem promessa de geração por MCP.

- [ ] Executar `pnpm test` e `pnpm typecheck` no checkout isolado; registrar saída e commit exato. Corrigir apenas falhas da mudança e repetir checks afetados. Baseline alheia deve ser discriminada.
- [ ] Usar uma referência sintética local para percorrer a UI inteira com transporte simulado: abrir, analisar, editar/desativar orientação, salvar, reabrir, aplicar em segundo projeto, escolher música e produzir prévia. Verificar teclado, reprodução de evidências e identidade das revisões. Essa prova não substitui modelo real.
- [ ] Registrar checklist de comparação real em Markdown:

```markdown
| Verificação | Referência/intervalo | Resultado observado | Evidência |
|---|---|---|---|
| Corte e timestamp | | | |
| Flash versus corte | | | |
| Composição e movimento | | | |
| Relação corte/música | | | |
| Depoimento preservado | | | |
| Estilo em outro conjunto de brutos | | | |
| Trilha e nível na prévia | | | |
| OTIO, mídia online e in-point | | | |
```

- [ ] Antes da execução real, usar arquivos indicados pelo usuário e autorização para chamadas; se faltarem, concluir checks locais e reportar exatamente essa pendência. Executar análise real somente após essa autorização. Preencher tabela com timestamps, divergências e resultado, sem marcar linhas não exercitadas como aprovadas.
- [ ] Importar OTIO da mesma revisão num projeto isolado DaVinci, conferir mídia/áudio, canvas, FPS e in-point da trilha. Não equiparar export JSON válido a importação correta. Se o importador não reproduzir algo suportado pela prévia, corrigir ou registrar a limitação de exportação antes da entrega.
- [ ] Rever diff e comandos finais:

```bash
git diff --check
git diff --stat
git status --short
```

- [ ] Commit somente evidência preenchida e documentação atualizada. Entregar resultado separando testes locais, prova real de análise, prévia, DaVinci e aprovação editorial do usuário. Não publicar nem fazer push por inferência.
