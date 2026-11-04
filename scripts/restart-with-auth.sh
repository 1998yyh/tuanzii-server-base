#!/usr/bin/env bash
# GitHub 下发的基础 env 每次覆盖；认证配置由服务器 root 管理，追加时不回显内容。
set -euo pipefail
cd "$(dirname "$0")/.."
chmod 600 .env.production
if [[ -f /etc/tuanzi/auth.env ]]; then
  printf '\n' >> .env.production
  grep -E '^(WEB_SESSION_ENABLED|AUTH_ORIGIN|AUTH_CSRF_SECRET|LEGACY_JWT_ENABLED)=' /etc/tuanzi/auth.env >> .env.production
fi
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build app
