# 待办同步中心（MVP）

本项目是本地优先的待办系统，支持：
- 任务 CRUD
- OpenClaw 同步入口
- AI 自动建待办
- 中文月历（高亮今天、节假日/周末/调休区分）
- 日历导出 `.ics`
- 存储后端可选：`json` 或 `postgres`

## CI 验证

仓库包含 GitHub Actions：
- `node-smoke`：Node 语法检查 + JSON 后端 API 烟测
- `docker-smoke`：Docker Compose 构建 + 健康检查 + API 烟测

## 本地启动（JSON）

1. 安装依赖：

```powershell
npm install
```

2. 复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

3. 使用 JSON 存储（默认已是 JSON）：

```powershell
# .env
DATA_BACKEND=json
```

4. 启动服务：

```powershell
npm start
```

5. 打开：

```text
http://127.0.0.1:5173
```

## Docker + Nginx（推荐部署）

1. 准备配置（可选）：

```powershell
Copy-Item .env.example .env
```

确认 Docker Desktop / Docker Engine 已启动。

2. 启动：

```powershell
docker compose up -d --build
```

或：

```powershell
npm run docker:up
```

3. 访问：

```text
http://127.0.0.1:5173
```

4. 停止：

```powershell
docker compose down
```

或：

```powershell
npm run docker:down
```

说明：
- `nginx` 对外暴露 `5173`，反向代理到 `app` 容器。
- `app` 默认使用 PostgreSQL（`DATA_BACKEND=postgres`）。
- `db` 默认映射宿主机 `127.0.0.1:5432`，便于本机脚本迁移数据。

## JSON 迁移到 PostgreSQL

1. 初始化数据库结构：

```powershell
npm run db:init
```

2. 迁移 `data/todos.json` 到 PostgreSQL：

```powershell
npm run db:migrate:json-to-postgres
```

如果目标库不为空：

```powershell
npm run db:migrate:json-to-postgres -- --force
```

## 一键脚本（本机）

- `launch-web.bat`：一键启动并打开页面
- `stop-web.bat`：一键停止服务

如在无图形环境运行，可设置：

```powershell
$env:SKIP_OPEN_BROWSER=1
```

## API

- `GET /api/health`
- `GET /api/tasks`
- `POST /api/tasks`
- `PATCH /api/tasks/:id`
- `DELETE /api/tasks/:id`
- `POST /api/sync/openclaw`
- `POST /api/ai/create-task`
- `GET /api/tasks.ics`
- `GET /api/day-notes?month=YYYY-MM`
- `PUT /api/day-notes/:date`（`date = YYYY-MM-DD`）
- `GET /api/holidays?year=YYYY`

## 环境变量

关键变量：
- `DATA_BACKEND=json|postgres`
- `DATABASE_URL`（可选，优先）
- 或 `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`
- `OPENCLAW_SYNC_TOKEN`
- `AI_API_BASE` / `AI_API_KEY` / `AI_MODEL`

## 节假日说明

节假日数据优先使用在线接口：
- `HOLIDAY_YEAR_API`（默认 `timor`）
- `HOLIDAY_FALLBACK_API`

如果在线接口不可用，会启用内置兜底节日（元旦/劳动节/国庆）并继续显示周末颜色。

## AI 输入说明

`POST /api/ai/create-task` 支持：
- 明确日期时间：`2026-03-10 18:30`
- 相对日期：`today/tomorrow/day after tomorrow`、`今天/明天/后天`
- 完成态关键词：`done/completed/完成`

如配置 `AI_API_BASE`、`AI_API_KEY`、`AI_MODEL`，会优先调用外部模型解析。
