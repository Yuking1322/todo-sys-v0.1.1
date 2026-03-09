const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

function createStore(options = {}) {
  const backend = String(options.backend || "json").toLowerCase();
  if (backend === "postgres" || backend === "postgresql") {
    return createPostgresStore(options);
  }
  return createJsonStore(options);
}

function createJsonStore(options) {
  const dataDir = options.dataDir;
  const dataFile = options.dataFile;
  const runSerialized = createAsyncQueue();

  if (!dataDir || !dataFile) {
    throw new Error("JSON store requires dataDir and dataFile");
  }

  return {
    backend: "json",
    async init() {
      return runSerialized(async () => {
        ensureDataFile(dataDir, dataFile);
      });
    },
    async close() {},
    async getTasks(query) {
      return runSerialized(async () => {
        const store = readJsonStore(dataFile);
        let tasks = [...store.tasks];

        if (query.sinceVersion > 0) {
          tasks = tasks.filter((task) => Number(task.version) > query.sinceVersion);
        }
        if (!query.includeDeleted) {
          tasks = tasks.filter((task) => !task.deletedAt);
        }
        if (query.status === "todo" || query.status === "done") {
          tasks = tasks.filter((task) => task.status === query.status);
        }

        tasks.sort((left, right) => {
          return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
        });

        return {
          tasks,
          syncVersion: Number(store.syncVersion),
        };
      });
    },
    async createTask(input) {
      return runSerialized(async () => {
        const store = readJsonStore(dataFile);
        const task = createTaskRecord(input);
        task.version = incrementJsonVersion(store);
        store.tasks.push(task);
        writeJsonStore(dataFile, store);

        return {
          task,
          syncVersion: Number(store.syncVersion),
        };
      });
    },
    async updateTask(taskId, patch) {
      return runSerialized(async () => {
        const store = readJsonStore(dataFile);
        const task = store.tasks.find((entry) => entry.id === taskId && !entry.deletedAt);
        if (!task) {
          return null;
        }

        if (patch.title !== undefined) {
          task.title = patch.title;
        }
        if (patch.notes !== undefined) {
          task.notes = patch.notes;
        }
        if (patch.dueAt !== undefined) {
          task.dueAt = patch.dueAt;
        }
        if (patch.status !== undefined) {
          task.status = patch.status;
        }
        if (patch.source !== undefined) {
          task.source = patch.source;
        }

        task.updatedAt = new Date().toISOString();
        task.version = incrementJsonVersion(store);
        writeJsonStore(dataFile, store);

        return {
          task,
          syncVersion: Number(store.syncVersion),
        };
      });
    },
    async deleteTask(taskId) {
      return runSerialized(async () => {
        const store = readJsonStore(dataFile);
        const task = store.tasks.find((entry) => entry.id === taskId && !entry.deletedAt);
        if (!task) {
          return null;
        }

        const now = new Date().toISOString();
        task.deletedAt = now;
        task.updatedAt = now;
        task.version = incrementJsonVersion(store);
        writeJsonStore(dataFile, store);

        return {
          task,
          syncVersion: Number(store.syncVersion),
        };
      });
    },
    async upsertOpenClawTask(input) {
      return runSerialized(async () => {
        const store = readJsonStore(dataFile);
        let task = store.tasks.find((entry) => entry.externalId === input.externalId);
        let mode = "updated";

        if (!task) {
          task = createTaskRecord({
            title: input.title,
            notes: input.notes,
            dueAt: input.dueAt,
            status: input.status || "todo",
            source: "openclaw",
            externalId: input.externalId,
          });
          task.version = incrementJsonVersion(store);
          store.tasks.push(task);
          mode = "created";
        } else {
          task.title = input.title;
          task.notes = input.notes || "";
          task.dueAt = input.dueAt || null;
          task.source = "openclaw";
          task.deletedAt = null;
          if (input.status) {
            task.status = input.status;
          }
          task.updatedAt = new Date().toISOString();
          task.version = incrementJsonVersion(store);
        }

        writeJsonStore(dataFile, store);
        return {
          mode,
          task,
          syncVersion: Number(store.syncVersion),
        };
      });
    },
    async getTasksForIcs() {
      return runSerialized(async () => {
        const store = readJsonStore(dataFile);
        return store.tasks.filter((task) => !task.deletedAt && task.dueAt);
      });
    },
    async getDayNotes(month) {
      return runSerialized(async () => {
        const store = readJsonStore(dataFile);
        const notes = store.dayNotes || {};
        if (!month) {
          return notes;
        }

        const scopedNotes = {};
        const prefix = `${month}-`;
        for (const [dateKey, content] of Object.entries(notes)) {
          if (dateKey.startsWith(prefix)) {
            scopedNotes[dateKey] = content;
          }
        }
        return scopedNotes;
      });
    },
    async upsertDayNote(dateKey, content) {
      return runSerialized(async () => {
        const store = readJsonStore(dataFile);
        if (content.trim()) {
          store.dayNotes[dateKey] = content;
        } else {
          delete store.dayNotes[dateKey];
        }

        incrementJsonVersion(store);
        writeJsonStore(dataFile, store);

        return {
          date: dateKey,
          content: store.dayNotes[dateKey] || "",
          syncVersion: Number(store.syncVersion),
        };
      });
    },
  };
}

function createAsyncQueue() {
  let tail = Promise.resolve();
  return (operation) => {
    const run = tail.then(
      () => operation(),
      () => operation(),
    );
    tail = run.catch(() => {});
    return run;
  };
}

function createPostgresStore(options) {
  const { Pool } = requirePg();
  const pool = new Pool(buildPgConfig(options));
  const schemaSql = getInitSql();

  return {
    backend: "postgres",
    async init() {
      await pool.query(schemaSql);
    },
    async close() {
      await pool.end();
    },
    async getTasks(query) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const syncVersion = await getCurrentSyncVersion(client);
        const { sql, params } = buildTaskListSql(query);
        const tasksResult = await client.query(sql, params);
        await client.query("COMMIT");
        return {
          tasks: tasksResult.rows.map(mapTaskRow),
          syncVersion,
        };
      } catch (error) {
        await safeRollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async createTask(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const syncVersion = await nextSyncVersion(client);
        const task = createTaskRecord(input);
        task.version = syncVersion;
        await insertTask(client, task);
        await client.query("COMMIT");
        return { task, syncVersion };
      } catch (error) {
        await safeRollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async updateTask(taskId, patch) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          `SELECT
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
           FROM tasks
           WHERE id = $1 AND deleted_at IS NULL
           FOR UPDATE`,
          [taskId],
        );

        if (existing.rowCount === 0) {
          await client.query("ROLLBACK");
          return null;
        }

        const task = mapTaskRow(existing.rows[0]);
        if (patch.title !== undefined) {
          task.title = patch.title;
        }
        if (patch.notes !== undefined) {
          task.notes = patch.notes;
        }
        if (patch.dueAt !== undefined) {
          task.dueAt = patch.dueAt;
        }
        if (patch.status !== undefined) {
          task.status = patch.status;
        }
        if (patch.source !== undefined) {
          task.source = patch.source;
        }

        task.updatedAt = new Date().toISOString();
        const syncVersion = await nextSyncVersion(client);
        task.version = syncVersion;

        await updateTaskRow(client, task);
        await client.query("COMMIT");
        return { task, syncVersion };
      } catch (error) {
        await safeRollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async deleteTask(taskId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          `SELECT
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
           FROM tasks
           WHERE id = $1 AND deleted_at IS NULL
           FOR UPDATE`,
          [taskId],
        );

        if (existing.rowCount === 0) {
          await client.query("ROLLBACK");
          return null;
        }

        const task = mapTaskRow(existing.rows[0]);
        const now = new Date().toISOString();
        task.deletedAt = now;
        task.updatedAt = now;
        const syncVersion = await nextSyncVersion(client);
        task.version = syncVersion;

        await updateTaskRow(client, task);
        await client.query("COMMIT");
        return { task, syncVersion };
      } catch (error) {
        await safeRollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async upsertOpenClawTask(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query(
          `SELECT
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
           FROM tasks
           WHERE external_id = $1
           FOR UPDATE`,
          [input.externalId],
        );

        let task;
        let mode;
        const syncVersion = await nextSyncVersion(client);
        if (existing.rowCount === 0) {
          mode = "created";
          task = createTaskRecord({
            title: input.title,
            notes: input.notes,
            dueAt: input.dueAt,
            status: input.status || "todo",
            source: "openclaw",
            externalId: input.externalId,
          });
          task.version = syncVersion;
          await insertTask(client, task);
        } else {
          mode = "updated";
          task = mapTaskRow(existing.rows[0]);
          task.title = input.title;
          task.notes = input.notes || "";
          task.dueAt = input.dueAt || null;
          task.source = "openclaw";
          task.deletedAt = null;
          if (input.status) {
            task.status = input.status;
          }
          task.updatedAt = new Date().toISOString();
          task.version = syncVersion;
          await updateTaskRow(client, task);
        }

        await client.query("COMMIT");
        return { mode, task, syncVersion };
      } catch (error) {
        await safeRollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
    async getTasksForIcs() {
      const result = await pool.query(
        `SELECT
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
         FROM tasks
         WHERE deleted_at IS NULL AND due_at IS NOT NULL
         ORDER BY updated_at DESC`,
      );
      return result.rows.map(mapTaskRow);
    },
    async getDayNotes(month) {
      let result;
      if (!month) {
        result = await pool.query(
          `SELECT date_key, content
           FROM day_notes
           ORDER BY date_key ASC`,
        );
      } else {
        const [yearText, monthText] = month.split("-");
        const year = Number(yearText);
        const monthNum = Number(monthText);
        const start = `${month}-01`;
        const end = new Date(Date.UTC(year, monthNum, 1)).toISOString().slice(0, 10);
        result = await pool.query(
          `SELECT date_key, content
           FROM day_notes
           WHERE date_key >= $1::date AND date_key < $2::date
           ORDER BY date_key ASC`,
          [start, end],
        );
      }

      const notes = {};
      for (const row of result.rows) {
        notes[normalizeDbDate(row.date_key)] = row.content;
      }
      return notes;
    },
    async upsertDayNote(dateKey, content) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (content.trim()) {
          await client.query(
            `INSERT INTO day_notes (date_key, content)
             VALUES ($1::date, $2)
             ON CONFLICT (date_key)
             DO UPDATE SET content = EXCLUDED.content`,
            [dateKey, content],
          );
        } else {
          await client.query("DELETE FROM day_notes WHERE date_key = $1::date", [dateKey]);
        }

        const syncVersion = await nextSyncVersion(client);
        await client.query("COMMIT");
        return {
          date: dateKey,
          content: content.trim() ? content : "",
          syncVersion,
        };
      } catch (error) {
        await safeRollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function ensureDataFile(dataDir, dataFile) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dataFile)) {
    writeJsonStore(dataFile, { syncVersion: 0, tasks: [], dayNotes: {} });
  }
}

function readJsonStore(dataFile) {
  const raw = fs.readFileSync(dataFile, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid data file");
  }
  if (!Array.isArray(parsed.tasks) || typeof parsed.syncVersion !== "number") {
    throw new Error("Invalid data shape");
  }
  if (!parsed.dayNotes || typeof parsed.dayNotes !== "object" || Array.isArray(parsed.dayNotes)) {
    parsed.dayNotes = {};
  }
  return parsed;
}

function writeJsonStore(dataFile, store) {
  if (!store.dayNotes || typeof store.dayNotes !== "object" || Array.isArray(store.dayNotes)) {
    store.dayNotes = {};
  }
  fs.writeFileSync(dataFile, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function incrementJsonVersion(store) {
  store.syncVersion += 1;
  return store.syncVersion;
}

function createTaskRecord(input) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    externalId: input.externalId || null,
    title: input.title,
    notes: input.notes || "",
    dueAt: input.dueAt || null,
    status: input.status === "done" ? "done" : "todo",
    source: input.source || "web",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  };
}

function requirePg() {
  try {
    return require("pg");
  } catch (error) {
    throw new Error(
      "PostgreSQL backend requires dependency `pg`. Run `npm install` to install it.",
    );
  }
}

function buildPgConfig(options) {
  const config = {};
  const connectionString = options.databaseUrl || process.env.DATABASE_URL || "";
  if (connectionString) {
    config.connectionString = connectionString;
  }

  if (process.env.PGHOST) {
    config.host = process.env.PGHOST;
  }
  if (process.env.PGPORT) {
    config.port = Number(process.env.PGPORT);
  }
  if (process.env.PGUSER) {
    config.user = process.env.PGUSER;
  }
  if (process.env.PGPASSWORD) {
    config.password = process.env.PGPASSWORD;
  }
  if (process.env.PGDATABASE) {
    config.database = process.env.PGDATABASE;
  }

  if (process.env.PGSSLMODE === "require" || process.env.PGSSL === "true") {
    config.ssl = { rejectUnauthorized: false };
  }

  if (!config.connectionString && !config.host) {
    throw new Error(
      "PostgreSQL backend requires DATABASE_URL or PGHOST/PGPORT/PGUSER/PGDATABASE",
    );
  }

  return config;
}

function getInitSql() {
  const filePath = path.join(__dirname, "db", "init.sql");
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8");
  }
  return `
CREATE TABLE IF NOT EXISTS app_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE,
  sync_version BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT app_state_single_row CHECK (id = TRUE)
);
INSERT INTO app_state (id, sync_version)
VALUES (TRUE, 0)
ON CONFLICT (id) DO NOTHING;
`;
}

async function insertTask(client, task) {
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
      task.id,
      task.externalId,
      task.title,
      task.notes,
      task.dueAt,
      task.status,
      task.source,
      task.createdAt,
      task.updatedAt,
      task.deletedAt,
      task.version,
    ],
  );
}

async function updateTaskRow(client, task) {
  await client.query(
    `UPDATE tasks
     SET
       external_id = $2,
       title = $3,
       notes = $4,
       due_at = $5,
       status = $6,
       source = $7,
       created_at = $8,
       updated_at = $9,
       deleted_at = $10,
       version = $11
     WHERE id = $1`,
    [
      task.id,
      task.externalId,
      task.title,
      task.notes,
      task.dueAt,
      task.status,
      task.source,
      task.createdAt,
      task.updatedAt,
      task.deletedAt,
      task.version,
    ],
  );
}

function buildTaskListSql(query) {
  const where = [];
  const params = [];

  if (query.sinceVersion > 0) {
    params.push(query.sinceVersion);
    where.push(`version > $${params.length}`);
  }
  if (!query.includeDeleted) {
    where.push("deleted_at IS NULL");
  }
  if (query.status === "todo" || query.status === "done") {
    params.push(query.status);
    where.push(`status = $${params.length}`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT
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
  FROM tasks
  ${whereClause}
  ORDER BY updated_at DESC`;

  return { sql, params };
}

async function getCurrentSyncVersion(client) {
  const result = await client.query(
    "SELECT sync_version FROM app_state WHERE id = TRUE LIMIT 1",
  );
  if (result.rowCount === 0) {
    throw new Error("app_state row missing");
  }
  return Number(result.rows[0].sync_version);
}

async function nextSyncVersion(client) {
  const result = await client.query(
    `UPDATE app_state
     SET sync_version = sync_version + 1
     WHERE id = TRUE
     RETURNING sync_version`,
  );
  if (result.rowCount === 0) {
    throw new Error("app_state row missing");
  }
  return Number(result.rows[0].sync_version);
}

function mapTaskRow(row) {
  return {
    id: row.id,
    externalId: row.external_id,
    title: row.title,
    notes: row.notes || "",
    dueAt: toIsoOrNullFromDb(row.due_at),
    status: row.status,
    source: row.source,
    createdAt: toIsoOrNullFromDb(row.created_at),
    updatedAt: toIsoOrNullFromDb(row.updated_at),
    deletedAt: toIsoOrNullFromDb(row.deleted_at),
    version: Number(row.version),
  };
}

function toIsoOrNullFromDb(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toISOString();
}

function normalizeDbDate(value) {
  if (typeof value === "string") {
    return value.slice(0, 10);
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

async function safeRollback(client) {
  try {
    await client.query("ROLLBACK");
  } catch {}
}

module.exports = {
  createStore,
};
