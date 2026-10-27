#!/bin/sh
set -eu

: "${DOMAIN:?DOMAIN 未设置}"

CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
TEMPLATE="/deploy/http-only.conf.template"
if [ -f "$CERT" ]; then
  TEMPLATE="/deploy/default.conf.template"
fi

envsubst '${DOMAIN}' < "$TEMPLATE" > /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
