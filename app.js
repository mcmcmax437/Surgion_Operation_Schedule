if (!window.SurgeryAPI) {
  alert("Не завантажено api.js. Зробіть hard-refresh (Ctrl+F5) або перевірте деплой.");
  throw new Error("SurgeryAPI missing");
}

const { api, AUTH_KEY, TOKEN_KEY, API_BASE } = window.SurgeryAPI;

if (sessionStorage.getItem(AUTH_KEY) !== "1" || !sessionStorage.getItem(TOKEN_KEY)) {
  window.location.replace("login.html");
}

const $ = (selector) => document.querySelector(selector);
const on = (selector, event, handler) => {
  const node = $(selector);
  if (node) node.addEventListener(event, handler);
};
let operations = [];
let staff = { team: [], anesthesiologists: [] };
let editingId = null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[character]));
}

function formatDate(date) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00`));
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function namesForOperation(item, field, fallback) {
  return Array.isArray(item[field]) && item[field].length ? item[field] : (item[fallback] ? [item[fallback]] : []);
}

function renderPersonChips(names) {
  if (!names.length) return '<span class="sub">Не призначено</span>';
  return `<div class="people-chips">${names.map((name) => `<span class="person-chip">${escapeHtml(name)}</span>`).join("")}</div>`;
}

function renderPicker(containerId, options, selected = []) {
  const container = $(`#${containerId}`);
  container.innerHTML = options.map((name) => `
    <label><input type="checkbox" value="${escapeHtml(name)}" data-picker="${containerId}" ${selected.includes(name) ? "checked" : ""} /> ${escapeHtml(name)}</label>
  `).join("");
}

function selectedPickerValues(containerId) {
  return [...document.querySelectorAll(`#${containerId} input:checked`)].map((input) => input.value);
}

function showView(view) {
  if ($("#scheduleView")) $("#scheduleView").hidden = view !== "schedule";
  if ($("#staffView")) $("#staffView").hidden = view !== "staff";
  if ($("#logsView")) $("#logsView").hidden = view !== "logs";
  if ($("#scheduleTab")) $("#scheduleTab").classList.toggle("active", view === "schedule");
  if ($("#staffTab")) $("#staffTab").classList.toggle("active", view === "staff");
  if ($("#logsTab")) $("#logsTab").classList.toggle("active", view === "logs");
  if (view === "logs") loadLogs();
}

function renderStaffLists() {
  const build = (type, listId, countId) => {
    const list = staff[type];
    $(`#${countId}`).textContent = list.length;
    $(`#${listId}`).innerHTML = list.map((name, index) => {
      const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      return `<div class="staff-person">
        <span class="staff-person-avatar">${escapeHtml(initials)}</span>
        <span class="staff-person-name">${escapeHtml(name)}</span>
        <div class="staff-actions">
          <button type="button" data-staff-action="edit" data-staff-type="${type}" data-index="${index}">Редагувати</button>
          <button type="button" data-staff-action="delete" data-staff-type="${type}" data-index="${index}">Видалити</button>
        </div>
      </div>`;
    }).join("");
  };

  build("team", "teamStaffList", "teamCount");
  build("anesthesiologists", "anesthesiologistStaffList", "anesthesiologistCount");
  renderPicker("teamPicker", staff.team);
  renderPicker("anesthesiologistPicker", staff.anesthesiologists);
}

function resetStaffForm(type) {
  const prefix = type === "team" ? "team" : "anesthesiologist";
  $(`#${prefix}NameInput`).value = "";
  $(`#${prefix}EditIndex`).value = "";
  $(`#${prefix}SaveButton`).textContent = "+ Додати людину";
  $(`#${prefix}CancelEdit`).hidden = true;
}

async function saveStaffLists() {
  staff = await api("/staff", { method: "PUT", json: staff });
  renderStaffLists();
}

async function submitStaff(type, event) {
  event.preventDefault();
  const prefix = type === "team" ? "team" : "anesthesiologist";
  const name = $(`#${prefix}NameInput`).value.trim();
  const editIndex = $(`#${prefix}EditIndex`).value;
  if (!name) return;
  if (staff[type].some((item, index) => item.toLowerCase() === name.toLowerCase() && String(index) !== editIndex)) {
    alert("Ця людина вже є у списку.");
    return;
  }
  if (editIndex === "") staff[type].push(name);
  else staff[type][Number(editIndex)] = name;
  await saveStaffLists();
  resetStaffForm(type);
}

function editStaff(type, index) {
  const prefix = type === "team" ? "team" : "anesthesiologist";
  $(`#${prefix}NameInput`).value = staff[type][index];
  $(`#${prefix}EditIndex`).value = index;
  $(`#${prefix}SaveButton`).textContent = "Зберегти зміни";
  $(`#${prefix}CancelEdit`).hidden = false;
  $(`#${prefix}NameInput`).focus();
}

async function deleteStaff(type, index) {
  if (!confirm(`Видалити «${staff[type][index]}» зі списку?`)) return;
  staff[type].splice(index, 1);
  await saveStaffLists();
}

function filteredOperations() {
  const searchTerm = $("#search").value.trim().toLowerCase();
  const selectedStatus = $("#statusFilter").value;

  return [...operations]
    .sort((a, b) => {
      const first = new Date(`${a.date || "9999-12-31"}T${a.time || "23:59"}`).getTime();
      const second = new Date(`${b.date || "9999-12-31"}T${b.time || "23:59"}`).getTime();
      return first - second;
    })
    .filter((item) => {
      const text = [item.patient, item.diagnosis, item.procedure, item.team, ...(item.teamMembers || []), ...(item.anesthesiologists || []), item.id]
        .join(" ")
        .toLowerCase();
      return (!searchTerm || text.includes(searchTerm))
        && (selectedStatus === "all" || item.status === selectedStatus);
    });
}

function render() {
  const rows = filteredOperations();

  $("#operationsBody").innerHTML = rows.map((item) => `
    <tr>
      <td data-label="Дата / час">
        <span class="date">${formatDate(item.date)}</span>
        <span class="time">${escapeHtml(item.time || "Час не вказано")}</span>
      </td>
      <td data-label="Пацієнт">
        <span class="patient">${escapeHtml(item.patient)}</span>
        <span class="sub">${item.isExample ? "Прикладовий рядок" : escapeHtml(item.id)}</span>
      </td>
      <td data-label="Діагноз">${escapeHtml(item.diagnosis || "—")}</td>
      <td data-label="Втручання">${escapeHtml(item.procedure || "—")}</td>
      <td data-label="Операційна бригада">${renderPersonChips(namesForOperation(item, "teamMembers", "team"))}</td>
      <td data-label="Анестезіологи">${renderPersonChips(namesForOperation(item, "anesthesiologists", "anesthesiologist"))}</td>
      <td data-label="Статус"><span class="status status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
      <td data-label="Файли"><span class="attachments-count">${item.attachments?.length || 0} файл(ів)</span></td>
      <td data-label="Дії">
        <div class="row-actions">
          <button class="icon-action" data-action="view" data-id="${item.id}" type="button" title="Відкрити" aria-label="Відкрити">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
          </button>
          <button class="icon-action" data-action="edit" data-id="${item.id}" type="button" title="Змінити" aria-label="Змінити">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          </button>
        </div>
      </td>
    </tr>`).join("");

  $("#emptyState").hidden = rows.length > 0;
  const realOperations = operations.filter((item) => !item.isExample);
  $("#totalCount").textContent = realOperations.length;
  $("#plannedCount").textContent = realOperations.filter((item) => item.status === "Заплановано").length;

  const next = realOperations
    .filter((item) => item.date && item.status !== "Скасовано")
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  $("#nextDate").textContent = next ? formatDate(next.date) : "—";
  $("#fileCount").textContent = operations.reduce((sum, item) => sum + (item.attachments?.length || 0), 0);
}

function resetForm() {
  editingId = null;
  $("#operationForm").reset();
  $("#operationId").value = "";
  $("#dialogTitle").textContent = "Нова операція";
  $("#existingAttachments").innerHTML = "";
  renderPicker("teamPicker", staff.team);
  renderPicker("anesthesiologistPicker", staff.anesthesiologists);
}

function openForm(id = null) {
  resetForm();

  if (id) {
    const item = operations.find((operation) => operation.id === id);
    if (!item) return;
    editingId = id;
    $("#dialogTitle").textContent = "Редагування операції";

    const fields = {
      operationDate: item.date,
      operationTime: item.time,
      patientName: item.patient,
      birthDate: item.birthDate,
      bloodGroup: item.bloodGroup,
      diagnosis: item.diagnosis,
      procedure: item.procedure,
      status: item.status,
      notes: item.notes,
    };

    Object.entries(fields).forEach(([field, value]) => {
      if ($(`#${field}`)) $(`#${field}`).value = value || "";
    });
    renderPicker("teamPicker", staff.team, namesForOperation(item, "teamMembers", "team"));
    renderPicker("anesthesiologistPicker", staff.anesthesiologists, namesForOperation(item, "anesthesiologists", "anesthesiologist"));
    renderExistingAttachments(item);
  }

  $("#operationDialog").showModal();
}

function renderExistingAttachments(item) {
  $("#existingAttachments").innerHTML = (item.attachments || []).map((file) => `
    <span class="attachment-chip">${file.type.startsWith("video/") ? "🎥" : "🖼️"} ${escapeHtml(file.name)}</span>
  `).join("");
}

async function saveOperation(event) {
  event.preventDefault();

  const data = {
    date: $("#operationDate").value,
    time: $("#operationTime").value,
    patient: $("#patientName").value.trim(),
    birthDate: $("#birthDate").value,
    bloodGroup: $("#bloodGroup").value,
    teamMembers: selectedPickerValues("teamPicker"),
    diagnosis: $("#diagnosis").value.trim(),
    procedure: $("#procedure").value.trim(),
    anesthesiologists: selectedPickerValues("anesthesiologistPicker"),
    status: $("#status").value,
    notes: $("#notes").value.trim(),
  };

  if (!data.date || !data.patient || !data.procedure) {
    alert("Заповніть дату, ПІБ пацієнта та вид втручання.");
    return;
  }

  const files = [...($("#attachments")?.files || [])];
  for (const file of files) {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      alert("Дозволені лише зображення та відео.");
      return;
    }
  }

  const formData = new FormData();
  Object.entries(data).forEach(([key, value]) => {
    if (Array.isArray(value)) formData.append(key, JSON.stringify(value));
    else formData.append(key, value ?? "");
  });
  files.forEach((file) => formData.append("files", file));

  const saveButton = $("#saveOperation");
  const progress = $("#uploadProgress");
  const progressBar = $("#uploadProgressBar");
  const progressPercent = $("#uploadProgressPercent");
  const progressLabel = $("#uploadProgressLabel");
  const path = editingId ? `/operations/${editingId}` : "/operations";
  const method = editingId ? "PUT" : "POST";

  const setProgress = (value, label) => {
    const percent = Math.max(0, Math.min(100, Math.round(value)));
    if (progress) progress.hidden = false;
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressPercent) progressPercent.textContent = `${percent}%`;
    if (progressLabel) progressLabel.textContent = label;
  };

  if (saveButton) saveButton.disabled = true;

  try {
    if (files.length) setProgress(0, `Завантаження ${files.length} файл(ів)…`);
    else setProgress(10, "Збереження операції…");

    await uploadForm(path, method, formData, (loaded, total) => {
      if (!total) {
        setProgress(50, "Завантаження файлів…");
        return;
      }
      const percent = (loaded / total) * 100;
      setProgress(percent, percent >= 100 ? "Обробка на сервері…" : `Завантаження файлів… ${Math.round(percent)}%`);
    });

    setProgress(100, "Готово");
    $("#operationDialog").close();
    await refresh();
  } catch (error) {
    alert(error.message || "Не вдалося зберегти операцію.");
  } finally {
    if (saveButton) saveButton.disabled = false;
    if (progress) progress.hidden = true;
    if (progressBar) progressBar.style.width = "0%";
  }
}

function uploadForm(path, method, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, `${API_BASE}${path}`);
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (typeof onProgress === "function") {
        onProgress(event.loaded, event.lengthComputable ? event.total : 0);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 401) {
        sessionStorage.removeItem(AUTH_KEY);
        sessionStorage.removeItem(TOKEN_KEY);
        window.location.replace("login.html");
        reject(new Error("Unauthorized"));
        return;
      }

      let data = null;
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        data = null;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      reject(new Error((data && data.error) || `API error ${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error("Немає зв’язку з API під час завантаження файлів."));
    xhr.send(formData);
  });
}

async function attachmentUrl(id) {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const response = await fetch(`${API_BASE}/attachments/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Не вдалося завантажити файл");
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

async function viewOperation(id) {
  const item = operations.find((operation) => operation.id === id);
  if (!item) return;

  const files = [];
  for (const metadata of item.attachments || []) {
    try {
      files.push({ metadata, url: await attachmentUrl(metadata.id) });
    } catch {
      // skip missing file
    }
  }

  const attachmentHtml = files.length
    ? files.map(({ metadata, url }) => metadata.type.startsWith("video/")
      ? `<video controls src="${url}" style="max-width:100%;max-height:300px"></video>`
      : `<img src="${url}" alt="${escapeHtml(metadata.name)}" style="max-width:100%;max-height:300px">`).join("")
    : "<p>Файлів немає.</p>";

  const details = window.open("", "_blank", "width=760,height=720");
  details.document.write(`<title>${escapeHtml(item.patient)}</title>
    <style>body{font:16px system-ui;padding:28px;color:#1f2937}h1{color:#17365d}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.card{padding:12px;background:#f4f7fb;border-radius:8px}img,video{display:block;margin:12px 0}</style>
    <h1>${escapeHtml(item.patient)}</h1>
    <div class="grid">
      <div class="card"><b>Дата</b><br>${formatDate(item.date)} ${escapeHtml(item.time || "")}</div>
      <div class="card"><b>Статус</b><br>${escapeHtml(item.status)}</div>
      <div class="card"><b>Втручання</b><br>${escapeHtml(item.procedure)}</div>
      <div class="card"><b>Операційна бригада</b><br>${escapeHtml(namesForOperation(item, "teamMembers", "team").join(", ") || "—")}</div>
      <div class="card"><b>Анестезіологи</b><br>${escapeHtml(namesForOperation(item, "anesthesiologists", "anesthesiologist").join(", ") || "—")}</div>
      <div class="card"><b>Діагноз</b><br>${escapeHtml(item.diagnosis || "—")}</div>
      <div class="card"><b>Група крові</b><br>${escapeHtml(item.bloodGroup || "—")}</div>
    </div>
    <h2>Прикріплені файли</h2>${attachmentHtml}<p>${escapeHtml(item.notes || "")}</p>`);
  details.document.close();
}

async function loadLogs() {
  try {
    const [changes, access] = await Promise.all([
      api("/logs/changes?limit=150"),
      api("/logs/access?limit=150"),
    ]);

    $("#changeLogsBody").innerHTML = changes.map((item) => `
      <tr>
        <td data-label="Час">${escapeHtml(formatDateTime(item.createdAt))}</td>
        <td data-label="Дія">${escapeHtml(item.action)}</td>
        <td data-label="Опис">${escapeHtml(item.summary)}</td>
        <td data-label="Поля">${escapeHtml((item.changedFields || []).join(", ") || "—")}</td>
        <td data-label="IP">${escapeHtml(item.ip || "—")}</td>
      </tr>
    `).join("") || `<tr><td colspan="5">Змін ще немає.</td></tr>`;

    $("#accessLogsBody").innerHTML = access.map((item) => `
      <tr>
        <td data-label="Час">${escapeHtml(formatDateTime(item.createdAt))}</td>
        <td data-label="Подія">${escapeHtml(item.event)}</td>
        <td data-label="IP">${escapeHtml(item.ip || "—")}</td>
        <td data-label="Браузер">${escapeHtml(item.userAgent || "—")}</td>
      </tr>
    `).join("") || `<tr><td colspan="4">Записів ще немає.</td></tr>`;
  } catch (error) {
    alert(error.message || "Не вдалося завантажити журнали.");
  }
}

function setTheme(theme) {
  document.documentElement.classList.toggle("theme-dark", theme === "dark");
  localStorage.setItem("surgery-theme", theme);
  if ($("#themeToggle")) $("#themeToggle").checked = theme === "dark";
}

async function refresh() {
  const [ops, staffData] = await Promise.all([
    api("/operations"),
    api("/staff"),
  ]);
  operations = ops;
  staff = staffData;
  renderStaffLists();
  render();
}

on("#themeToggle", "change", (event) => setTheme(event.target.checked ? "dark" : "light"));
on("#scheduleTab", "click", () => showView("schedule"));
on("#staffTab", "click", () => showView("staff"));
on("#logsTab", "click", () => showView("logs"));
on("#teamStaffForm", "submit", (event) => submitStaff("team", event));
on("#anesthesiologistStaffForm", "submit", (event) => submitStaff("anesthesiologists", event));
on("#teamCancelEdit", "click", () => resetStaffForm("team"));
on("#anesthesiologistCancelEdit", "click", () => resetStaffForm("anesthesiologists"));
on("#staffView", "click", (event) => {
  const button = event.target.closest("button[data-staff-action]");
  if (!button) return;
  const type = button.dataset.staffType;
  const index = Number(button.dataset.index);
  if (button.dataset.staffAction === "edit") editStaff(type, index);
  if (button.dataset.staffAction === "delete") deleteStaff(type, index);
});
on("#logout", "click", async () => {
  try {
    await api("/logout", { method: "POST", json: {} });
  } catch {
    // ignore
  }
  sessionStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(TOKEN_KEY);
  window.location.replace("login.html");
});
on("#addOperation", "click", () => openForm());
on("#closeOperation", "click", () => $("#operationDialog")?.close());
on("#cancelOperation", "click", () => $("#operationDialog")?.close());
on("#operationForm", "submit", saveOperation);
on("#search", "input", render);
on("#statusFilter", "change", render);
on("#operationsBody", "click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "edit") openForm(button.dataset.id);
  if (button.dataset.action === "view") viewOperation(button.dataset.id);
});
on("#exportData", "click", () => {
  const blob = new Blob([JSON.stringify(operations, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `surgery-operations-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
});
on("#refreshLogs", "click", () => loadLogs());

setTheme(localStorage.getItem("surgery-theme") || "light");
showView("schedule");

refresh().catch((error) => {
  console.error(error);
  alert("Не вдалося завантажити дані з сервера. Перевірте API / MySQL.");
});
