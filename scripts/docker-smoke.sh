#!/usr/bin/env bash
# Prova caixa-preta do compose: todos os pedidos do produto passam pelo Caddy.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/docker-compose.yml" -p "decupa-smoke-$$")
HTTP_PORT="${DECUPA_SMOKE_PORT:-17788}"
BASE="http://localhost:${HTTP_PORT}"
COOKIE="$(mktemp)"
WORK="$(mktemp -d)"
COMPOSE_ENV=(
  DECUPA_AUTH_PASSWORD=smoke-password
  DECUPA_DOMAIN=localhost
  DECUPA_TLS_MODE=off
  DECUPA_HTTP_PORT="$HTTP_PORT"
  DECUPA_HTTPS_PORT=17443
  DECUPA_ALLOWED_HOSTS="localhost:${HTTP_PORT},decupa"
  DECUPA_VARIANT=cpu
)

cleanup() {
  local status=$?
  set +e
  # Logs e o histórico do healthcheck antes do `down`, que apaga os containers.
  if ((status != 0)); then
    env "${COMPOSE_ENV[@]}" "${COMPOSE[@]}" logs --no-color
    for container in $(env "${COMPOSE_ENV[@]}" "${COMPOSE[@]}" ps -aq); do
      docker inspect --format '{{.Name}} {{json .State.Health}}' "$container"
    done
  fi
  env "${COMPOSE_ENV[@]}" "${COMPOSE[@]}" down --remove-orphans
  rm -f "$COOKIE"
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

cd "$ROOT"
env "${COMPOSE_ENV[@]}" "${COMPOSE[@]}" build --pull decupa
env "${COMPOSE_ENV[@]}" "${COMPOSE[@]}" up -d

for attempt in $(seq 1 60); do
  if curl --fail --silent "$BASE/healthz" >/dev/null; then break; fi
  if ((attempt == 60)); then echo "healthz não ficou pronto" >&2; exit 1; fi
  sleep 2
done

headers="$WORK/root.headers"
status="$(curl --silent --show-error --max-redirs 0 -D "$headers" -o /dev/null -w '%{http_code}' -H 'Accept: text/html' "$BASE/")"
[[ "$status" == 302 ]] || { echo "Raiz sem sessão respondeu $status" >&2; exit 1; }
grep -qi '^location: /login' "$headers"

status="$(curl --silent --show-error --max-redirs 0 -D "$WORK/login.headers" -o /dev/null \
  -c "$COOKIE" -H "Origin: $BASE" -H 'Content-Type: application/json' \
  --data '{"senha":"smoke-password","nome":"Smoke"}' -w '%{http_code}' "$BASE/login")"
[[ "$status" == 303 ]] || { echo "login respondeu $status" >&2; exit 1; }

created="$(curl --fail --silent -b "$COOKIE" -H 'Content-Type: application/json' \
  --data '{"nome":"Projeto Smoke","fluxo":"montagem"}' "$BASE/project/new")"
project_id="$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$created")"
project_url="${BASE}/projects/${project_id}/"
curl --fail --silent -b "$COOKIE" "$project_url" >/dev/null

# O fixture é criado dentro da imagem para não depender de FFmpeg no host.
env "${COMPOSE_ENV[@]}" "${COMPOSE[@]}" exec -T decupa \
  ffmpeg -v error -y -f lavfi -i testsrc=size=32x24:rate=5:duration=1 \
  -f lavfi -i sine=frequency=440:duration=1 -c:v libx264 -pix_fmt yuv420p \
  -c:a aac -shortest /tmp/decupa-smoke.mp4
env "${COMPOSE_ENV[@]}" "${COMPOSE[@]}" cp decupa:/tmp/decupa-smoke.mp4 "$WORK/fixture.mp4"

size="$(wc -c < "$WORK/fixture.mp4")"
upload="$(curl --fail --silent -b "$COOKIE" -H 'Content-Type: application/json' \
  --data "{\"nome\":\"fixture.mp4\",\"tamanho\":$size}" "$BASE/api/uploads")"
upload_id="$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$upload")"
last=$((size - 1))
published="$(curl --fail --silent -b "$COOKIE" -X PATCH \
  -H "Content-Range: bytes 0-${last}/${size}" --data-binary "@$WORK/fixture.mp4" \
  "$BASE/api/uploads/$upload_id")"
media_id="$(node -e 'console.log(JSON.parse(process.argv[1]).mediaId)' "$published")"

revision="$(curl --fail --silent -b "$COOKIE" "${project_url}project" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).project.revision))')"
added="$(curl --fail --silent -b "$COOKIE" -H 'Content-Type: application/json' \
  --data "{\"baseRevision\":$revision,\"mediaId\":\"$media_id\"}" \
  "${project_url}project/media")"
source_id="$(node -e 'console.log(JSON.parse(process.argv[1]).source.id)' "$added")"

range_headers="$WORK/range.headers"
status="$(curl --fail --silent --show-error -D "$range_headers" -o "$WORK/range.bin" \
  -b "$COOKIE" -H 'Range: bytes=0-15' -w '%{http_code}' \
  "${project_url}project/media/${source_id}")"
[[ "$status" == 206 ]] || { echo "Range respondeu $status" >&2; exit 1; }
grep -qi '^content-range: bytes 0-15/' "$range_headers"
[[ "$(wc -c < "$WORK/range.bin")" -eq 16 ]]

echo "Docker smoke passou: healthz, login, Projeto, upload e Range 206."
