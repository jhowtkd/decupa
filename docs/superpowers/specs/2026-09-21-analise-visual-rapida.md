# Análise visual mais rápida

## Resultado pretendido
Reduzir a latência de preparação sem perder ações relevantes para b-roll, inventar cobertura ou aumentar a pressão de recursos no Mac. Não alterar a edição narrativa, presença dos entrevistados ou interface nesta entrega.

## Estado confirmado
O app extrai JPEGs a 1 fps, até 480×480, em janelas de 20s com contexto de 1s. Existem duas vagas de extração e duas de rede; cache por janela. O prompt pede descrição por segundo. `mergeAdjacent` já tenta unir observações depois da resposta: isso não reduz os tokens gerados. O cache visual registra ZAI_DEFAULT_MODEL, mesmo que o cliente injetado use outra configuração. `windowCovered` e preparação exigem cobertura; brollCandidates e candidateSupport dependem de spans contíguos e seus IDs. O seletor só produz candidatos começando no início dos spans: transformar diretamente 20 spans em um descartaria oportunidades ao longo da cena.

## Escopo e sequência
1. Medir fila, extração, envio/retorno, validação, cache e tentativas sem armazenar imagens ou transcrições nos logs.
2. Pedir descrições compactas por intervalos semelhantes, mantendo frames a 1 fps; normalizar intervalos em células de até 1s para preservar consumidores. Uma descrição compartilhada reduz geração; não exige eliminar evidências do catálogo.
3. Corrigir identidade do cache com o modelo efetivamente resolvido e versão do perfil; não reescrever análises de projetos existentes nem invalidar referências já usadas em cenas.
4. Comparar em cópia isolada: baseline, descrição compacta, entrevistas a cada 3s, leitura geral seguida de detalhe e esforço baixo de raciocínio visual quando suportado. Amostragem reduzida e duas passagens são experimentos, não defaults de produção nesta entrega. Não elevar concorrência.

## Restrições globais
- Sem dependências novas e sem novas chamadas pagas durante implementação/testes automatizados.
- Não mudar resolução de frames, concorrência, montagem, renderização ou qualidade da exportação.
- Não tratar uma imagem isolada como prova de continuidade visual entre amostras.
- Preservar mídia, análises existentes, referências de apoio e alterações manuais.
- Experimentos pagos usam somente cópia isolada e autorização aplicável ao material e provedor.
- Redução de amostragem e duas passagens só podem virar padrão após avaliação de qualidade e plano específico de integração.

## Aceite
Regressões locais garantem timestamps, falhas, cancelamento, cache e compatibilidade do catálogo. O piloto usa os mesmos materiais nos braços, separa cache frio/quente e registra wall time real e tentativas. Promover descrição compacta somente se nenhuma ação marcada como essencial for perdida, não houver aumento de referências inválidas e a mediana do tempo total cair ao menos 20% no corpus avaliado. Esse número é critério proposto de aceite, não previsão. Se não cumprir, manter baseline como padrão e registrar resultado inconclusivo ou negativo. Não interpretar sobreposição de spans nem frames ausentes como cobertura.
