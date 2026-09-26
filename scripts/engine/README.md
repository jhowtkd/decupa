# Motor incluído

`video-agent-kit.bundle` contém o commit original
`d9fe30076c00ce2968d570622dd22ba068337568`, obtido do clone local.
`local-engine.patch` registra as alterações locais de condense/PT-BR e render
em 22/09/2026. A licença MIT original está em `LICENSE` e dentro do bundle.

`node scripts/setup.mjs` clona esse arquivo local e aplica o patch, sem acessar
um repositório remoto do motor. O destino continua sendo
`work/video-agent-kit-plugin`; instalações existentes são preservadas.
Os patches individuais antigos são referências; o setup aplica somente
`local-engine.patch`, que já reúne o estado local completo.

O bundle não inclui ambientes Python, modelos, credenciais ou mídias.
A instalação completa ainda precisa de internet para dependências e modelos.
O ZIP de distribuição deve conter este diretório inteiro.
