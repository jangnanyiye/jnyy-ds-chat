# DS Chat 运维手册

本文以默认安装路径为例：

| 项目 | 默认值 |
|---|---|
| 公网地址 | `https://chat.example.com` |
| 应用目录 | `/opt/ds-chat` |
| 数据目录 | `/var/lib/ds-chat`（SQLite：`chat.db`，附件：`uploads/`） |
| 环境文件 | `/etc/ds-chat.env`（`640 root:dschat`） |
| systemd | `ds-chat.service` |
| 监听 | `127.0.0.1:8787` |
| nginx | `/etc/nginx/conf.d/ds-chat.conf` |
| 备份 | `/var/backups/ds-chat/`，每日 03:17，保留 7 天 |

请把 `chat.example.com` 换成你的域名，把 `root@your-server` 换成你的登录方式。

## 一、访问密码

### 修改密码

```bash
/opt/ds-chat/venv/bin/python /opt/ds-chat/backend/scripts/setup_env.py \
  --origin https://chat.example.com
systemctl restart ds-chat
```

按提示输入新密码；API Key 提示处直接回车可保留现有 Key。

`setup_env.py` 会保留已有 `SESSION_SECRET`，已登录设备不会因为改密码立即下线。

### 让所有设备立即失效

```bash
sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=$(openssl rand -hex 32)/" /etc/ds-chat.env
systemctl restart ds-chat
```

### 忘记密码

重复“修改密码”即可。服务端没有邮件找回流程。

## 二、DeepSeek API Key

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

不要把 Key 用 `echo` 打进 shell 历史，也不要提交到 Git。

### 验证

发送一条最短消息，例如「只回答：ok」。常见错误：

- `DeepSeek API Key 无效或已失效`
- `DeepSeek 账户余额不足`
- `请求过于频繁`

## 三、常用命令

```bash
systemctl status ds-chat
journalctl -u ds-chat -f
systemctl restart ds-chat
curl -s http://127.0.0.1:8787/api/health
curl -s https://chat.example.com/api/health
nginx -t
tail -f /var/log/nginx/ds-chat.error.log
```

## 四、备份与恢复

### 数据库

```bash
/opt/ds-chat/venv/bin/python /opt/ds-chat/scripts/backup.py
ls -lh /var/backups/ds-chat/
```

定时任务位于 `/etc/cron.d/ds-chat-backup`，每天 03:17 执行，保留 7 天。

### 附件

`backup.py` 只备份 SQLite，不包含 `/var/lib/ds-chat/uploads`。完整迁移时同时备份：

```bash
tar -czf ds-chat-uploads-$(date +%Y%m%d).tar.gz -C /var/lib/ds-chat uploads
```

### 恢复

```bash
systemctl stop ds-chat
cp /var/backups/ds-chat/chat-YYYYMMDD-HHMMSS.db /var/lib/ds-chat/chat.db
rm -f /var/lib/ds-chat/chat.db-wal /var/lib/ds-chat/chat.db-shm
chown dschat:dschat /var/lib/ds-chat/chat.db
systemctl start ds-chat
```

附件按需恢复，并保持 `dschat:dschat` 权限。

## 五、更新应用

```bash
cd frontend
pnpm build
```

上传 `backend/`、`frontend/dist/`、`deploy/`、`docs/` 到服务器，例如 `/srv/ds-chat-src`：

```bash
cd /srv/ds-chat-src
sudo bash deploy/install.sh
```

脚本保留 `/var/lib/ds-chat` 下的数据库/附件和 `/etc/ds-chat.env`，自动执行数据库迁移。

## 六、PWA 与缓存

- `manifest.webmanifest` 和 `sw.js` 使用 no-cache；Service Worker 不缓存 `/api`。
- 更新后如果安装版仍显示旧页面，关闭并从主屏幕重新打开，或清除站点数据。
- 状态栏颜色使用 `theme-color`：亮色 `#ffffff`，暗色 `#212327`。
- 用户设置（主题、显示项、默认提示词/单轮、搜索步进）保存在浏览器 localStorage。

## 七、常见问题

### 502 Bad Gateway

```bash
systemctl status ds-chat
journalctl -u ds-chat -n 80 --no-pager
ss -ltnp | grep 8787
```

### 登录一直 401

- 确认使用 `https://`
- 确认浏览器未禁用 Cookie
- 确认 `PUBLIC_ORIGIN` 与当前域名完全一致

```bash
grep '^PUBLIC_ORIGIN=' /etc/ds-chat.env
```

### 403 非法请求来源

`Origin` 与 `PUBLIC_ORIGIN` 不一致，检查协议、域名、端口和末尾斜杠。

### 429 尝试过于频繁

登录失败 5 次锁 60 秒；等待或重启服务清空内存限速：

```bash
systemctl restart ds-chat
```

### 流式输出中断

确认 nginx 配置包含：

```nginx
proxy_buffering off;
proxy_cache off;
add_header X-Accel-Buffering no always;
```

并保留 `gzip off;`。长思考超时由 `UPSTREAM_TIMEOUT`（默认 1800 秒）和 nginx 的 1800 秒读写超时共同控制。

### 上传失败

检查三层限制：

1. nginx `client_max_body_size`（110 MB）
2. 应用单文件限制（图片 64 MB、文档 100 MB、文本 32 MB）
3. 上层 CDN/负载均衡的请求体上限

### 证书/域名

- 使用受信任证书，或按需要配置 CDN 边缘证书。
- 使用 CDN 回源时，源站可使用自签证书，并按 CDN 要求忽略源站证书校验。
- 直接访问自签源站出现证书警告是正常现象。

## 八、安全提醒

- 不要把 `/etc/ds-chat.env` 提交到 Git、发到聊天或贴到公开网页。
- 使用 16 位以上随机访问密码。
- 定期备份数据库和附件目录。
- 单用户服务，不要把实例给互不信任的人共用。
- 分享或发布代码前，确认没有把真实 Key、密码哈希、Cookie 或用户数据带进去。
