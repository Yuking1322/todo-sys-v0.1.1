const AUTO_REFRESH_MS = 20_000;
const WRITE_TOKEN_STORAGE_KEY = "todo_write_token";

const state = {
  tasks: [],
  holidays: {},
  holidayYear: null,
  syncVersion: 0,
  filter: "all",
  selectedDateKey: null,
  monthCursor: firstDayOfMonth(new Date()),
  isBusy: false,
};

const elements = {
  aiForm: document.getElementById("ai-form"),
  aiText: document.getElementById("ai-text"),
  createForm: document.getElementById("create-form"),
  titleInput: document.getElementById("title-input"),
  dueInput: document.getElementById("due-input"),
  notesInput: document.getElementById("notes-input"),
  filterSelect: document.getElementById("filter-select"),
  refreshButton: document.getElementById("refresh-button"),
  statusText: document.getElementById("status-text"),
  taskList: document.getElementById("task-list"),
  monthLabel: document.getElementById("month-label"),
  monthPrev: document.getElementById("month-prev"),
  monthNext: document.getElementById("month-next"),
  monthPicker: document.getElementById("month-picker"),
  calendarGrid: document.getElementById("calendar-grid"),
  clearDateFilter: document.getElementById("clear-date-filter"),
  selectedDateText: document.getElementById("selected-date-text"),
  downloadIcs: document.getElementById("download-ics"),
  summaryTotal: document.getElementById("summary-total"),
  summaryTodo: document.getElementById("summary-todo"),
  summaryDone: document.getElementById("summary-done"),
  todayLabel: document.getElementById("today-label"),
  writeTokenInput: document.getElementById("write-token-input"),
  saveTokenButton: document.getElementById("save-token-button"),
  clearTokenButton: document.getElementById("clear-token-button"),
};

elements.aiForm.addEventListener("submit", onAiCreateTask);
elements.createForm.addEventListener("submit", onManualCreateTask);
elements.refreshButton.addEventListener("click", () => refreshAll({ silent: false }));
elements.filterSelect.addEventListener("change", () => {
  state.filter = elements.filterSelect.value;
  renderTasks();
});
elements.monthPrev.addEventListener("click", () => switchMonth(-1));
elements.monthNext.addEventListener("click", () => switchMonth(1));
elements.monthPicker.addEventListener("change", onMonthPick);
elements.clearDateFilter.addEventListener("click", () => {
  state.selectedDateKey = null;
  updateSelectedDateText();
  renderCalendar();
  renderTasks();
});
elements.downloadIcs.addEventListener("click", () => {
  window.open("/api/tasks.ics", "_blank");
});
elements.saveTokenButton?.addEventListener("click", saveWriteToken);
elements.clearTokenButton?.addEventListener("click", clearWriteToken);

hydrateWriteToken();
renderTodayInfo();
refreshAll({ silent: false });
setInterval(() => refreshAll({ silent: true }), AUTO_REFRESH_MS);

async function onAiCreateTask(event) {
  event.preventDefault();
  const text = elements.aiText.value.trim();

  if (!text) {
    setStatus("请先输入一句任务描述。", true);
    return;
  }

  try {
    setBusy(true);
    const response = await requestJson("/api/ai/create-task", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    focusOnTaskDate(response?.task?.dueAt);
    elements.aiForm.reset();
    await refreshAll({ silent: false });

    const dueText = response.task?.dueAt
      ? formatDateTime(response.task.dueAt)
      : "无截止时间";
    setStatus(`AI 已创建：${response.task.title}（${dueText}）`, false);
  } catch (error) {
    setStatus(`AI 创建失败：${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function onManualCreateTask(event) {
  event.preventDefault();
  const title = elements.titleInput.value.trim();
  const notes = elements.notesInput.value.trim();
  const dueAt = elements.dueInput.value
    ? new Date(elements.dueInput.value).toISOString()
    : null;

  if (!title) {
    setStatus("标题不能为空。", true);
    return;
  }

  try {
    setBusy(true);
    const response = await requestJson("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        notes,
        dueAt,
        source: "web",
      }),
    });
    focusOnTaskDate(response?.task?.dueAt || dueAt);
    elements.createForm.reset();
    await refreshAll({ silent: false });
    setStatus(`已创建任务：${title}`, false);
  } catch (error) {
    setStatus(`创建失败：${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function refreshAll({ silent }) {
  try {
    if (!silent) {
      setStatus("正在同步数据...", false);
    }

    const year = state.monthCursor.getFullYear();
    const [taskResponse, holidayResponse] = await Promise.all([
      requestJson("/api/tasks"),
      requestJson(`/api/holidays?year=${year}`),
    ]);

    state.tasks = taskResponse.tasks || [];
    state.syncVersion = taskResponse.syncVersion || 0;
    state.holidays = holidayResponse.holidays || {};
    state.holidayYear = year;

    renderOverview();
    renderCalendar();
    renderTasks();

    if (!silent) {
      setStatus(`同步完成，当前版本 v${state.syncVersion}。`, false);
    }
  } catch (error) {
    setStatus(`同步失败：${error.message}`, true);
  }
}

async function switchMonth(diff) {
  state.monthCursor = addMonths(state.monthCursor, diff);
  const year = state.monthCursor.getFullYear();

  if (state.holidayYear !== year) {
    try {
      const holidayResponse = await requestJson(`/api/holidays?year=${year}`);
      state.holidays = holidayResponse.holidays || {};
      state.holidayYear = year;
    } catch (error) {
      setStatus(`节假日加载失败：${error.message}`, true);
    }
  }

  renderCalendar();
  renderTasks();
}

async function onMonthPick() {
  const value = elements.monthPicker.value;
  if (!value) {
    return;
  }

  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) {
    return;
  }

  state.monthCursor = new Date(year, month - 1, 1);

  if (state.holidayYear !== year) {
    try {
      const holidayResponse = await requestJson(`/api/holidays?year=${year}`);
      state.holidays = holidayResponse.holidays || {};
      state.holidayYear = year;
    } catch (error) {
      setStatus(`节假日加载失败：${error.message}`, true);
    }
  }

  renderCalendar();
  renderTasks();
}

function renderOverview() {
  const total = state.tasks.length;
  const done = state.tasks.filter((task) => task.status === "done").length;
  const todo = total - done;

  elements.summaryTotal.textContent = String(total);
  elements.summaryTodo.textContent = String(todo);
  elements.summaryDone.textContent = String(done);
}

function renderTodayInfo() {
  const now = new Date();
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const label = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  elements.todayLabel.textContent = `${label} ${weekdays[now.getDay()]}`;
}

function renderCalendar() {
  elements.calendarGrid.innerHTML = "";
  updateSelectedDateText();

  const monthStart = firstDayOfMonth(state.monthCursor);
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  const firstCellDate = new Date(monthStart);
  firstCellDate.setDate(firstCellDate.getDate() - firstCellDate.getDay());
  const todayKey = toDateKey(new Date());

  elements.monthLabel.textContent = monthStart.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
  });
  elements.monthPicker.value = `${monthStart.getFullYear()}-${String(
    monthStart.getMonth() + 1,
  ).padStart(2, "0")}`;

  for (let index = 0; index < 42; index += 1) {
    const date = new Date(firstCellDate);
    date.setDate(firstCellDate.getDate() + index);

    const dateKey = toDateKey(date);
    const isCurrentMonth = date >= monthStart && date <= monthEnd;
    const isSelected = state.selectedDateKey === dateKey;
    const isToday = dateKey === todayKey;
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const holidayInfo = state.holidays[dateKey] || null;
    const dayTasks = getTasksByDate(dateKey);

    const cell = document.createElement("article");
    cell.className = "day-cell";
    if (!isCurrentMonth) cell.classList.add("outside");
    if (isSelected) cell.classList.add("selected");
    if (isToday) cell.classList.add("today");
    if (isWeekend) cell.classList.add("weekend");
    if (holidayInfo?.isOffDay) cell.classList.add("holiday-off");
    if (holidayInfo?.isWorkday) cell.classList.add("holiday-work");

    const top = document.createElement("div");
    top.className = "day-top";

    const dayButton = document.createElement("button");
    dayButton.type = "button";
    dayButton.className = "day-select";
    dayButton.textContent = String(date.getDate());
    dayButton.title = `筛选 ${dateKey} 的任务`;
    dayButton.addEventListener("click", () => {
      state.selectedDateKey = state.selectedDateKey === dateKey ? null : dateKey;
      updateSelectedDateText();
      renderCalendar();
      renderTasks();
    });
    top.appendChild(dayButton);

    if (isToday) {
      const todayTag = document.createElement("span");
      todayTag.className = "today-tag";
      todayTag.textContent = "今天";
      top.appendChild(todayTag);
    } else {
      const count = document.createElement("span");
      count.className = "day-count";
      count.textContent = dayTasks.length > 0 ? `${dayTasks.length}项` : "";
      top.appendChild(count);
    }

    cell.appendChild(top);

    const holidayName = document.createElement("p");
    holidayName.className = "holiday-name";
    holidayName.textContent = holidayInfo?.name || "";
    cell.appendChild(holidayName);

    const agenda = document.createElement("ul");
    agenda.className = "day-agenda";
    const visibleAgenda = dayTasks.slice(0, 4);
    for (const task of visibleAgenda) {
      const item = document.createElement("li");
      item.textContent = task.status === "done" ? `✓ ${task.title}` : task.title;
      agenda.appendChild(item);
    }
    if (dayTasks.length > 4) {
      const more = document.createElement("li");
      more.textContent = `还有 ${dayTasks.length - 4} 项...`;
      agenda.appendChild(more);
    }
    cell.appendChild(agenda);

    elements.calendarGrid.appendChild(cell);
  }
}

function renderTasks() {
  elements.taskList.innerHTML = "";

  let visibleTasks = state.tasks.filter((task) => {
    if (state.filter === "all") {
      return true;
    }
    return task.status === state.filter;
  });

  if (state.selectedDateKey) {
    visibleTasks = visibleTasks.filter((task) => {
      if (!task.dueAt) {
        return false;
      }
      return toDateKey(new Date(task.dueAt)) === state.selectedDateKey;
    });
  }

  visibleTasks.sort((left, right) => {
    const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    if (leftDue !== rightDue) {
      return leftDue - rightDue;
    }
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });

  if (visibleTasks.length === 0) {
    const item = document.createElement("li");
    item.className = "empty-item";
    item.textContent = "当前筛选条件下没有任务。";
    elements.taskList.appendChild(item);
    return;
  }

  for (const task of visibleTasks) {
    const item = document.createElement("li");
    item.className = "task-item";
    if (task.status === "done") {
      item.classList.add("done");
    }

    const main = document.createElement("div");
    main.className = "task-main";

    const title = document.createElement("h3");
    title.textContent = task.title;
    main.appendChild(title);

    const meta = document.createElement("p");
    meta.className = "task-meta";
    meta.textContent = `截止：${
      task.dueAt ? formatDateTime(task.dueAt) : "无"
    } | 来源：${task.source}`;
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.textContent = task.status === "done" ? "改为未完成" : "标记完成";
    toggleButton.addEventListener("click", () => {
      updateTask(task.id, {
        status: task.status === "done" ? "todo" : "done",
      });
    });
    actions.appendChild(toggleButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "danger";
    deleteButton.textContent = "删除";
    deleteButton.addEventListener("click", () => {
      deleteTask(task.id);
    });
    actions.appendChild(deleteButton);

    item.appendChild(main);
    item.appendChild(actions);
    elements.taskList.appendChild(item);
  }
}

async function updateTask(taskId, payload) {
  try {
    setBusy(true);
    await requestJson(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    await refreshAll({ silent: false });
  } catch (error) {
    setStatus(`更新失败：${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function deleteTask(taskId) {
  const confirmed = window.confirm("确认删除这个任务吗？");
  if (!confirmed) {
    return;
  }

  try {
    setBusy(true);
    await requestJson(`/api/tasks/${taskId}`, {
      method: "DELETE",
    });
    await refreshAll({ silent: false });
  } catch (error) {
    setStatus(`删除失败：${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy) {
  state.isBusy = isBusy;
  const controls = document.querySelectorAll("button, select, input, textarea");
  controls.forEach((control) => {
    control.disabled = isBusy;
  });
}

function setStatus(message, isError) {
  elements.statusText.textContent = message;
  elements.statusText.className = isError ? "status error" : "status";
}

function hydrateWriteToken() {
  if (!elements.writeTokenInput) {
    return;
  }

  try {
    const saved = localStorage.getItem(WRITE_TOKEN_STORAGE_KEY) || "";
    elements.writeTokenInput.value = saved;
  } catch {}
}

function getWriteToken() {
  if (!elements.writeTokenInput) {
    return "";
  }
  return elements.writeTokenInput.value.trim();
}

function saveWriteToken() {
  const token = getWriteToken();
  try {
    if (token) {
      localStorage.setItem(WRITE_TOKEN_STORAGE_KEY, token);
      setStatus("写入令牌已保存。", false);
    } else {
      localStorage.removeItem(WRITE_TOKEN_STORAGE_KEY);
      setStatus("写入令牌为空，已清除。", false);
    }
  } catch {
    setStatus("写入令牌保存失败。", true);
  }
}

function clearWriteToken() {
  if (elements.writeTokenInput) {
    elements.writeTokenInput.value = "";
  }
  try {
    localStorage.removeItem(WRITE_TOKEN_STORAGE_KEY);
  } catch {}
  setStatus("写入令牌已清除。", false);
}

function updateSelectedDateText() {
  elements.selectedDateText.textContent = state.selectedDateKey
    ? `当前日期筛选：${state.selectedDateKey}`
    : "当前日期筛选：无";
}

function focusOnTaskDate(dueAt) {
  if (!dueAt) {
    return;
  }

  const dueDate = new Date(dueAt);
  if (Number.isNaN(dueDate.getTime())) {
    return;
  }

  state.selectedDateKey = toDateKey(dueDate);
  state.monthCursor = firstDayOfMonth(dueDate);
}

function getTasksByDate(dateKey) {
  return state.tasks
    .filter((task) => task.dueAt && toDateKey(new Date(task.dueAt)) === dateKey)
    .sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime());
}

function firstDayOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, diff) {
  return new Date(date.getFullYear(), date.getMonth() + diff, 1);
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "无效时间";
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

async function requestJson(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const token = getWriteToken();
    if (token) {
      headers["X-App-Token"] = token;
    }
  }

  const response = await fetch(url, {
    ...options,
    method,
    headers,
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `请求失败（${response.status}）`);
  }
  return payload;
}
