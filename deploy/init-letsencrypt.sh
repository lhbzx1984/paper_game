#!/usr/bin/env bash
# 首次为域名申请 Let's Encrypt 证书。之后由 compose 里的 certbot 服务自动续期。
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "缺少 .env：请先 cp .env.example .env 并填写 DOMAIN / LETSENCRYPT_EMAIL。"
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${DOMAIN:?请在 .env 中填写 DOMAIN}"
: "${LETSENCRYPT_EMAIL:?请在 .env 中填写 LETSENCRYPT_EMAIL}"

mkdir -p certbot/conf certbot/www

echo "启动 nginx（先用 HTTP 模式，便于完成 ACME 验证）…"
docker compose up -d --build nginx app
sleep 5

if [ -f "certbot/conf/live/${DOMAIN}/fullchain.pem" ]; then
  echo "证书已存在，跳过申请。"
else
  docker compose run --rm --entrypoint certbot certbot \
    certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" \
    --email "$LETSENCRYPT_EMAIL" \
    --agree-tos --no-eff-email
fi

echo "重启 nginx 以启用 HTTPS…"
docker compose up -d nginx certbot

echo "完成：https://${DOMAIN}"
