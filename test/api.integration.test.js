const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT_DIR = path.join(__dirname, "..");
const WRITE_TOKEN = "test-write-token";

test("core API flows: auth, AI create, date filter, status lifecycle", async (t) => {
  const instance = await startServer();
  t.after(async () => {
    await stopServer(instance);
  });

  let aiTask = null;
  let aiDateKey = null;

  await t.test("reject write request without token", async () => {
    const response = await api(instance, "/api/tasks", {
      method: "POST",
      body: { title: "unauthorized-write" },
      token: "",
    });

    assert.equal(response.status, 401);
    assert.equal(response.payload?.error, "Unauthorized");
  });

  await t.test("AI create parses Chinese relative date text", async () => {
    const response = await api(instance, "/api/ai/create-task", {
      method: "POST",
      body: { text: "后天上午要和校长开会" },
    });

    assert.equal(response.status, 201);
    assert.equal(response.payload.task.source, "ai");
    assert.equal(response.payload.task.status, "todo");
    assert.ok(response.payload.task.dueAt, "expected dueAt from relative date parse");

    aiTask = response.payload.task;
    aiDateKey = toDateKeyLocal(new Date(aiTask.dueAt));
  });

  await t.test("date filter returns tasks for specified day only", async () => {
    assert.ok(aiTask && aiDateKey, "AI task must be created first");

    const sameDay = await api(instance, "/api/tasks", {
      method: "POST",
      body: {
        title: "same-day-task",
        dueAt: aiTask.dueAt,
      },
    });
    assert.equal(sameDay.status, 201);

    const nextDayDate = new Date(aiTask.dueAt);
    nextDayDate.setDate(nextDayDate.getDate() + 1);
    const anotherDay = await api(instance, "/api/tasks", {
      method: "POST",
      body: {
        title: "another-day-task",
        dueAt: nextDayDate.toISOString(),
      },
    });
    assert.equal(anotherDay.status, 201);

    const filtered = await api(instance, `/api/tasks?date=${aiDateKey}`);
    assert.equal(filtered.status, 200);
    assert.ok(filtered.payload.tasks.length >= 2, "expected at least AI + same-day task");

    const filteredIds = new Set(filtered.payload.tasks.map((task) => task.id));
    assert.equal(filteredIds.has(aiTask.id), true);
    assert.equal(filteredIds.has(sameDay.payload.task.id), true);
    assert.equal(filteredIds.has(anotherDay.payload.task.id), false);

    for (const task of filtered.payload.tasks) {
      assert.ok(task.dueAt, "filtered tasks must have dueAt");
      assert.equal(toDateKeyLocal(new Date(task.dueAt)), aiDateKey);
    }
  });

  await t.test("status lifecycle: create -> done -> todo -> delete", async () => {
    const created = await api(instance, "/api/tasks", {
      method: "POST",
      body: { title: "lifecycle-task" },
    });
    assert.equal(created.status, 201);
    const taskId = created.payload.task.id;

    const toDone = await api(instance, `/api/tasks/${taskId}`, {
      method: "PATCH",
      body: { status: "done" },
    });
    assert.equal(toDone.status, 200);
    assert.equal(toDone.payload.task.status, "done");

    const toTodo = await api(instance, `/api/tasks/${taskId}`, {
      method: "PATCH",
      body: { status: "todo" },
    });
    assert.equal(toTodo.status, 200);
    assert.equal(toTodo.payload.task.status, "todo");

    const removed = await api(instance, `/api/tasks/${taskId}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 200);
    assert.ok(removed.payload.task.deletedAt);

    const listActive = await api(instance, "/api/tasks");
    assert.equal(listActive.status, 200);
    assert.equal(listActive.payload.tasks.some((task) => task.id === taskId), false);

    const listWithDeleted = await api(instance, "/api/tasks?includeDeleted=true");
    assert.equal(listWithDeleted.status, 200);
    const deletedTask = listWithDeleted.payload.tasks.find((task) => task.id === taskId);
    assert.ok(deletedTask, "deleted task should appear with includeDeleted=true");
    assert.ok(deletedTask.deletedAt);
  });
});

async function startServer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-v011-test-"));
  const dataFile = path.join(tempDir, "todos.json");
  const port = await pickAvailablePort();

  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_BACKEND: "json",
    DATA_FILE: dataFile,
    APP_WRITE_TOKEN: WRITE_TOKEN,
    OPENCLAW_SYNC_TOKEN: "test-openclaw-token",
    AI_API_BASE: "",
    AI_API_KEY: "",
    AI_MODEL: "",
  };

  const processRef = spawn(process.execPath, ["server.js"], {
    cwd: ROOT_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  processRef.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  processRef.stderr.on("data", (chunk) => stderr.push(chunk.toString()));

  await waitForHealthy(`http://127.0.0.1:${port}/api/health`, processRef, stderr);

  return {
    processRef,
    baseUrl: `http://127.0.0.1:${port}`,
    tempDir,
    stdout,
    stderr,
  };
}

async function stopServer(instance) {
  if (!instance || !instance.processRef) {
    return;
  }

  if (!instance.processRef.killed) {
    instance.processRef.kill("SIGTERM");
  }
  await waitForExit(instance.processRef, 5_000).catch(() => {
    try {
      instance.processRef.kill("SIGKILL");
    } catch {}
  });

  try {
    fs.rmSync(instance.tempDir, { recursive: true, force: true });
  } catch {}
}

async function api(instance, pathname, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const token = options.token === undefined ? WRITE_TOKEN : options.token;
  const headers = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers["X-App-Token"] = token;
  }

  const response = await fetch(`${instance.baseUrl}${pathname}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {}

  return {
    status: response.status,
    payload,
  };
}

async function waitForHealthy(url, processRef, stderr) {
  const timeoutMs = 10_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (processRef.exitCode !== null) {
      throw new Error(
        `server exited early: code=${processRef.exitCode}, stderr=${stderr.join("")}`,
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await sleep(150);
  }

  throw new Error(`server health check timeout: ${url}`);
}

function waitForExit(processRef, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("process did not exit in time"));
    }, timeoutMs);

    processRef.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateKeyLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function pickAvailablePort() {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error("failed to pick available port"));
        }
      });
    });
    server.on("error", reject);
  });
}
