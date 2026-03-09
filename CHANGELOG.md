# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2026-03-09

### Added
- PostgreSQL storage backend with transactional sync version updates.
- Data migration scripts:
  - `scripts/init-db.js`
  - `scripts/migrate-json-to-postgres.js`
- Docker deployment files:
  - `Dockerfile`
  - `docker-compose.yml`
  - `nginx/default.conf`
- CI workflow:
  - `.github/workflows/ci.yml`
- Security policy:
  - `SECURITY.md`

### Changed
- Refactored `server.js` to use unified storage layer (`store.js`).
- Added npm scripts:
  - `db:init`
  - `db:migrate:json-to-postgres`
  - `docker:up`
  - `docker:down`
- Improved local start script resilience:
  - `start-local.ps1` no longer fails when browser auto-open is unavailable.
- Updated README for public sharing readability and deployment guidance.
- Fixed frontend visibility issue after task creation:
  - New tasks now auto-focus to their due date in the list/calendar.
  - Default task list no longer starts with a forced "today" date filter.
- Added write-token authorization for mutating APIs:
  - `APP_WRITE_TOKEN`
  - `X-App-Token` request header
- Added task date filter API:
  - `GET /api/tasks?date=YYYY-MM-DD`
- Improved JSON backend safety under concurrent requests:
  - serialized operation queue for file-based store
- Hardened Docker defaults:
  - required `POSTGRES_PASSWORD` / `APP_WRITE_TOKEN` / `OPENCLAW_SYNC_TOKEN`
  - removed default host exposure for PostgreSQL
- Expanded automated tests:
  - auth rejection
  - AI create flow
  - date filter flow
  - task status lifecycle flow
- Project version bumped to `0.1.1`.

### Notes
- JSON storage remains supported for local/lightweight usage.
- PostgreSQL is recommended for multi-user or deployment scenarios.

## [0.1.0] - Initial MVP

### Added
- Task CRUD API and Web UI.
- OpenClaw sync endpoint.
- AI create-task endpoint.
- Chinese calendar view and holiday support.
- `.ics` export support.
