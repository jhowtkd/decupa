# syntax=docker/dockerfile:1.7

FROM ubuntu:24.04 AS base

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_MAJOR=22

ENV DEBIAN_FRONTEND=noninteractive \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    PATH=/opt/decupa/node_modules/.bin:/opt/decupa/work/engine-venv/bin:/opt/decupa/services/speech/.venv/bin:/opt/decupa/services/vision/.venv/bin:$PATH

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
      ca-certificates curl ffmpeg git libgl1 libglib2.0-0 build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install --no-install-recommends -y nodejs \
    && npm install --global --no-audit --no-fund pnpm@10.32.1 \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/decupa

# Dependências JS ficam numa etapa própria: alterações somente em TS/JS não
# invalidam as camadas caras de Python abaixo.
FROM base AS js-deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/package.json
COPY packages/acoustics/package.json packages/acoustics/package.json
COPY packages/bench/package.json packages/bench/package.json
COPY packages/cache/package.json packages/cache/package.json
COPY packages/coordinator/package.json packages/coordinator/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/goldedit/package.json packages/goldedit/package.json
COPY packages/media/package.json packages/media/package.json
COPY packages/metrics/package.json packages/metrics/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/trace/package.json packages/trace/package.json
COPY packages/transcript/package.json packages/transcript/package.json
COPY packages/triage/package.json packages/triage/package.json
COPY packages/typesafe/package.json packages/typesafe/package.json
RUN pnpm install --frozen-lockfile --prod

# Ambientes Python e o motor são preparados antes do código da aplicação. O
# bundle versionado torna esta etapa offline em relação ao repositório do motor.
FROM base AS python-deps

ARG DECUPA_VARIANT=cpu

COPY scripts/setup.mjs scripts/setup.mjs
COPY scripts/engine scripts/engine
COPY services/speech/pyproject.toml services/speech/uv.lock services/speech/
COPY services/vision/pyproject.toml services/vision/uv.lock services/vision/
RUN uv python install 3.11 3.12 \
    && node scripts/setup.mjs --engine-only \
    && uv sync --locked --no-dev --python 3.11 --directory services/speech \
    && uv sync --locked --no-dev --python 3.12 --directory services/vision \
    && uv venv --python 3.11 work/engine-venv \
    && uv pip install --python work/engine-venv/bin/python \
      -r work/video-agent-kit-plugin/requirements.txt \
      -c scripts/engine/requirements.lock.txt \
    && uv pip install --python work/engine-venv/bin/python --no-deps 'scenedetect>=0.6' \
      -c scripts/engine/requirements.lock.txt

# O lock da fala foi resolvido contra PyPI para as plataformas locais. Em
# Linux, substituímos apenas os três pacotes PyTorch pela distribuição CPU e
# removemos os artefatos CUDA antes de copiar o venv para a imagem final.
# Só o índice CPU e `--no-deps`: as dependências já vieram do lock, e no uv um
# --extra-index-url (PyPI) teria prioridade e esconderia as versões `+cpu`.
# Na variante cuda o torch do lock já é a build CUDA do PyPI (com as rodas
# nvidia-*-cu12); a conferência no fim falha o build se ele vier sem CUDA.
# A troca dessincroniza o venv do uv.lock de propósito; por isso a imagem
# valida a fala por import (DECUPA_SIDECAR_CHECK=functional) em vez de
# `uv sync --check`, e o build falha se o import não resolver.
RUN test "${DECUPA_VARIANT}" = cpu || test "${DECUPA_VARIANT}" = cuda \
    && if [ "${DECUPA_VARIANT}" = cpu ]; then \
      uv pip install --python services/speech/.venv/bin/python \
      --force-reinstall --no-deps \
      --index-url https://download.pytorch.org/whl/cpu \
      torch==2.8.0+cpu torchaudio==2.8.0+cpu torchvision==0.23.0+cpu \
      && for package in $(uv pip freeze --python services/speech/.venv/bin/python | \
      awk -F= '/^(nvidia-|triton==)/ { print $1 }'); do \
      uv pip uninstall --python services/speech/.venv/bin/python "$package"; \
      done; \
      services/speech/.venv/bin/python -c 'import whisperx, torch; assert torch.version.cuda is None'; \
    fi \
    && if [ "${DECUPA_VARIANT}" = cuda ]; then \
      services/speech/.venv/bin/python -c 'import sys, whisperx, torch; print(torch.__version__, torch.version.cuda); sys.exit(torch.version.cuda is None)'; \
    fi \
    && rm -rf /root/.cache/uv

FROM python-deps AS runtime

ARG DECUPA_UID=1000
ARG DECUPA_GID=1000

# A imagem do Ubuntu 24.04 já traz o usuário `ubuntu` com UID/GID 1000.
RUN if id ubuntu >/dev/null 2>&1; then userdel --remove ubuntu; fi \
    && if getent group ubuntu >/dev/null; then groupdel ubuntu; fi \
    && groupadd --gid "${DECUPA_GID}" decupa \
    && useradd --uid "${DECUPA_UID}" --gid "${DECUPA_GID}" --create-home --shell /usr/sbin/nologin decupa \
    && mkdir -p /home/decupa/.cache /home/decupa/.decupa /data/projects /data/media \
    && chown -R decupa:decupa /home/decupa /data /opt/decupa

# Dados NLTK são separados dos pacotes Python. Instalar fora de /root permite
# que o usuário de runtime encontre o tokenizador sem downloads na transcrição.
COPY services/speech/prepare_nltk.py services/speech/prepare_nltk.py
RUN services/speech/.venv/bin/python services/speech/prepare_nltk.py \
    --download-dir /usr/local/share/nltk_data

# MediaPipe carrega GLES/EGL mesmo com delegate CPU. O import Python não
# exercita esse carregamento; o preparo dos modelos abaixo valida o grafo real.
RUN apt-get update \
    && apt-get install --no-install-recommends -y libgles2 libegl1 \
    && rm -rf /var/lib/apt/lists/*

# O pnpm liga os pacotes do workspace em node_modules de cada pacote; sem
# eles, `@decupa/*` não resolve. `packages/` desta etapa só tem package.json e
# node_modules, e o código chega pelo `COPY . .` logo abaixo.
COPY --from=js-deps --chown=decupa:decupa /opt/decupa/node_modules /opt/decupa/node_modules
COPY --from=js-deps --chown=decupa:decupa /opt/decupa/apps/cli/node_modules /opt/decupa/apps/cli/node_modules
COPY --from=js-deps --chown=decupa:decupa /opt/decupa/packages /opt/decupa/packages
COPY --chown=decupa:decupa . .

ENV HOME=/home/decupa \
    HF_HOME=/home/decupa/.cache/huggingface \
    TORCH_HOME=/home/decupa/.cache/torch \
    DECUPA_SIDECAR_CHECK=functional \
    DECUPA_BIND_HOST=0.0.0.0 \
    DECUPA_TRUST_PROXY=1 \
    DECUPA_MEDIA_ROOT=/data/media \
    DECUPA_JOB_CONCURRENCY=1 \
    DECUPA_NO_BROWSER=1 \
    DECUPA_ENGINE_PYTHON=/opt/decupa/work/engine-venv/bin/python

VOLUME ["/home/decupa/.cache", "/home/decupa/.decupa", "/data/projects", "/data/media"]

USER decupa
RUN services/speech/.venv/bin/python services/speech/prepare_nltk.py --check \
    && services/vision/.venv/bin/python services/vision/visual_index.py --prepare-models
EXPOSE 7788
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 \
  CMD curl --fail --silent http://127.0.0.1:7788/healthz || exit 1

ENTRYPOINT ["node", "--experimental-strip-types", "apps/cli/src/index.ts"]
CMD ["serve", "--projects-root", "/data/projects"]
