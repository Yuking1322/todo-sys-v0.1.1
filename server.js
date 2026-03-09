const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { randomUUID } = require("crypto");
const { createStore } = require("./store");

loadDotEnv(path.join(__dirname, ".env"));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || "5173");
const OPENCLAW_SYNC_TOKEN = process.env.OPENCLAW_SYNC_TOKEN || "";
const AI_API_BASE = process.env.AI_API_BASE || "";
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "";
const HOLIDAY_YEAR_API =
  process.env.HOLIDAY_YEAR_API || "https://timor.tech/api/holiday/year";
const HOLIDAY_FALLBACK_API =
  process.env.HOLIDAY_FALLBACK_API || "https://date.nager.at/api/v3/PublicHolidays";
const HOLIDAY_FETCH_TIMEOUT_MS = Number(process.env.HOLIDAY_FETCH_TIMEOUT_MS || "8000");
const MAX_BODY_SIZE = 1_000_000;

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "todos.json");
const DATA_BACKEND = (process.env.DATA_BACKEND || "json").toLowerCase();
const DATABASE_URL = process.env.DATABASE_URL || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const holidayCache = new Map();

const store = createStore({
  backend: DATA_BACKEND,
  dataDir: DATA_DIR,
  dataFile: DATA_FILE,
  databaseUrl: DATABASE_URL,
});

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const pathname = requestUrl.pathname;

    if (pathname === "/api/health" && request.method === "GET") {
      return writeJson(response, 200, { ok: true, now: new Date().toISOString() });
    }

    if (pathname === "/api/tasks" && request.method === "GET") {
      return handleGetTasks(requestUrl, response);
    }

    if (pathname === "/api/tasks" && request.method === "POST") {
      const payload = await parseJsonBody(request);
      return handleCreateTask(payload, response);
    }

    if (pathname.startsWith("/api/tasks/") && request.method === "PATCH") {
      const payload = await parseJsonBody(request);
      return handleUpdateTask(pathname.slice("/api/tasks/".length), payload, response);
    }

    if (pathname.startsWith("/api/tasks/") && request.method === "DELETE") {
      return handleDeleteTask(pathname.slice("/api/tasks/".length), response);
    }

    if (pathname === "/api/tasks.ics" && request.method === "GET") {
      return handleExportIcs(response);
    }

    if (pathname === "/api/holidays" && request.method === "GET") {
      return handleGetHolidays(requestUrl, response);
    }

    if (pathname === "/api/day-notes" && request.method === "GET") {
      return handleGetDayNotes(requestUrl, response);
    }

    if (pathname.startsWith("/api/day-notes/") && request.method === "PUT") {
      const payload = await parseJsonBody(request);
      const dateKey = normalizeDateKey(pathname.slice("/api/day-notes/".length));
      return handleUpsertDayNote(dateKey, payload, response);
    }

    if (pathname === "/api/sync/openclaw" && request.method === "POST") {
      const payload = await parseJsonBody(request);
      return handleOpenClawSync(payload, request, response);
    }

    if (pathname === "/api/ai/create-task" && request.method === "POST") {
      const payload = await parseJsonBody(request);
      return handleAiCreateTask(payload, response);
    }

    if (request.method === "GET") {
      return serveStatic(pathname, response);
    }

    return writeJson(response, 404, { error: "Not found" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const message = statusCode >= 500 ? "Internal server error" : error.message;
    return writeJson(response, statusCode, { error: message });
  }
});

bootstrap().catch((error) => {
  console.error("Failed to start TODO server:", error.message || error);
  process.exit(1);
});

async function bootstrap() {
  await store.init();
  server.listen(PORT, HOST, () => {
    console.log(`TODO server running at http://${HOST}:${PORT} (backend=${store.backend})`);
  });
}

async function handleGetTasks(requestUrl, response) {
  const includeDeleted = requestUrl.searchParams.get("includeDeleted") === "true";
  const status = requestUrl.searchParams.get("status");
  const sinceVersionRaw = Number(requestUrl.searchParams.get("sinceVersion") || "0");
  const sinceVersion = Number.isFinite(sinceVersionRaw) && sinceVersionRaw > 0 ? sinceVersionRaw : 0;

  const result = await store.getTasks({
    includeDeleted,
    status,
    sinceVersion,
  });

  return writeJson(response, 200, result);
}

async function handleCreateTask(payload, response) {
  const input = normalizeTaskInput(payload, { requireTitle: true, allowStatus: false });
  const result = await store.createTask({
    title: input.title,
    notes: input.notes || "",
    dueAt: input.dueAt || null,
    status: "todo",
    source: input.source || "web",
    externalId: input.externalId || null,
  });

  return writeJson(response, 201, result);
}

async function handleUpdateTask(taskId, payload, response) {
  const input = normalizeTaskInput(payload, { requireTitle: false, allowStatus: true });
  const result = await store.updateTask(taskId, input);
  if (!result) {
    throw createError(404, "Task not found");
  }

  return writeJson(response, 200, result);
}

async function handleDeleteTask(taskId, response) {
  const result = await store.deleteTask(taskId);
  if (!result) {
    throw createError(404, "Task not found");
  }

  return writeJson(response, 200, result);
}

async function handleOpenClawSync(payload, request, response) {
  if (OPENCLAW_SYNC_TOKEN) {
    const token = request.headers["x-openclaw-token"];
    if (!token || token !== OPENCLAW_SYNC_TOKEN) {
      throw createError(403, "Forbidden");
    }
  }

  const input = normalizeTaskInput(payload, { requireTitle: true, allowStatus: true });
  const externalId = input.externalId || `oc-${randomUUID()}`;
  const result = await store.upsertOpenClawTask({
    externalId,
    title: input.title,
    notes: input.notes || "",
    dueAt: input.dueAt || null,
    status: input.status,
  });

  return writeJson(response, 200, result);
}

async function handleAiCreateTask(payload, response) {
  if (!payload || typeof payload !== "object" || typeof payload.text !== "string") {
    throw createError(400, "text is required");
  }

  const text = payload.text.trim();
  if (!text) {
    throw createError(400, "text cannot be empty");
  }

  const parsedByRules = parseTaskFromTextRules(text);
  let parsed = parsedByRules;

  if (AI_API_BASE && AI_API_KEY && AI_MODEL) {
    try {
      const parsedByModel = await parseTaskFromModel(text);
      parsed = {
        ...parsedByRules,
        ...parsedByModel,
      };
    } catch {
      parsed = parsedByRules;
    }
  }

  const title = limitString(parsed.title || text, 120);
  const notes = typeof parsed.notes === "string" ? limitString(parsed.notes, 2000) : "";
  const status = parsed.status === "done" ? "done" : "todo";
  const dueAt = parsed.dueAt ? toIsoOrNull(parsed.dueAt) : null;

  const result = await store.createTask(
    {
      title,
      notes,
      dueAt,
      source: "ai",
      externalId: null,
      status,
    },
  );

  return writeJson(response, 201, {
    task: result.task,
    parsed,
    syncVersion: result.syncVersion,
  });
}

async function handleExportIcs(response) {
  const tasks = await store.getTasksForIcs();
  const now = formatIcsDate(new Date());

  const events = tasks
    .map((task) => {
      const startDate = new Date(task.dueAt);
      if (Number.isNaN(startDate.getTime())) {
        return "";
      }

      const endDate = new Date(startDate.getTime() + 30 * 60 * 1000);
      const status = task.status === "done" ? "CONFIRMED" : "TENTATIVE";

      return [
        "BEGIN:VEVENT",
        `UID:${escapeIcs(`${task.id}@todo-openclaw-sync`)}`,
        `DTSTAMP:${now}`,
        `DTSTART:${formatIcsDate(startDate)}`,
        `DTEND:${formatIcsDate(endDate)}`,
        `SUMMARY:${escapeIcs(task.title)}`,
        `DESCRIPTION:${escapeIcs(task.notes || "")}`,
        `STATUS:${status}`,
        "END:VEVENT",
      ].join("\r\n");
    })
    .filter(Boolean);

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//todo-openclaw-sync//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events,
    "END:VCALENDAR",
    "",
  ].join("\r\n");

  return writeText(response, 200, ics, "text/calendar; charset=utf-8", {
    "Content-Disposition": 'attachment; filename="tasks.ics"',
  });
}

async function handleGetHolidays(requestUrl, response) {
  const requestedYear = requestUrl.searchParams.get("year");
  const currentYear = new Date().getFullYear();
  const year = parseHolidayYear(requestedYear, currentYear);

  const holidays = await getHolidayMap(year);
  return writeJson(response, 200, {
    year,
    holidays,
  });
}

async function handleGetDayNotes(requestUrl, response) {
  const month = requestUrl.searchParams.get("month");

  if (!month) {
    const notes = await store.getDayNotes();
    return writeJson(response, 200, { notes });
  }

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw createError(400, "month must be YYYY-MM");
  }

  const notes = await store.getDayNotes(month);
  return writeJson(response, 200, { notes });
}

async function handleUpsertDayNote(dateKey, payload, response) {
  if (!payload || typeof payload !== "object" || typeof payload.content !== "string") {
    throw createError(400, "content must be a string");
  }

  const content = limitString(payload.content.trimEnd(), 500);
  const result = await store.upsertDayNote(dateKey, content);
  return writeJson(response, 200, result);
}

function parseTaskFromTextRules(text) {
  const raw = text.trim();
  const lower = raw.toLowerCase();
  const parsed = {
    title: raw,
    notes: "",
    dueAt: null,
    status: "todo",
  };

  if (
    /\bdone\b|\bcompleted\b|\bfinish(ed)?\b/i.test(lower) ||
    /\u5B8C\u6210|\u5DF2\u5B8C\u6210/.test(raw)
  ) {
    parsed.status = "done";
  }

  const explicitDate = parseExplicitDate(raw);
  if (explicitDate) {
    parsed.dueAt = explicitDate.toISOString();
    return parsed;
  }

  const relativeDate = parseRelativeDate(raw);
  if (relativeDate) {
    parsed.dueAt = relativeDate.toISOString();
  }

  return parsed;
}

function parseExplicitDate(text) {
  const match = text.match(
    /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})(?::(\d{2}))?)?/,
  );
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || "9");
  const minute = Number(match[5] || "0");
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseRelativeDate(text) {
  const now = new Date();
  const dayOffset = extractRelativeDayOffset(text);

  if (dayOffset === null) {
    return null;
  }

  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    9,
    0,
    0,
    0,
  );

  const time = extractTime(text);
  if (time) {
    next.setHours(time.hour, time.minute, 0, 0);
  }

  return next;
}

function extractRelativeDayOffset(text) {
  if (/\btoday\b/i.test(text) || /\u4ECA\u5929/.test(text)) {
    return 0;
  }
  if (/\btomorrow\b|\btmr\b/i.test(text) || /\u660E\u5929/.test(text)) {
    return 1;
  }
  if (/day after tomorrow/i.test(text) || /\u540E\u5929/.test(text)) {
    return 2;
  }
  return null;
}

function extractTime(text) {
  const timeMatch = text.match(/(\d{1,2})(?::|\.|\u70B9)(\d{1,2})?/);
  if (!timeMatch) {
    return null;
  }

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2] || "0");

  if (hour > 23 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

async function parseTaskFromModel(text) {
  const endpoint = `${AI_API_BASE.replace(/\/+$/, "")}/chat/completions`;
  const prompt = [
    "Extract one todo item from user text and return valid JSON only.",
    'Schema: {"title":"string","notes":"string","dueAt":"ISO string or null","status":"todo|done"}',
  ].join(" ");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: text },
      ],
    }),
  });

  if (!response.ok) {
    throw createError(502, "AI provider error");
  }

  const result = await response.json();
  const content = result?.choices?.[0]?.message?.content;

  if (typeof content !== "string") {
    throw createError(502, "AI response empty");
  }

  const parsed = safeParseJsonFromText(content);
  if (!parsed || typeof parsed !== "object") {
    throw createError(502, "AI response malformed");
  }

  return parsed;
}

function safeParseJsonFromText(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    let rawBody = "";

    request.on("data", (chunk) => {
      rawBody += chunk;
      if (rawBody.length > MAX_BODY_SIZE) {
        reject(createError(413, "Payload too large"));
        request.destroy();
      }
    });

    request.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(rawBody));
      } catch {
        reject(createError(400, "Invalid JSON payload"));
      }
    });

    request.on("error", () => reject(createError(400, "Invalid request")));
  });
}

function serveStatic(pathname, response) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const fullPath = path.resolve(PUBLIC_DIR, `.${safePath}`);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    throw createError(403, "Forbidden");
  }
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    throw createError(404, "Not found");
  }

  const extension = path.extname(fullPath).toLowerCase();
  const contentType = getContentType(extension);
  const content = fs.readFileSync(fullPath);

  response.writeHead(200, { "Content-Type": contentType });
  response.end(content);
}

function getContentType(extension) {
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "application/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

function normalizeTaskInput(payload, options) {
  if (!payload || typeof payload !== "object") {
    throw createError(400, "Request body must be an object");
  }

  const normalized = {};

  if (Object.prototype.hasOwnProperty.call(payload, "title")) {
    if (typeof payload.title !== "string") {
      throw createError(400, "title must be a string");
    }
    const title = payload.title.trim();
    if (!title) {
      throw createError(400, "title cannot be empty");
    }
    normalized.title = limitString(title, 120);
  } else if (options.requireTitle) {
    throw createError(400, "title is required");
  }

  if (Object.prototype.hasOwnProperty.call(payload, "notes")) {
    if (typeof payload.notes !== "string") {
      throw createError(400, "notes must be a string");
    }
    normalized.notes = limitString(payload.notes, 2000);
  } else if (options.requireTitle) {
    normalized.notes = "";
  }

  if (Object.prototype.hasOwnProperty.call(payload, "dueAt")) {
    normalized.dueAt = toIsoOrNull(payload.dueAt);
  } else if (options.requireTitle) {
    normalized.dueAt = null;
  }

  if (options.allowStatus && Object.prototype.hasOwnProperty.call(payload, "status")) {
    if (payload.status !== "todo" && payload.status !== "done") {
      throw createError(400, "status must be todo or done");
    }
    normalized.status = payload.status;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "externalId")) {
    if (typeof payload.externalId !== "string") {
      throw createError(400, "externalId must be a string");
    }
    const externalId = payload.externalId.trim();
    if (!externalId) {
      throw createError(400, "externalId cannot be empty");
    }
    normalized.externalId = externalId;
  }

  if (Object.prototype.hasOwnProperty.call(payload, "source")) {
    if (typeof payload.source !== "string") {
      throw createError(400, "source must be a string");
    }
    normalized.source = payload.source.trim() || "web";
  }

  return normalized;
}

function toIsoOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createError(400, "dueAt must be a valid date string");
  }
  return date.toISOString();
}

function parseHolidayYear(value, fallback) {
  if (!value) {
    return fallback;
  }

  if (!/^\d{4}$/.test(value)) {
    throw createError(400, "year must be YYYY");
  }

  const year = Number(value);
  if (!Number.isFinite(year) || year < 2000 || year > 2100) {
    throw createError(400, "year out of range");
  }
  return year;
}

async function getHolidayMap(year) {
  const cached = holidayCache.get(year);
  if (cached) {
    return cached;
  }

  let holidays = {};

  try {
    const timorUrl = `${HOLIDAY_YEAR_API.replace(/\/+$/, "")}/${year}`;
    const timorPayload = await fetchJsonWithTimeout(timorUrl, HOLIDAY_FETCH_TIMEOUT_MS);
    holidays = normalizeHolidayMapFromTimor(year, timorPayload);
  } catch {
    holidays = {};
  }

  if (Object.keys(holidays).length === 0) {
    try {
      const nagerUrl = `${HOLIDAY_FALLBACK_API.replace(/\/+$/, "")}/${year}/CN`;
      const nagerPayload = await fetchJsonWithTimeout(nagerUrl, HOLIDAY_FETCH_TIMEOUT_MS);
      holidays = normalizeHolidayMapFromNager(nagerPayload);
    } catch {
      holidays = {};
    }
  }

  if (Object.keys(holidays).length === 0) {
    holidays = getBuiltinChinaHolidayMap(year);
  }

  holidayCache.set(year, holidays);
  return holidays;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw createError(502, "holiday provider error");
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeHolidayMapFromTimor(year, payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const raw =
    payload.holiday && typeof payload.holiday === "object"
      ? payload.holiday
      : payload.result && typeof payload.result === "object"
        ? payload.result
        : {};
  const normalized = {};

  for (const [rawKey, info] of Object.entries(raw)) {
    const dateKey = normalizeHolidayDateKey(year, rawKey, info?.date);
    if (!dateKey || !info || typeof info !== "object") {
      continue;
    }

    const name = typeof info.name === "string" ? info.name : "";
    const holidayFlag = info.holiday === true;
    const workdayFlag = info.holiday === false && /调休|补班|上班/.test(name);

    normalized[dateKey] = {
      name,
      isOffDay: holidayFlag,
      isWorkday: workdayFlag,
      source: "timor",
    };
  }

  return normalized;
}

function normalizeHolidayMapFromNager(payload) {
  if (!Array.isArray(payload)) {
    return {};
  }

  const normalized = {};

  for (const item of payload) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const dateKey = typeof item.date === "string" ? item.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      continue;
    }

    normalized[dateKey] = {
      name:
        typeof item.localName === "string" && item.localName
          ? item.localName
          : typeof item.name === "string"
            ? item.name
            : "节假日",
      isOffDay: true,
      isWorkday: false,
      source: "nager",
    };
  }

  return normalized;
}

function normalizeHolidayDateKey(year, key, fallbackDate) {
  if (typeof fallbackDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fallbackDate)) {
    return fallbackDate;
  }

  if (typeof key !== "string") {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return key;
  }

  if (/^\d{2}-\d{2}$/.test(key)) {
    return `${year}-${key}`;
  }

  return null;
}

function getBuiltinChinaHolidayMap(year) {
  const map = {};

  const defaults = [
    { date: `${year}-01-01`, name: "元旦" },
    { date: `${year}-05-01`, name: "劳动节" },
    { date: `${year}-10-01`, name: "国庆节" },
    { date: `${year}-10-02`, name: "国庆节假期" },
    { date: `${year}-10-03`, name: "国庆节假期" },
  ];

  for (const holiday of defaults) {
    map[holiday.date] = {
      name: holiday.name,
      isOffDay: true,
      isWorkday: false,
      source: "builtin",
    };
  }

  return map;
}

function normalizeDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw createError(400, "date must be YYYY-MM-DD");
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day);

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() + 1 !== month ||
    date.getDate() !== day
  ) {
    throw createError(400, "invalid date");
  }

  return value;
}

function limitString(value, maxLength) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function formatIcsDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

function escapeIcs(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function createError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function writeJson(response, statusCode, payload) {
  const content = Buffer.from(JSON.stringify(payload, null, 2));
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.length,
  });
  response.end(content);
}

function writeText(response, statusCode, content, contentType, extraHeaders = {}) {
  const body = Buffer.from(content, "utf8");
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    ...extraHeaders,
  });
  response.end(body);
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
