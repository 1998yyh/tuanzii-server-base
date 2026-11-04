#!/usr/bin/env bash
# 基础 env 仍由 Actions 下发；root 认证配置由容器只读挂载，发布账号不读取密钥。
set -euo pipefail
cd "$(dirname "$0")/.."
chmod 600 .env.production
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build app
