# Agente 2 — montagem, trilha e aplicação do estilo

Branch de trabalho: `codex/inspiracao-montagem`.

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

Implemente Tarefas 4–6, **exceto suas instruções de UI e rotas**, que pertencem ao agente 3. Comece a Tarefa 4 antes de A-core. Para Tarefas 5 e 6, importe A-core; não crie seu próprio `Rule`, `Evidence`, `EditingStyle` ou detector de áudio.

Você é o único autor de schema, validação, compilação, histórico, música e snapshot de aplicação no projeto. Exporte `StyleApplication` de `inspiration/apply.ts`. Em `assembly/types.ts`, use import de tipo para contratos externos, sem dependência runtime circular.

A seleção nativa de música e endpoints ficam com o agente 3. Você entrega `prepareMusic` e `withMusic` com os contratos do plano. Trate mídia somente de áudio pelo `analyzeSignals` entregue por A-core. Comunique o formato dos avisos de música curta e a forma correta de exclusão do derivado dos catálogos para que o agente 3 não invente comportamento.

Não edite `assembly/routes.ts`, `server.ts`, `page.*` nem `editor/texto.js`. Informe ao agente 3 como representar cenas sem fala e quais operações existentes já podem movê-las/excluí-las. Verifique cenários sem estilo, recompilação, desfazer e alteração da música, incluindo preservação de takes e prévias invalidadas.

Entregue relatório persistido com nome/tipo exatos no `Project`, compatível com `Proposal.styleReport`, para a UI exibir. Sua entrega deve permitir que o agente 3 use `saveProject` e as funções existentes de revisão; não acrescente um segundo caminho de commits de projeto.

Se render/export depender de disponibilidade do compositor, conclua verificações locais possíveis e reporte a evidência faltante; não use mock de render como prova de áudio na saída real.

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

### Tarefa 4: Cenas visuais sem fala no compilador existente

**Files:** alterar `apps/cli/src/app/assembly/{types,store,scenes}.ts`, `scenes.test.ts`, `store.test.ts` e `editor/texto.js`.

**Interfaces:** acrescentar opcional `Scene.visualSequence?: Array<{visualId:string;durationFrames:number}>`. Consumir catálogo visual existente; não criar outro formato de timeline. Para cena com takes, `visualSequence` deve ser ausente/vazio; imagens sobre depoimento continuam em `support`.

- [ ] Acrescentar teste à fixture de `scenes.test.ts`, usando um ID observado já criado nela:

```ts
const scene: Scene = { id:'intro', objective:'Abrir', rationale:'Espaço',
  speechIds:[], takes:[], visualEvidenceIds:[visualId], support:[], gaps:[],
  visualSequence:[{visualId, durationFrames:25}],
};
const a = compileScenes(project, [scene]);
expect(a.tracks.find(t => t.name === 'V1')?.clips[0]?.durationFrames).toBe(25);
expect(a.tracks.find(t => t.name === 'A1')?.clips).toEqual([]);
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/assembly/scenes.test.ts`; esperar falha de duração ausente.
- [ ] Implementar em `resolveScene`, `validateSceneShape`, `compileScenes` e serialização. Na ausência de takes, compilar `visualSequence` consecutiva em V1, avançando cursor por duração validada; áudio de apoio fica mudo. Rejeitar IDs ausentes, fontes excluídas, evidência indisponível, frames não positivos e duração maior que a evidência. Não permitir sequência e takes simultâneos. Reutilizar validação de role support/both.

```ts
// Dentro da cena sem takes, após resolver e validar o span/source:
v1.push({ id: `${scene.id}-visual-${index}`, sceneId: scene.id,
  sourceId: span.sourceId, sourceStartSeconds: span.start,
  startFrame: cursor, durationFrames: item.durationFrames });
cursor += item.durationFrames;
```

- [ ] Mostrar cena visual no editor textual com nome, duração e controles existentes de mover/excluir; ausência de palavras não a torna cena vazia. Auditar callers com `rg -n 'compileScenes|speechIds|scene.takes' apps/cli/src/app/assembly`; conservar limites de support, montagem legada e takes protegidos. Rodar `scenes.test.ts`, `store.test.ts`, `words.test.ts`, `revisions.test.ts` e typecheck. Commit somente os arquivos necessários.

### Tarefa 5: Trilha selecionada, nível revisável e consistência prévia/exportação

**Files:** criar `assembly/{music,music.test}.ts`; alterar `assembly/{types,store,scenes,preparation,routes}.ts`, `render.test.ts`, `otio.test.ts`, `export.test.ts`.

**Interfaces:** `Project.music?: {original:Source; startSeconds:number; gain:number; prepared:Source; events:AudioEvent[]}`; `prepareMusic(source:Source, startSeconds:number, gain:number, dir:string, signal:AbortSignal):Promise<Project['music']>`; `withMusic(assembly:Assembly,music:Project['music']):Assembly`.

- [ ] Testar truncamento pela duração da montagem e preservação de A1, usando fixture Assembly existente:

```ts
const before = structuredClone(assembly.tracks.find(t => t.name === 'A1'));
const result = withMusic(assembly, music);
expect(result.tracks.find(t => t.name === 'A1')).toEqual(before);
const bed = result.tracks.find(t => t.name === 'Music')!.clips[0]!;
expect(bed.startFrame).toBe(0);
expect(bed.durationFrames).toBeLessThanOrEqual(timelineDurationFrames(assembly));
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/assembly/music.test.ts`; esperar import ausente.
- [ ] Implementar seleção local da música sem inseri-la no catálogo de falas. Validar áudio presente, `0 <= startSeconds < duration` e ganho finito `0..1`; default 0,15, ajustável pelo usuário. Gerar WAV derivado com volume aplicado, identificado por hash da fonte/ganho, em pasta de derivados do projeto. Isso mantém o mesmo nível em render e OTIO sem depender de efeito de ganho no importador. Original intacto, nome e hash preservados. Referenciar derivado por `Source` em assembly, mas excluí-lo de ASR e seleção visual; recompor a pista Music após `compileScenes` em todos os callers (preferir chamada única dentro do compilador).

```ts
const args = ['-v','error','-i',source.path,'-vn','-af',`volume=${gain}`,
  '-c:a','pcm_s16le',temporaryWav];
// Validar via probe, publicar por rename; usar sourceStartSeconds=startSeconds na pista.
```

- [ ] Analisar eventos no original com Tarefa 2, subtraindo `startSeconds` para eventos utilizáveis na timeline. Música menor que montagem não entra em loop; informar fim antecipado. Música maior é truncada. Não alterar duração das falas para caber na música. `withMusic(undefined)` retorna montagem idêntica; recompilação substitui pista existente, não duplica.
- [ ] Executar render real com tons sintéticos distintos em fala/música e verificar ambos na saída; comparar amplitude do derivado com ganho pedido e duração exportada. Acrescentar testes OTIO e export para MediaReference do derivado e in-point. Verificar export bundle inclui o derivado ou impede conclusão quando ausente. Rodar testes music/render/otio/export/preparation e typecheck. Não editar compositor externo; falha real deve ser corrigida no adaptador Decupa, sem substituir o motor. Commit arquivos efetivamente alterados.

### Tarefa 6: Aplicação do estilo com snapshot e proposta verificável

**Files:** criar `inspiration/{apply,apply.test}.ts`; alterar `assembly/{types,store,scenes,revisions,preparation}.ts` e testes respectivos.

**Interfaces:** `StyleApplication = {styleId:string;styleRevision:number;rules:Rule[];evidence:Evidence[]}`; `snapshotStyle(style:EditingStyle):StyleApplication`; `styleContext(application:StyleApplication):string`; campo `Project.styleApplication?:StyleApplication`. Acrescentar `Proposal.styleReport?:Array<{ruleId:string;status:'applied'|'adapted'|'unavailable';sceneIds:string[];reason:string}>` e preservar relatório na revisão aplicada.

- [ ] Escrever teste de snapshot sem alias e rejeição de rascunho:

```ts
const snapshot = snapshotStyle(style);
style.rules[0]!.instruction = 'modificação posterior';
expect(snapshot.rules[0]!.instruction).not.toBe('modificação posterior');
expect(() => snapshotStyle({ ...style, status:'draft' })).toThrow(/conclu/);
```

- [ ] Rodar `pnpm exec vitest run apps/cli/src/app/inspiration/apply.test.ts`; esperar falha de import.
- [ ] Implementar `structuredClone` após validação ready e filtrar regras desativadas. Inserir contexto estruturado no prompt de `proposeScenes`; incluir eventos da música escolhida e opção `visualSequence`. Informar hierarquia: proteção da fala > mídia válida > pertinência > ritmo. Sem estilo, omitir completamente o contexto e preservar formato legado de proposta.

```ts
export function snapshotStyle(style: EditingStyle): StyleApplication {
  if (style.status !== 'ready') throw new Error('Análise não concluída');
  return structuredClone({ styleId:style.id, styleRevision:style.revision,
    rules:style.rules.filter(r => r.enabled), evidence:style.evidence });
}
```

- [ ] Validar relatório contra IDs de regra e cena reais. Status aplicado/adaptado exige cena válida; recurso não suportado recebe unavailable. Resultado é relato do modelo, não prova automática de qualidade. Persistir snapshot/relatório em save, merge e history; undo restaura associação anterior. Alterar estilo na biblioteca não muda projeto já salvo. Mudança de estilo/música invalida prévia e aprovação atuais pelas revisões existentes.
- [ ] Testar transporte simulado capturando prompt e retornando cena visual válida, adaptação de falta de planos e take protegido. Verificar takes/cortes permanecem íntegros, IDs inventados rejeitados e nenhuma regra desativada no prompt. Rodar testes apply/scenes/revisions/store/preparation e typecheck. Commit arquivos necessários.
