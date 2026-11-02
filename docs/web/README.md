# Pi Web

`pi` 的本地浏览器 UI，共用同一份 `~/.pi/agent` 配置和 session 文件，可在浏览器里浏览/续跑对话、配模型和资源、看项目文件。

当前环境：`pi-web 0.13.0`（`@agegr/pi-web`）↔ `pi-coding-agent 1.4.0`。

## 安装

要求 `Node >= 22.19.0`：

```bash
node --version
npm --version
```

免安装直接跑（会打开浏览器）：

```bash
npx @agegr/pi-web@latest
```

装成全局命令（本机即此方式，`pi-web` 指向 `~/.nvm/.../bin/pi-web`）：

```bash
npm install -g @agegr/pi-web@latest
```

确认安装：

```bash
command -v pi-web
pi-web version  # 或 pi-web --version / -v，本机为 0.13.0
pi-web status   # 列出正在运行的 server
```

更新/卸载：

```bash
pi-web stop
pi-web update          # 等价于重新 npm install -g @agegr/pi-web@latest
pi-web update --check  # 只检查，不安装
npm uninstall -g @agegr/pi-web
```

## 启动

默认只绑 `127.0.0.1:30141` 并自动打开浏览器：

```bash
pi-web
# 浏览器没弹出来就手动开 http://127.0.0.1:30141
```

常用启动选项（命令行优先于同名环境变量）：

```bash
pi-web --help
pi-web -p 8080 --no-open
pi-web -H 0.0.0.0 -p 30141 --no-open
```

| 选项 / 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `-p, --port <port>` / `PORT` | 监听端口 | `30141` |
| `-H, --hostname <host>` / `PI_WEB_HOSTNAME` | 绑定地址 | `127.0.0.1` |
| `--no-open` / `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_PASSWORD` | 浏览器密码登录；API 可用 `pi` 做用户名走 Basic Auth | 不开启鉴权 |
| `PI_WEB_ALLOWED_HOSTS` | 反向代理的外部精确 hostname 白名单，逗号分隔 | 未设置 |
| `PI_WEB_APP_NAME` | PWA manifest 名称，改后重启生效 | `Pi Web` |
| `PI_WEB_SKIP_VERSION_CHECK=1` | 关掉版本更新检查 | 未设置 |
| `PI_WEB_IDLE_TIMEOUT_MS` | session 空闲超时，`0` 表示不回收 | `600000`（10 分钟） |
| `PI_WEB_SHUTDOWN_DEADLINE_MS` | 关闭时等扩展 `session_shutdown` 的时限 | `5000`（5 秒） |

## 基本命令

```bash
pi-web version          # 打印已安装版本
pi-web status           # 列出运行中的 server（pid / port / url / version）
pi-web open [--port N]  # 在浏览器打开运行中的 server
pi-web stop [--port N]  # 停掉运行中的 server
pi-web update [--check] # 升级全局安装（只查加 --check）
```

运行记录在 `~/.pi/agent/pi-web-run/<pid>.json`，含 `port/hostname/url/version/startedAt`。

## 使用

1. `pi-web` 启动后开 `http://127.0.0.1:30141`。
2. 没配过模型先去 **Models** 面板 `/login` 同款登录或填 API Key，和 `pi` 共用同一套 model/settings/credential 存储。
3. 左栏按项目分组浏览 session：恢复、重命名、导出、删除、看 running 状态/context 用量/cost；分支用 **New session**（独立新文件）或 **Edit from here**（当前内分支）。
4. 文件侧栏可浏览/上传、看 Git diff、预览源码/Markdown/图片/音频/PDF/DOCX；同一仓库的 session 保持分组，worktree 可在侧栏切换。
5. 用完 `pi-web stop` 停服；改端口/密码/App 名等需重启生效。

数据说明：

```bash
~/.pi/agent                          # pi-web 默认读的 agent 数据目录
~/.pi/agent/sessions/<encoded-cwd>/  # session 文件
~/.pi/agent/pi-web-run/               # 运行记录
```

可用 `PI_CODING_AGENT_DIR` 换 agent 数据目录；`pi-web` 必须能读到 session 里记录的工作目录，否则共享历史 session 会打不开。文件浏览器只限已选工作目录/已知项目根，不是通用文件管理器。

## 远程访问

绑非回环地址等于暴露可执行高权限动作的 agent，只在可信 LAN 做，且必须设长随机密码；密码只做登录鉴权，不加密传输，不要直接裸 HTTP 暴露到公网，走可信反向代理 HTTPS 或 VPN：

```bash
PI_WEB_PASSWORD='a-long-random-password' pi-web --hostname 0.0.0.0
```

反向代理带外部 hostname 时，把该精确 hostname 加进白名单（只做允许，不改变绑定地址）：

```bash
PI_WEB_ALLOWED_HOSTS='pi.example.com' PI_WEB_PASSWORD='...' pi-web -H 0.0.0.0
```

服务端模型请求的代理走标准环境变量：

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
pi-web
```
