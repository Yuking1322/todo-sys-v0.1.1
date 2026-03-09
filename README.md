# ✅ 待办同步中心（v0.1.1）

一个本地优先的待办系统，支持 OpenClaw 同步、AI 建任务、中文月历和 Docker 部署。

## ✨ 功能总览

- 🗂️ 任务 CRUD（新增/编辑/完成/删除）
- 🔄 OpenClaw 同步入口
- 🤖 AI 自动建待办（支持中文自然语义）
- 📅 中文月历（高亮今天、节假日/周末/调休区分）
- 📤 `.ics` 日历导出
- 🧠 存储后端可切换：`json` / `postgres`

## 🚀 快速开始（本地 JSON）

1. 安装依赖

```powershell
npm install
```

2. 复制环境变量

```powershell
Copy-Item .env.example .env
```

3. 确认 `.env` 使用 JSON（默认就是）

```powershell
DATA_BACKEND=json
```

4. 启动服务

```powershell
npm start
```

5. 打开页面

```text
http://127.0.0.1:5173
```

## 🐳 Docker + Nginx（推荐分享部署）

1. 准备配置（可选）

```powershell
Copy-Item .env.example .env
```

2. 确认 Docker Desktop / Docker Engine 已启动

3. 启动容器

```powershell
docker compose up -d --build
```

或

```powershell
npm run docker:up
```

4. 访问

```text
http://127.0.0.1:5173
```

5. 停止

```powershell
docker compose down
```

或

```powershell
npm run docker:down
```

说明：
- `nginx` 对外暴露 `5173`，反向代理到 `app`
- `app` 默认走 PostgreSQL（`DATA_BACKEND=postgres`）
- `db` 默认映射 `127.0.0.1:5432`

## 🛠️ JSON 迁移到 PostgreSQL

1. 初始化数据库

```powershell
npm run db:init
```

2. 迁移数据

```powershell
npm run db:migrate:json-to-postgres
```

如果目标库非空：

```powershell
npm run db:migrate:json-to-postgres -- --force
```

## 📜 API 列表

- `GET /api/health`
- `GET /api/tasks`
- `POST /api/tasks`
- `PATCH /api/tasks/:id`
- `DELETE /api/tasks/:id`
- `POST /api/sync/openclaw`
- `POST /api/ai/create-task`
- `GET /api/tasks.ics`
- `GET /api/day-notes?month=YYYY-MM`
- `PUT /api/day-notes/:date`（`date=YYYY-MM-DD`）
- `GET /api/holidays?year=YYYY`

## ⚙️ 关键环境变量

- `DATA_BACKEND=json|postgres`
- `DATABASE_URL`（优先）
- 或 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`
- `OPENCLAW_SYNC_TOKEN`
- `AI_API_BASE` / `AI_API_KEY` / `AI_MODEL`

## 🧪 CI 验证

仓库已包含 GitHub Actions：
- `node-smoke`：语法检查 + JSON API 烟测
- `docker-smoke`：Docker 构建 + 健康检查 + API 烟测

## 🔐 安全说明

- 已提供 [SECURITY.md](./SECURITY.md)
- 建议开启：`Dependabot alerts`、`Code scanning default setup`
- 不要提交 `.env`、密钥、真实业务数据

## 🧰 本地脚本

- `launch-web.bat`：一键启动并打开页面
- `stop-web.bat`：一键停止服务

无图形环境可设置：

```powershell
$env:SKIP_OPEN_BROWSER=1
```
