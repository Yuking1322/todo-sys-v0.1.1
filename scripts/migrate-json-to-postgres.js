const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
const DATA_FILE = path.join(ROOT_DIR, "data", "todos.json");
loadDotEnv(path.join(ROOT_DIR, ".env"));

async function main() {
  const force = process.argv.includes("--force");
  const source = readJsonStore(DATA_FILE);
  const { Pool } = requirePg();
  const pool = new Pool(buildPgConfig());
  const initSql = fs.readFileSync(path.join(ROOT_DIR, "db", "init.sql"), "utf8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(initSql);

    const existing = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM tasks) AS tasks_count,
         (SELECT COUNT(*) FROM day_notes) AS notes_count,
         (SELECT sync_version FROM app_state WHERE id = TRUE) AS sync_version`,
    );

    const row = existing.rows[0];
    const tasksCount = Number(row.tasks_count || 0);
    const notesCount = Number(row.notes_count || 0);
    const syncVersion = Number(row.sync_version || 0);

    if (!force && (tasksCount > 0 || notesCount > 0 || syncVersion > 0)) {
      throw new Error(
        "Target database is not empty. Re-run with --force if you want to overwrite existing data.",
      );
    }

    await client.query("TRUNCATE TABLE tasks");
    await client.query("TRUNCATE TABLE day_notes");
    await client.query("UPDATE app_state SET sync_version = 0 WHERE id = TRUE");

    for (const task of source.tasks) {
      const normalized = normalizeTask(task);
      await client.query(
        `INSERT INTO tasks (
           id,
           external_id,
           title,
           notes,
           due_at,
           status,
           source,
           created_at,
           updated_at,
           deleted_at,
           version
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          normalized.id,
          normalized.externalId,
          normalized.title,
          normalized.notes,
          normalized.dueAt,
          normalized.status,
          normalized.source,
          normalized.createdAt,
          normalized.updatedAt,
          normalized.deletedAt,
          normalized.version,
        ],
      );
    }

    for (const [dateKey, contentRaw] of Object.entries(source.dayNotes)) {
      if (typeof contentRaw !== "string") {
        continue;
      }
      const content = contentRaw.trimEnd();
      if (!content.trim()) {
        continue;
      }
      await client.query(
        `INSERT INTO day_notes (date_key, content)
         VALUES ($1::date, $2)
         ON CONFLICT (date_key)
         DO UPDATE SET content = EXCLUDED.content`,
        [dateKey, content.slice(0, 500)],
      );
    }

    const maxTaskVersion = source.tasks.reduce((accumulator, task) => {
      const version = Number(task.version || 0);
      return Number.isFinite(version) ? Math.max(accumulator, version) : accumulator;
    }, 0);
    const targetSyncVersion = Math.max(Number(source.syncVersion || 0), maxTaskVersion);
    await client.query("UPDATE app_state SET sync_version = $1 WHERE id = TRUE", [
      targetSyncVersion,
    ]);

    await client.query("COMMIT");
    console.log(
      `Migration completed. tasks=${source.tasks.length}, dayNotes=${Object.keys(source.dayNotes).length}, syncVersion=${targetSyncVersion}`,
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function normalizeTask(task) {
  if (!task || typeof task !== "object") {
    throw new Error("Invalid task item in source file");
  }

  const id = String(task.id || "").trim();
  const title = String(task.title || "").trim();
  if (!id) {
    throw new Error("Task id is missing");
  }
  if (!title) {
    throw new Error(`Task title is missing. taskId=${id}`);
  }

  const now = new Date().toISOString();
  const createdAt = toIsoOrFallback(task.createdAt, now);
  const updatedAt = toIsoOrFallback(task.updatedAt, createdAt);
  const rawVersion = Number(task.version);
  const version =
    Number.isFinite(rawVersion) && rawVersion >= 0 ? Math.trunc(rawVersion) : 0;
  const externalId =
    typeof task.externalId === "string" && task.externalId.trim() ? task.externalId.trim() : null;

  return {
    id,
    externalId,
    title: title.slice(0, 120),
    notes: typeof task.notes === "string" ? task.notes.slice(0, 2000) : "",
    dueAt: toIsoOrNull(task.dueAt),
    status: task.status === "done" ? "done" : "todo",
    source: typeof task.source === "string" && task.source.trim() ? task.source : "web",
    createdAt,
    updatedAt,
    deletedAt: toIsoOrNull(task.deletedAt),
    version,
  };
}

function toIsoOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function toIsoOrFallback(value, fallback) {
  const parsed = toIsoOrNull(value);
  return parsed || fallback;
}

function readJsonStore(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
    throw new Error("Invalid source data shape");
  }
  if (!parsed.dayNotes || typeof parsed.dayNotes !== "object" || Array.isArray(parsed.dayNotes)) {
    parsed.dayNotes = {};
  }
  if (typeof parsed.syncVersion !== "number") {
    parsed.syncVersion = 0;
  }
  return parsed;
}

function requirePg() {
  try {
    return require("pg");
  } catch {
    throw new Error("Missing dependency: pg. Run `npm install` first.");
  }
}

function buildPgConfig() {
  const config = {};

  if (process.env.DATABASE_URL) {
    config.connectionString = process.env.DATABASE_URL;
  } else if (process.env.PGHOST) {
    config.host = process.env.PGHOST;
    if (process.env.PGPORT) config.port = Number(process.env.PGPORT);
    if (process.env.PGUSER) config.user = process.env.PGUSER;
    if (process.env.PGPASSWORD) config.password = process.env.PGPASSWORD;
    if (process.env.PGDATABASE) config.database = process.env.PGDATABASE;
  } else {
    throw new Error(
      "PostgreSQL connection is missing. Set DATABASE_URL or PGHOST/PGPORT/PGUSER/PGDATABASE.",
    );
  }

  if (process.env.PGSSLMODE === "require" || process.env.PGSSL === "true") {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

function loadDotEnv(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
