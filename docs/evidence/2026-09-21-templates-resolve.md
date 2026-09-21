# Templates e entrega nativa — execução local

Implementação no branch `codex/templates-resolve`, baseada em `5ec3777` de `redesign-bancada`. Não foi integrada no checkout original, publicada nem implantada. Nenhum provedor pago foi chamado.

## Comportamento entregue no código

Biblioteca privada de receitas: selecionar referência local, analisar com autorização explícita, revisar evidências e instruções, salvar rascunho e aprovar manualmente. Versões aprovadas são imutáveis. A análise incompleta mostra os intervalos visuais ausentes e bloqueia aprovação. Religar exige a mesma identidade de mídia.

No projeto, escolher uma receita aprovada ou trabalhar sem template gera uma proposta separada. Aceitar troca a montagem com histórico/undo e invalida a prévia. A receita aprovada fica congelada no projeto. Prévia e aprovação final permanecem obrigatórias.

A entrega principal é o projeto permanente do Resolve, inclusive sem template, com mídias, timeline importada por OTIO, verificação e marcadores das animações pendentes. Reabrir e exportar DRP não reimportam nem salvam edições existentes. Outro projeto aberto bloqueia a operação. O download da timeline continua secundário.

## Verificação

- Suíte completa com `VE_PLUGIN_ROOT` apontando para o motor já instalado: 1.162 testes passaram, 2 falharam, 1 foi ignorado (132 arquivos). As duas falhas também foram reproduzidas no checkout-base: `scripts/start.test.ts` espera HTTP 428, embora o servidor inicialize; `tests/redesign-contracts.test.ts` exige `matchMedia` ausente no código-base. Não foram alterados esses testes nem seus comportamentos alheios ao escopo.
- Tipagem e `git diff --check` passaram.
- Regressões da revisão: falharam antes das correções e passaram depois. Última verificação focada: 38 testes em 7 arquivos passaram. Renderização local com motor existente: 27 testes em 2 arquivos passaram.
- Navegador: biblioteca vazia → selecionar vídeo sintético → análise com transporte simulado → editar instrução → salvar r3 → aprovar → selecionar no projeto → gerar proposta → aceitar. Projeto avançou de r0 para r1, com receita r3 e animação pendente preservadas. Encontrada e corrigida a ordem de montagem que apagava o painel de templates.
- Prévia real de dois segundos gerada pelo motor: UI mostrou “prévia atualizada”, `previewRevision=1`; decodificação integral por FFmpeg passou. Ao tentar reproduzir no navegador integrado, a página do navegador caiu e sua página de erro foi bloqueada pela política da ferramenta. Não há aceitação audiovisual de reprodução no navegador. Não foi marcada aprovação final desse fixture.
- A referência e biblioteca usadas na UI são sintéticas, isoladas em diretório temporário; aprovações de teste não aprovaram templates do usuário.
- Consulta somente leitura a `DaVinciResolveScript.scriptapp('Resolve')` retornou sem conexão. Nenhum projeto real foi criado ou alterado.

## Revisão independente e correções

Uma revisão do conjunto `5ec3777..7c2042b` encontrou cinco itens importantes e um menor. Todos receberam correção local:

1. Revalidar ID único do projeto imediatamente antes de `SaveProject`; mudança de projeto aborta sem salvar.
2. Excluir o lock de arquivo sem recuperação. A exclusão da coordenação usa porta loopback 47789, liberada pelo SO ao morrer; a ponte Python usa `flock` durante as mutações para impedir sobreposição caso sobreviva ao pai. Testes cobrem bloqueio, morte do proprietário e ponte já ativa.
3. Preservar a entrega bem-sucedida se abrir/exportar falhar, inclusive na recuperação de tentativa interrompida; permitir tentar novamente o mesmo projeto.
4. Validar toda a cobertura visual, incluindo lacunas fracionárias; exibir os intervalos no erro e remover somente o cache parcial gerado, permitindo reanálise.
5. Verificar também o fim do intervalo de origem convertido para o FPS da mídia; teste inclui taxas distintas. A convenção inclusiva usada no adaptador ainda exige confirmação na aceitação real do Resolve, assim como a importação inteira.
6. Bloquear edição de campos durante análise para o polling não descartar edições locais.

Não houve segundo ciclo de revisão independente; as correções passaram pelos checks locais. Nenhum achado menor foi adiado.

## Decisões de execução

- Substituir teste de texto de UI por verificações de estado/API e navegação: prova comportamento; custo é depender também de inspeção no navegador.
- Preservar ausência de campos opcionais em cenas antigas: evita falsas mudanças em cenas não editadas; consumidores tratam ausentes como vazios.
- Armazenar entrega em `deliveries/<revision>`: regenerar export não apaga sua proveniência; exige diretório separado.
- Exigir salvar/fechar outro projeto aberto: API instalada não oferece consulta confiável de alterações não salvas; exige ação manual nesse caso.
- Gravar receita atual e snapshots aprovados em um único envelope atômico: elimina janela entre índice e revisão; arquivo cresce com o histórico.
- Reusar rotas `/project`, em vez de `/assembly` no texto inicial do plano: preserva o roteamento existente.
- Locks nativos locais, sem dependência: sessão única e porta local fixa; se ocupada, entrega mostra erro. O lock da ponte cobre o processo Python órfão, não substitui o lock da persistência Node.
- Recusar cobertura parcial antes da síntese: não inventar evidências; pode exigir reprocessar a análise visual da referência.

## Aceitação ainda pendente

Importar no Resolve real, conferir imagens/áudio/cortes (inclusive FPS distintos e semântica do out), salvar, exportar e reabrir DRP; repetir uma revisão mantendo projeto anterior e edições manuais. Também falta avaliar qualidade editorial com referência e modelo reais, mediante autorização para custo, e concluir a reprodução audiovisual no navegador. Os planos têm implementação local concluída; a aceitação real dessas etapas não foi declarada concluída.
