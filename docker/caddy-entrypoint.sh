#!/bin/sh
# Converte a escolha simples do .env na diretiva que o Caddyfile aceita.
set -eu

case "${DECUPA_TLS_MODE:-auto}" in
  auto)
    DECUPA_CADDY_GLOBAL=""
    DECUPA_CADDY_TLS=""
    ;;
  internal)
    DECUPA_CADDY_GLOBAL=""
    DECUPA_CADDY_TLS="tls internal"
    ;;
  off)
    DECUPA_CADDY_GLOBAL="auto_https off"
    DECUPA_CADDY_TLS=""
    ;;
  *)
    echo "DECUPA_TLS_MODE precisa ser auto, internal ou off" >&2
    exit 2
    ;;
esac

export DECUPA_CADDY_GLOBAL DECUPA_CADDY_TLS
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
