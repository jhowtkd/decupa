# Implantação Docker

O compose oficial sobe o Decupa na Raiz de Projetos atrás do Caddy. Somente o
Caddy publica portas; o serviço Decupa fica acessível apenas na rede interna do
compose.

## Primeira subida

```bash
cp .env.example .env
# edite DECUPA_AUTH_PASSWORD e, para um domínio público, DECUPA_DOMAIN
docker compose build
docker compose up -d
curl https://SEU_DOMINIO/healthz
```

`DECUPA_AUTH_PASSWORD` é obrigatória: o `${VAR:?}` no compose recusa subir sem
ela. A imagem padrão é `cpu`, com PyTorch do índice CPU e sem bibliotecas CUDA.
O servidor usa `decupa serve --projects-root /data/projects`, bind em
`0.0.0.0`, confiança explícita no proxy, `/data/media` como Raiz de Mídias e
nunca abre navegador.

## TLS

`DECUPA_TLS_MODE=auto` usa o HTTPS automático do Caddy para um domínio público;
`internal` usa a CA interna do Caddy (aceite o certificado nos clientes da
LAN); `off` mantém HTTP para redes onde TLS é terminado antes do host. O
domínio precisa resolver para a máquina e as portas escolhidas precisam estar
livres. Se uma porta HTTP diferente de 80/443 for publicada, inclua o domínio
com a porta em `DECUPA_ALLOWED_HOSTS`.

## Volumes e bind mounts

Os volumes nomeados são:

- `decupa-cache`: `HF_HOME` e `TORCH_HOME`, incluindo modelos;
- `decupa-config`: `~/.decupa`, credenciais, segredo de sessão e fila;
- `decupa-projects`: `/data/projects`;
- `decupa-media`: `/data/media`;
- `caddy-data` e `caddy-config`: certificados e estado do proxy.

Para usar um disco local ou NAS, troque os quatro volumes do Decupa no
`docker-compose.yml`, por exemplo `/srv/decupa/projects:/data/projects`.
Defina `DECUPA_UID` e `DECUPA_GID` com o dono desejado antes do build para que
arquivos gravados nos bind mounts pertençam ao usuário correto.

## Pré-baixar modelos

Faça o download explícito dos modelos de fala no cache persistente:

```bash
docker compose run --rm decupa models fetch
```

Esse comando usa o mesmo `HF_HOME`/`TORCH_HOME` do serviço. O primeiro uso sem
essa etapa pode baixar vários gigabytes; os modelos permanecem no volume ao
recriar a imagem.

## Atualização e parada

```bash
docker compose pull caddy
docker compose build --pull decupa
docker compose up -d
docker compose down
```

`docker compose down` remove os containers e a rede, mas preserva volumes
nomeados. Faça backup de `decupa-config`, `decupa-projects` e `decupa-media`.

O smoke test reproduzível está em `scripts/docker-smoke.sh`; ele constrói a
variante CPU e exercita todos os pedidos pelo Caddy.
