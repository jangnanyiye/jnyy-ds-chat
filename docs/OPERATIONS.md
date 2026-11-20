# DS Chat 运维手册

本文以默认安装路径为例：

| 项目 | 默认值 |
|---|---|
| 公网地址 | `https://chat.example.com` |
| 应用目录 | `/opt/ds-chat` |
| 数据目录 | `/var/lib/ds-chat` |
| SQLite | `/var/lib/ds-chat/chat.db` |
| 附件目录 | `/var/lib/ds-chat/uploads` |
| 环境文件 | `/etc/ds-chat.env`（`640 root:dschat`） |
| systemd | `ds-chat.service` |
| 监听 | `127.0.0.1:8787` |
| nginx | `/etc/nginx/conf.d/ds-chat.conf` |
| 备份 | `/var/backups/ds-chat/`，每日 03:17，保留 7 天 |

请把 `chat.example.com` 换成你的域名，把 `root@your-server` 换成你的登录方式。

## 一、修改访问密码

登录服务器：

```bash
ssh root@your-server
```

运行交互式配置：

```bash
/opt/ds-chat/venv/bin/python /opt/ds-chat/backend/scripts/setup_env.py \
  --origin https://chat.example.com
```

会依次提示：

1. `新访问密码（至少 12 位）`
2. `再输一次`
3. `DeepSeek API Key（已配置，直接回车保留）`

然后重启：

```bash
systemctl restart ds-chat
```

验证：

```bash
systemctl status ds-chat
curl -s https://chat.example.com/api/health
```

> `setup_env.py` 会保留已有 `SESSION_SECRET`，已登录设备不会因为改密码被踢下线。

### 让所有已登录设备立即失效

轮换会话签名密钥：

```bash
sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" /etc/ds-chat.env
systemctl restart ds-chat
```

所有旧 Cookie 立即失效，需要重新登录。

### 忘记密码

重复“修改访问密码”即可。服务端没有邮件找回流程。

## 二、修改 DeepSeek API Key

### 方法 A：编辑环境文件（推荐）

```bash
nano /etc/ds-chat.env
```

替换：

```text
DEEPSEEK_API_KEY=sk-...
```

保存后：

```bash
systemctl restart ds-chat
journalctl -u ds-chat -n 30 --no-pager
```

保持权限：

```bash
chown root:dschat /etc/ds-chat.env
chmod 640 /etc/ds-chat.env
```

### 方法 B：用 setup_env.py

```bash
/opt/ds-chat/venv/bin/python /opt/ds-chat/backend/scripts/setup_env.py \
  --origin https://chat.example.com
systemctl restart ds-chat
```

在 API Key 提示处输入新 Key。

### 验证 Key

在网页发一条最短消息，例如“只回答：ok”。

常见错误：

- `DeepSeek API Key 无效或已失效`：Key 错误或已被删除
- `DeepSeek 账户余额不足`：账户余额问题
- `请求过于频繁`：触发限流，稍后再试

日志：

```bash
journalctl -u ds-chat -n 50 --no-pager
```

## 三、查看配置但不暴露机密

只查看非机密项：

```bash
grep -vE '^(DEEPSEEK_API_KEY|APP_PASSWORD_HASH|SESSION_SECRET)=' /etc/ds-chat.env
```

确认权限：

```bash
stat -c '%a %U:%G %n' /etc/ds-chat.env
# 期望：640 root:dschat
```

## 四、常用命令

```bash
# 状态
systemctl status ds-chat

# 实时日志
journalctl -u ds-chat -f

# 重启
systemctl restart ds-chat

# 健康检查（本机）
curl -s http://127.0.0.1:8787/api/health

# 公网健康检查
curl -s https://chat.example.com/api/health

# nginx 检查
nginx -t

# nginx 日志
tail -f /var/log/nginx/ds-chat.error.log
```

## 五、备份与恢复

### 手动备份

```bash
/opt/ds-chat/venv/bin/python /opt/ds-chat/scripts/backup.py
ls -lh /var/backups/ds-chat/
```

备份只包含 SQLite 数据库，不包含 `/var/lib/ds-chat/uploads` 下的附件文件。若需要完整迁移，请同时备份附件目录。

### 恢复

```bash
systemctl stop ds-chat
cp /var/backups/ds-chat/chat-YYYYMMDD-HHMMSS.db /var/lib/ds-chat/chat.db
rm -f /var/lib/ds-chat/chat.db-wal /var/lib/ds-chat/chat.db-shm
chown dschat:dschat /var/lib/ds-chat/chat.db
systemctl start ds-chat
```

## 六、更新应用

本机构建前端：

```bash
cd frontend
pnpm build
```

上传 `backend/`、`frontend/dist/`、`deploy/`、`docs/` 到服务器，例如 `/srv/ds-chat-src`，然后：

```bash
cd /srv/ds-chat-src
bash deploy/install.sh
```

脚本会保留 `/var/lib/ds-chat` 下的数据库、附件和 `/etc/ds-chat.env`。

## 七、常见问题

### 502 Bad Gateway

```bash
systemctl status ds-chat
journalctl -u ds-chat -n 80 --no-pager
ss -ltnp | grep 8787
```

应用没起来时 nginx 会返回 502。

### 登录一直 401

- 确认访问的是 `https://`
- 确认浏览器没有禁用 Cookie
- 确认 `PUBLIC_ORIGIN` 与当前域名完全一致
- 确认 `COOKIE_NAME` 使用 `__Host-` 前缀时满足 `Secure`、`Path=/`、无 `Domain`

```bash
grep '^PUBLIC_ORIGIN=' /etc/ds-chat.env
```

### 403 非法请求来源

`Origin` 与 `PUBLIC_ORIGIN` 不一致。检查协议、域名、端口和末尾斜杠。

### 429 尝试过于频繁

登录失败会触发单进程内存限速。等待后重试，或重启服务清空：

```bash
systemctl restart ds-chat
```

### 流式输出卡住

确认 nginx 配置包含：

```nginx
proxy_buffering off;
proxy_cache off;
add_header X-Accel-Buffering no always;
```

并确认 `gzip off;`。

### 上传大文件失败

检查三层限制：

1. nginx `client_max_body_size`（默认 110 MB）
2. 应用的单文件限制（图片 64 MB、文档 100 MB、文本 32 MB）
3. 如果前面还有云负载均衡 / CDN，检查它自己的请求体上限

### 证书 / 域名问题

- nginx 配置中的 `server_name` 和证书路径必须与你的部署一致
- 使用 Let's Encrypt 时，把证书路径改成 `/etc/letsencrypt/live/...`
- 使用云 CDN / ESA 时，源站可以是自签证书，回源需忽略证书校验
- 直接访问自签源站出现证书警告是正常现象，生产入口应使用受信任证书

## 八、安全提醒

- 不要把 `/etc/ds-chat.env` 提交到 Git、发到聊天或贴到公开网页
- 使用 16 位以上随机密码
- 生产环境设置 `COOKIE_SECURE=true`
- 定期备份数据库和附件目录
- 只把服务给可信的人使用；这是单用户应用，不是多租户系统
- 更换服务器或公开仓库前，确认没有把真实 Key、密码哈希或会话 Cookie 带进去
