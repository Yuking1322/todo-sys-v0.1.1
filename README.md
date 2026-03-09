# ✅ 待办同步中心（v0.1.1）

一个本地优先的待办系统，支持 OpenClaw 同步、AI 建任务、中文月历和 Docker 部署。

## ✨ 功能总览

- 🗂️ 任务 CRUD（新增/编辑/完成/删除）
- 🔄 OpenClaw 同步入口
- 🤖 AI 自动建待办（支持中文自然语义）
- 📅 中文月历（高亮今天、节假日/周末/调休区分）
- 📤 `.ics` 日历导出
- 🧠 存储后端可切换：`json` / `postgres`
- 🔐 写操作令牌鉴权（`APP_WRITE_TOKEN`，可选开启）

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

4. （可选）开启写保护令牌

```powershell
APP_WRITE_TOKEN=your_strong_write_token
```

开启后，在页面左侧“写入令牌”输入框里保存同一个令牌，才能执行新增/修改/删除。

5. 启动服务

```powershell
npm start
```

6. 打开页面

```text
http://127.0.0.1:5173
```

## 🐳 Docker + Nginx（推荐分享部署）

1. 准备配置（可选）

```powershell
Copy-Item .env.example .env
```

2. 在 `.env` 里设置必填安全变量（必须改成你自己的）

```powershell
POSTGRES_PASSWORD=your_strong_db_password
APP_WRITE_TOKEN=your_strong_write_token
OPENCLAW_SYNC_TOKEN=your_strong_openclaw_token
```

3. 确认 Docker Desktop / Docker Engine 已启动

4. 启动容器

```powershell
docker compose up -d --build
```

或

```powershell
npm run docker:up
```

5. 访问

```text
http://127.0.0.1:5173
```

6. 停止

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
- `db` 默认不对宿主机开放端口（仅容器内可访问）
- `APP_WRITE_TOKEN` 开启后，写接口必须带 `X-App-Token`

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
- `GET /api/tasks?date=YYYY-MM-DD`
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
- `APP_WRITE_TOKEN`
- `AI_API_BASE` / `AI_API_KEY` / `AI_MODEL`

## 🧪 CI 验证

仓库已包含 GitHub Actions：
- `node-smoke`：语法检查 + 集成测试（鉴权、AI 创建、日期筛选、状态流转）
- `docker-smoke`：Docker 构建 + 健康检查 + API 烟测

本地也可直接跑：

```powershell
npm test
```

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
