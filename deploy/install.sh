#!/usr/bin/env bash
#
# 在服务器上安装 / 更新 DS Chat。
# 用法（root）：
#   cd /path/to/web-ai-chat && bash deploy/install.sh
#
# 前置：
#   - 已构建 frontend/dist
#   - 已准备 /etc/ds-chat.env（首次可先不准备，脚本会提示）
#
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请用 root 运行。" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="/opt/ds-chat"
DATA_DIR="/var/lib/ds-chat"
ENV_FILE="/etc/ds-chat.env"

if [[ ! -f "${ROOT}/frontend/dist/index.html" ]]; then
  echo "缺少 frontend/dist，请先在本机构建：cd frontend && pnpm build" >&2
  exit 1
fi

if grep -q "chat.example.com" "${ROOT}/deploy/nginx-ds-chat.conf"; then
  echo "请先修改 deploy/nginx-ds-chat.conf：替换 server_name 和证书路径。" >&2
  echo "如果你不使用 nginx，请自行调整 deploy/install.sh 中的 nginx 安装步骤。" >&2
  exit 1
fi

if ! id dschat >/dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin dschat
fi

install -d -m 0755 "${APP_DIR}"
install -d -m 0755 "${APP_DIR}/backend" "${APP_DIR}/backend/scripts" "${APP_DIR}/web" "${APP_DIR}/scripts"
install -d -m 0700 -o dschat -g dschat "${DATA_DIR}"

# 代码与前端静态文件；保留 /var/lib/ds-chat 下的数据库
rm -rf "${APP_DIR}/backend/app"
cp -a "${ROOT}/backend/app" "${APP_DIR}/backend/app"
install -m 0644 "${ROOT}/backend/server.py" "${APP_DIR}/backend/server.py"
install -m 0644 "${ROOT}/backend/requirements.txt" "${APP_DIR}/backend/requirements.txt"
rm -rf "${APP_DIR}/web"
mkdir -p "${APP_DIR}/web"
cp -a "${ROOT}/frontend/dist/." "${APP_DIR}/web/"

install -m 0755 "${ROOT}/backend/scripts/hash_password.py" "${APP_DIR}/backend/scripts/hash_password.py"
install -m 0755 "${ROOT}/backend/scripts/setup_env.py" "${APP_DIR}/backend/scripts/setup_env.py"
install -m 0755 "${ROOT}/deploy/backup.py" "${APP_DIR}/scripts/backup.py"
install -d -m 0755 "${APP_DIR}/docs"
install -m 0644 "${ROOT}/docs/OPERATIONS.md" "${APP_DIR}/docs/OPERATIONS.md"

# Python 运行时
if [[ ! -x "${APP_DIR}/venv/bin/python" ]]; then
  python3 -m venv "${APP_DIR}/venv"
fi
"${APP_DIR}/venv/bin/pip" install --upgrade pip >/dev/null
"${APP_DIR}/venv/bin/pip" install --no-cache-dir -r "${APP_DIR}/backend/requirements.txt"

chown -R root:root "${APP_DIR}"
chmod -R a+rX "${APP_DIR}"
chown -R dschat:dschat "${DATA_DIR}"

install -m 0644 "${ROOT}/deploy/ds-chat.service" /etc/systemd/system/ds-chat.service
install -m 0644 "${ROOT}/deploy/nginx-ds-chat.conf" /etc/nginx/conf.d/ds-chat.conf
install -m 0644 "${ROOT}/deploy/ds-chat-backup.cron" /etc/cron.d/ds-chat-backup
chmod 0644 /etc/cron.d/ds-chat-backup

systemctl daemon-reload
if ! nginx -t; then
  echo "nginx 配置检查失败，请修复后再 reload。" >&2
  exit 1
fi
systemctl reload nginx

if [[ -f "${ENV_FILE}" ]]; then
  systemctl enable ds-chat >/dev/null
  systemctl restart ds-chat
  sleep 1
  systemctl --no-pager --full status ds-chat | head -20 || true
else
  cat <<EOF

安装完成，但还没有 ${ENV_FILE}。
请先运行（会交互式设置密码和 API Key）：
  ${APP_DIR}/venv/bin/python ${APP_DIR}/backend/scripts/setup_env.py

然后启动：
  systemctl enable --now ds-chat
EOF
fi
