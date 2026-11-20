# Jnyy DS Chat

一个轻量、单用户的 DeepSeek Web 聊天服务。只用一个访问密码登录，对话、分支和附件都保存在自己的服务器上。

后端是 Python + FastAPI + SQLite，前端是 React + Vite。没有账号体系、没有注册入口、没有数据库服务依赖，适合个人服务器或家庭 NAS 部署。

## 特性

低占用、低占用、低占用，重要的事情说三遍。你是否苦于LobeChat等项目过重，部署后轻量云服务器处于崩溃边缘？本项目部署后的内存占用预期在 **100MB以下** ，哪怕是 **1 vCPU 0.5 GiB** 的最低配服务器，也能达到运行条件！

## 功能

- 单密码登录，无用户名、无注册
- 流式输出、Markdown / GFM、代码高亮与复制、KaTeX 公式
- `deepseek-v4-pro` / `deepseek-flash` 模型切换
- 输入框旁控制深度思考，思维链折叠展示
- 停止生成、重新生成、自动标题
- 消息分支：编辑或重新生成时保留旧版本，通过 `< 1/2 >` 切换
- 全局搜索（`Ctrl+K`）：搜索标题和所有分支的消息，点击后自动切到对应分支
- 每轮输入 / 输出 / 推理 / 缓存 Token 统计，顶栏显示会话累计
- 回答可复制原始 Markdown 或去除 Markdown 的纯文本
- 右侧对话索引：数字轨道 + 展开面板，滚动时高亮当前问题
- 联网搜索开关：自动切换 Flash，展示联网状态、参考来源
- 文件 / 图片上传：选择器、拖拽、粘贴；图片直接识别，PDF / Word / PPT 解析文字
- 附件随消息保存，支持图片预览、文档下载、分支克隆
- 明暗主题、移动端适配
- 多标签页 / 多设备同步；生成中断会标记为“已中断”

不包含：多用户、知识库、公开 OpenAI 兼容 API、第三方登录。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python 3.12、FastAPI、Uvicorn、httpx、stdlib `sqlite3` |
| 数据库 | SQLite（WAL 模式） |
| 前端 | React 19、Vite 7、TypeScript |
| 前端运行时 | Node.js 20.19+（仅构建时需要） |
| 部署 | systemd + nginx，单 worker，应用只监听 `127.0.0.1` |
| 外部服务 | DeepSeek API（Chat Completions + Files API） |

## 项目结构

```text
backend/
  app/                 FastAPI 应用（鉴权、SQLite、SSE、DeepSeek 客户端）
  scripts/             密码哈希、交互式环境配置
  tests/               pytest 测试
  server.py            uvicorn 入口
  requirements.txt
frontend/              React / Vite 前端
deploy/
  install.sh           服务器安装 / 更新脚本
  ds-chat.service      systemd 单元
  nginx-ds-chat.conf   nginx server 块（需修改域名和证书路径）
  backup.py            SQLite 在线备份
  ds-chat-backup.cron  每日备份
docs/
  OPERATIONS.md        运维手册
```

## 本地开发

### 1. 后端

要求 Python 3.12+。

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
```

生成密码哈希（交互式，不进 shell 历史）：

```bash
.venv/bin/python backend/scripts/hash_password.py
```

启动后端。Linux / macOS：

```bash
export DEEPSEEK_API_KEY='sk-...'
export APP_PASSWORD_HASH='scrypt$...'
export SESSION_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
export DB_PATH="$PWD/backend/local.db"
export UPLOAD_DIR="$PWD/backend/uploads"
export COOKIE_SECURE=false
export COOKIE_NAME=ds_session
export PUBLIC_ORIGIN=http://127.0.0.1:5173
export DEBUG=true

cd backend
../.venv/bin/python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

Windows PowerShell：

```powershell
$env:DEEPSEEK_API_KEY='sk-...'
$env:APP_PASSWORD_HASH='scrypt$...'
$env:SESSION_SECRET=('a' * 64)
$env:DB_PATH="$PWD\backend\local.db"
$env:UPLOAD_DIR="$PWD\backend\uploads"
$env:COOKIE_SECURE='false'
$env:COOKIE_NAME='ds_session'
$env:PUBLIC_ORIGIN='http://127.0.0.1:5173'
$env:DEBUG='true'

cd backend
..\.venv\Scripts\python -m uvicorn server:app --host 127.0.0.1 --port 8000
```

### 2. 前端

要求 Node.js 20.19+（或 22.12+）和 pnpm。

```bash
cd frontend
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173`。Vite 会把 `/api` 代理到 `http://127.0.0.1:8000`。

### 3. 测试与构建

```bash
# 后端测试
cd backend
../.venv/bin/python -m pytest -q

# 前端生产构建
cd ../frontend
pnpm build
```

## 服务器部署

下面以 Ubuntu + systemd + nginx 为例。应用目录固定为 `/opt/ds-chat`，数据目录为 `/var/lib/ds-chat`。

### 1. 准备

- Python 3.12 + `python3-venv`
- nginx
- 一个域名和 TLS 证书（Let's Encrypt、云厂商证书、或内网自签证书均可）
- 服务器不需要 Node.js，前端在本机构建后上传

### 2. 修改 nginx 配置

编辑 `deploy/nginx-ds-chat.conf`，至少替换：

```nginx
server_name chat.example.com;
ssl_certificate     /etc/nginx/ssl/chat.example.com.crt;
ssl_certificate_key /etc/nginx/ssl/chat.example.com.key;
```

如果证书路径不同，改成自己的。该配置默认把 443 作为源站入口；如果你用 Caddy、Traefik 或云负载均衡，也可以跳过 nginx，直接把静态文件和 `/api` 反代到 `127.0.0.1:8787`。

`install.sh` 会检测占位域名并拒绝安装，避免把示例证书路径写进生产 nginx。

### 3. 构建并上传

```bash
cd frontend
pnpm build
```

把以下内容上传到服务器任意目录，例如 `/srv/ds-chat-src`：

```text
backend/
frontend/dist/
deploy/
docs/
```

### 4. 安装

```bash
cd /srv/ds-chat-src
sudo bash deploy/install.sh
```

脚本会：

- 创建系统用户 `dschat`
- 安装到 `/opt/ds-chat`
- 创建 `/var/lib/ds-chat`
- 建立 Python venv 并安装依赖
- 安装 systemd、nginx、备份 cron
- 执行 `nginx -t` 并 reload

首次没有 `/etc/ds-chat.env` 时不会启动服务。

### 5. 设置密码和 DeepSeek Key

```bash
sudo /opt/ds-chat/venv/bin/python /opt/ds-chat/backend/scripts/setup_env.py \
  --origin https://chat.example.com
```

按提示输入访问密码和 API Key。生成：

```text
/etc/ds-chat.env   640 root:dschat
```

启动：

```bash
sudo systemctl enable --now ds-chat
sudo systemctl status ds-chat
```

### 6. 验收

服务器本机：

```bash
curl -s http://127.0.0.1:8787/api/health
```

经 nginx：

```bash
curl -s https://chat.example.com/api/health
```

浏览器打开站点，输入密码即可。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek Key，仅服务端使用 | 必填 |
| `DEEPSEEK_BASE_URL` | API 地址 | `https://api.deepseek.com` |
| `APP_PASSWORD_HASH` | scrypt 密码哈希 | 必填 |
| `SESSION_SECRET` | 会话签名密钥，≥32 字符 | 必填 |
| `PUBLIC_ORIGIN` | 公开站点地址，用于 Origin 校验 | 空 |
| `DB_PATH` | SQLite 路径 | `/var/lib/ds-chat/chat.db` |
| `UPLOAD_DIR` | 附件本地目录 | `DB_PATH` 同级的 `uploads/` |
| `COOKIE_NAME` | 会话 Cookie 名 | `__Host-ds_session` |
| `COOKIE_SECURE` | 仅 HTTPS 发送 Cookie | `true` |
| `SESSION_TTL` | 会话有效期（秒） | `2592000`（30 天） |
| `MAX_CONTEXT_CHARS` | 发送给模型的历史字符上限 | `60000` |
| `MAX_OUTPUT_TOKENS` | 单次回复上限 | `8192` |
| `UPSTREAM_TIMEOUT` | DeepSeek 读超时（秒） | `300` |
| `DEBUG` | 开启 `/api/docs` 和本地 Origin | `false` |

生产环境必须使用 HTTPS，并让 `PUBLIC_ORIGIN` 与浏览器地址完全一致。`COOKIE_NAME` 默认带 `__Host-` 前缀，要求 `Secure`、无 `Domain`、`Path=/`。

## 模型与能力边界

| 模型 | API ID | 能力 |
|---|---|---|
| DeepSeek V4-Pro | `deepseek-v4-pro` | 通用 + 深度思考 |
| DeepSeek V4.1 Flash | `deepseek-flash` | 快速、联网搜索、文件 / 图片 |

- 深度思考在输入框旁开关，请求发送 `thinking: {"type":"enabled"}` 或 `disabled`
- 联网搜索和附件输入强制使用 `deepseek-flash`
- 联网搜索使用 DeepSeek 原生 `deepseek_web_search` / `deepseek_read_url`
- 文件上传通过 DeepSeek Files API 转发；图片原生识别，文档解析文字
- 单条消息最多 6 个附件：图片 64 MB、文档 100 MB、文本 / 表格 / 电子书 32 MB
- 文档默认只提取文字，不解析文档内嵌图片

## API

所有接口都在 `/api` 下。除登录和健康检查外，需要会话 Cookie。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/auth/session` | 当前会话状态 |
| POST | `/api/auth/login` | `{"password":"..."}` |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/conversations` | 会话列表 |
| POST | `/api/conversations` | 新建会话 |
| GET | `/api/conversations/{id}?after_id=` | 会话详情 / 增量消息 |
| PATCH | `/api/conversations/{id}` | 改标题 / 模型 |
| DELETE | `/api/conversations/{id}` | 删除 |
| POST | `/api/conversations/{id}/stop` | 停止生成 |
| POST | `/api/chat` | SSE 聊天 |
| POST | `/api/conversations/{id}/regenerate` | 重新生成 |
| POST | `/api/conversations/{id}/messages/{message_id}/edit` | 编辑用户消息并建分支 |
| POST | `/api/conversations/{id}/messages/{message_id}/activate` | 切换分支 |
| POST | `/api/files` | 上传附件（multipart） |
| GET | `/api/files/{id}/content` | 读取附件 |
| DELETE | `/api/files/{id}` | 删除未发送附件 |
| GET | `/api/search?q=` | 全局搜索所有分支 |

SSE 事件：`meta`、`delta`、`reasoning`、`search`、`sources`、`done`、`error`。

## 安全设计

- DeepSeek Key 只存在服务端环境文件，不进入前端 bundle
- 密码使用 scrypt 哈希，登录只交换签名 HttpOnly Cookie
- Cookie 默认 `Secure`、`SameSite=Lax`、30 天
- 写接口校验 `Origin`
- 登录失败有单进程内存限速
- 无注册、无 CORS、无找回密码流程
- Markdown 不启用原始 HTML；代码高亮输出经过转义
- nginx 只暴露 443；应用只绑定 `127.0.0.1`
- 附件读取接口需要登录，文件路径做根目录校验
- 单用户场景没有账号表；忘记密码用 `setup_env.py` 重设

这是单用户服务，不是多租户系统。不要把同一个实例给互不信任的人共用。

## 测试

```bash
cd backend
../.venv/bin/python -m pytest -q
```

测试覆盖登录、会话 CRUD、消息分支、全局搜索、联网搜索参数、文件上下文、深度思考参数等。

## 许可

MIT，见 [LICENSE](LICENSE)。

## 更多文档

- [运维手册](docs/OPERATIONS.md)
- [安全策略](SECURITY.md)
