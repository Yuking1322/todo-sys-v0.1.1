const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.join(__dirname, "..");
loadDotEnv(path.join(ROOT_DIR, ".env"));

async function main() {
  const { Pool } = requirePg();
  const sqlPath = path.join(ROOT_DIR, "db", "init.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  const pool = new Pool(buildPgConfig());

  try {
    await pool.query(sql);
    console.log("Database schema initialized.");
  } finally {
    await pool.end();
  }
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
