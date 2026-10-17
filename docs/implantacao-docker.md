# Implantação Docker

O compose oficial sobe o Decupa na Raiz de Projetos atrás do Caddy. Somente o
Caddy publica portas; o serviço Decupa fica acessível apenas na rede interna do
compose.

Para enviar arquivos diretamente ao Cloudflare R2 e importar para o acervo local,
veja [Upload pelo R2 como passagem](upload-r2.md). Para a VPS baixar direto do
Google Drive a partir de um link, veja [Importação direta do Google Drive](upload-drive.md).

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

## GPU NVIDIA

O perfil de GPU troca a imagem pela variante `cuda`, que traz o PyTorch com
CUDA, e reserva a placa para o contêiner. A transcrição usa a placa quando
`DECUPA_SPEECH_DEVICE` é `cuda` (o perfil define isso), e o render usa o
encoder `h264_nvenc` quando a prova do app passa.

### Pré-requisitos no host

- Driver NVIDIA compatível com CUDA 12.8, com `nvidia-smi` funcionando no host.
- `nvidia-container-toolkit` instalado, com o Docker configurado para usá-lo:

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all ubuntu:24.04 nvidia-smi
```

O último comando precisa listar a placa. Se ele falhar, o `docker compose up`
também falha ao criar o contêiner, porque a reserva de GPU não pode ser atendida.

### Ativação

No `.env` do host, adicione uma linha:

```bash
COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml
```

Os comandos de sempre passam a usar o perfil:

```bash
docker compose build
docker compose up -d
```

O perfil fixa a variante `cuda` (imagem `decupa:cuda`), então `DECUPA_VARIANT`
não muda. Para voltar à CPU, remova a linha de `COMPOSE_FILE`, rode
`docker compose build` (gera `decupa:cpu`) e `docker compose up -d`.

Por que um arquivo de override e não um `profiles: [gpu]`: um perfil liga ou
desliga serviços inteiros. Um `decupa` extra no perfil subiria junto com o
padrão, como dois processos sobre os mesmos volumes, e o Caddy só conhece o
nome `decupa`. O override troca a configuração do único serviço, então a
reserva da placa, a variante e as variáveis de GPU ficam no mesmo contêiner
que o Caddy procura.

### Concorrência

`DECUPA_JOB_CONCURRENCY` continua em `1`. Esse limite vale para transcrição,
render e análise visual, que passam pela mesma fila do host
(`apps/cli/src/app/heavy-work.ts`). O app não escolhe placa por trabalho: a
transcrição usa `cuda` e o NVENC usa a placa padrão. Dois trabalhos pesados ao
mesmo tempo dividiriam a memória da mesma placa. Aumente o valor só depois de
medir a máquina.

### Como conferir que a GPU está em uso

1. Torch com CUDA na imagem:

```bash
docker compose exec decupa /opt/decupa/services/speech/.venv/bin/python \
  -c 'import torch; print(torch.cuda.is_available(), torch.version.cuda)'
```

Na variante `cuda` deve sair `True` seguido da versão CUDA do torch (12.8 com o
lock atual). Na `cpu`, sai `False None`.

2. Encoder compilado no ffmpeg:

```bash
docker compose exec decupa ffmpeg -hide_banner -encoders | grep nvenc
```

Deve listar `h264_nvenc`. Isso só mostra que o encoder existe; a prova de que
ele abre é o passo 3.

3. NVENC aprovado pela prova do app: na primeira prévia ou proxy de cada
Projeto, o app encoda um clipe de 2 segundos e grava o resultado em
`hardware-proof/profile.json`, dentro da pasta do Projeto. A prévia de
referência grava o perfil usado em `preview-cache/*/preview.json`.

```bash
docker compose exec decupa sh -c \
  'find /data/projects -path "*hardware-proof/profile.json" -exec cat {} +'
```

`"profile":"nvenc"` quer dizer que a prova passou. `"profile":"software"`
quer dizer que o encoder não abriu (por exemplo, a capacidade `video` não
chegou ao contêiner) e o app caiu para CPU sem erro visível.

4. Placa ocupada durante um render ou proxy, no host:

```bash
nvidia-smi dmon -s u
```

A coluna `enc` sobe durante o render.

5. Transcrição na placa: se a placa não carregar o modelo, o worker registra
`usando cpu` no log. `docker compose logs decupa | grep "usando cpu"` aponta
esse recuo, mas a ausência da linha não prova uso da placa, porque o app não
registra em qual dispositivo transcreveu. A conferência direta é o `nvidia-smi`
no host: durante a transcrição aparece um processo Python ocupando memória da
placa. O worker encerra após 15 minutos sem uso (`DECUPA_SPEECH_IDLE_MINUTES`)
e a memória volta.

O `decupa doctor` não mostra GPU nem encoder. Trocar o dispositivo não refaz
transcrições já feitas, porque o cache do Projeto não depende dele; para medir,
use um arquivo novo.

A CI só constrói a variante `cuda` (job `build-cuda`). A execução em GPU fica
para uma máquina com placa, pelos passos acima.

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
