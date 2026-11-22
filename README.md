# Jnyy DS Chat

一个轻量、单用户的 DeepSeek Web 聊天服务。只用一个访问密码登录，对话、分支和附件都保存在自己的服务器上。

后端是 Python + FastAPI + SQLite，前端是 React + Vite。没有账号体系、没有注册入口、没有数据库服务依赖，适合个人服务器或家庭 NAS 部署。

## 特性

低占用、低占用、低占用，重要的事情说三遍。你是否苦于LobeChat等项目过重，部署后轻量云服务器处于崩溃边缘？本项目部署后的内存占用预期在 **100MB以下** ，哪怕是 **1 vCPU 0.5 GiB** 的最低配服务器，也能达到运行条件！

## 适用群体

- 习惯了多设备同步的体验
- 习惯了官方网页聊天逻辑
- 不想为此加购大量云资源
- 愿意承担聊天产生的费用
- 用户只有一个人但多终端

## 功能

- 单密码登录，无用户名、无注册、无账号体系
- 流式输出、Markdown/GFM、KaTeX、代码高亮与复制
- `deepseek-v4-pro` / `deepseek-flash` 切换，输入框控制深度思考
- 停止生成、重新生成、自动标题
- 消息分支：编辑或重新生成后保留旧版本，通过 `< 1/2 >` 切换
- 全局搜索（`Ctrl+K`）：标题和所有分支消息，命中的旧分支会自动激活
- 对话列表与搜索结果按最近更新时间分页加载，可配置搜索步进
- 每轮 token 统计，可在设置中隐藏
- 右侧对话索引：数字轨道 + 可展开面板
- 系统提示词库：对话开始时选择，随对话保存快照，之后与提示词库解耦
- 单轮对话：同一对话连续提问，但每轮只发送当前问题、系统提示词和手动引用
- 消息引用：手动带入历史上下文，适合单轮追问，引用不能单独发送
- 联网搜索开关：自动切换 Flash，展示来源和引用
- 文件/图片上传：选择器、拖拽、粘贴；支持仅附件发送
- 图片原生识别；PDF / Word / PPT 解析文字
- PWA：Android 安装、窗口复用、全面屏安全区、状态栏配色
- 设置页：主题、显示项、新对话默认值、搜索步进、手册、退出登录
- 明暗主题跟随系统加载，可锁定深色；代码块亮暗主题分别配色
- 移动端不自动聚焦，助手头像和名称置于正文上方

不包含：多用户、知识库、对外 OpenAI API、第三方登录。

## 使用说明

详细操作见 [docs/USAGE.md](docs/USAGE.md)。常见入口：

- 设置：侧栏底部「设置」
- 搜索：`Ctrl+K`
- 系统提示词/单轮：新对话开始前，在顶栏设置按钮中配置
- 引用：消息下方「引用」按钮
- 文件：输入框左侧回形针、拖拽、粘贴

## 本地开发

要求 Python 3.12+，前端要求 Node.js 20.19+（或 22.12+）和 pnpm。

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt

.venv/bin/python backend/scripts/hash_password.py
```

后端环境变量示例：

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

前端：

```bash
cd frontend
pnpm install
pnpm dev
```

打开 `http://127.0.0.1:5173`，Vite 会把 `/api` 代理到 `127.0.0.1:8000`。

测试与构建：

```bash
cd backend && ../.venv/bin/python -m pytest -q
cd frontend && pnpm build
```

Windows 下把 `.venv/bin/python` 换成 `.venv\Scripts\python`，环境变量用 `$env:NAME='value'`。

## 部署概览

生产部署由 `deploy/install.sh` 完成：创建 `dschat` 用户、安装到 `/opt/ds-chat`、建立 venv、安装 systemd/nginx/备份 cron。

```bash
cd frontend
pnpm build

# 上传 backend/、frontend/dist/、deploy/、docs/ 到服务器后：
cd /srv/ds-chat-src
sudo bash deploy/install.sh

sudo /opt/ds-chat/venv/bin/python /opt/ds-chat/backend/scripts/setup_env.py \
  --origin https://chat.example.com
sudo systemctl enable --now ds-chat
```

部署前必须修改 `deploy/nginx-ds-chat.conf` 的 `server_name` 和证书路径；脚本检测到 `chat.example.com` 占位会拒绝安装。

详细运维步骤见 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 环境变量

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek Key，仅服务端 | 必填 |
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
| `UPSTREAM_TIMEOUT` | DeepSeek 读超时（秒） | `1800` |
| `DEBUG` | 开启 `/api/docs` 和本地 Origin | `false` |

## PWA

- Android Chrome / Edge 可安装到主屏幕。
- manifest 使用 `display: standalone` 和 `launch_handler: focus-existing`。
- `viewport-fit=cover` + `env(safe-area-inset-*)` 适配状态栏、刘海和手势条。
- 状态栏跟随应用背景：亮色白色，暗色深色。
- Service Worker 只缓存应用壳和静态资源，不缓存 `/api`。
- 当前优先适配 Android，iOS 暂不作为目标。

## API

除登录/健康检查外都需要会话 Cookie。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/auth/session` | 当前会话状态 |
| POST | `/api/auth/login` | `{"password":"..."}` |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/prompts` | 提示词列表 |
| POST | `/api/prompts` | 新建提示词 |
| PATCH | `/api/prompts/{id}` | 修改提示词 |
| DELETE | `/api/prompts/{id}` | 删除提示词 |
| GET | `/api/conversations?limit=&offset=` | 分页会话列表 |
| POST | `/api/conversations` | 新建会话 |
| GET | `/api/conversations/{id}?after_id=` | 会话详情/增量消息 |
| PATCH | `/api/conversations/{id}` | 标题/模型/提示词/单轮设置 |
| DELETE | `/api/conversations/{id}` | 删除 |
| POST | `/api/conversations/{id}/stop` | 停止生成 |
| POST | `/api/conversations/{id}/regenerate` | 重新生成 |
| POST | `/api/conversations/{id}/messages/{message_id}/edit` | 编辑用户消息并建分支 |
| POST | `/api/conversations/{id}/messages/{message_id}/activate` | 激活分支 |
| GET | `/api/search?q=&limit=&offset=` | 分页全局搜索 |
| POST | `/api/files` | 上传附件 |
| GET | `/api/files/{id}/content` | 读取附件 |
| DELETE | `/api/files/{id}` | 删除未发送附件 |

SSE 事件：`meta`、`delta`、`reasoning`、`search`、`sources`、`done`、`error`。

## 安全边界

- DeepSeek Key 只存在 `/etc/ds-chat.env`，不进入前端 bundle。
- 密码使用 scrypt；Cookie 为 HttpOnly、Secure、SameSite=Lax。
- 写接口校验 Origin；无 CORS、无注册入口。
- 登录失败有单进程内存限速。
- Markdown 不启用原始 HTML；代码高亮输出经过转义。
- nginx 只暴露 443；应用只绑定 `127.0.0.1`。
- 附件读取需要登录，文件路径做根目录校验。
- 单用户场景没有账号表；忘记密码用 `setup_env.py` 重设。

## 文档

- [使用手册](docs/USAGE.md)
- [运维手册](docs/OPERATIONS.md)
- [安全策略](SECURITY.md)
- 许可：MIT，见 [LICENSE](LICENSE)
