#!/bin/sh
# Converte a escolha simples do .env na diretiva que o Caddyfile aceita.
set -eu

: "${DECUPA_DOMAIN:?DECUPA_DOMAIN precisa ser definida}"
DECUPA_CADDY_SITE="$DECUPA_DOMAIN"

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
    DECUPA_CADDY_SITE="http://$DECUPA_DOMAIN"
    ;;
  *)
    echo "DECUPA_TLS_MODE precisa ser auto, internal ou off" >&2
    exit 2
    ;;
esac

export DECUPA_CADDY_GLOBAL DECUPA_CADDY_TLS DECUPA_CADDY_SITE
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
