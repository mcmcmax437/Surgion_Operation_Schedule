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
  if (!container) return;
  container.dataset.options = JSON.stringify(options || []);
  paintPicker(containerId, selected);
}

function paintPicker(containerId, selected = null) {
  const container = $(`#${containerId}`);
  if (!container) return;
  let options = [];
  try {
    options = JSON.parse(container.dataset.options || "[]");
  } catch {
    options = [];
  }
  const checked = selected ?? selectedPickerValues(containerId);
  const searchInput = $(`#${containerId}Search`);
  const term = (searchInput?.value || "").trim().toLowerCase();
  const filtered = term
    ? options.filter((name) => name.toLowerCase().includes(term))
    : options;

  container.innerHTML = filtered.length
    ? filtered.map((name) => `
      <label class="picker-option">
        <input type="checkbox" value="${escapeHtml(name)}" data-picker="${containerId}" ${checked.includes(name) ? "checked" : ""} />
        <span>${escapeHtml(name)}</span>
      </label>`).join("")
    : `<div class="picker-empty">Нікого не знайдено</div>`;
}

function selectedPickerValues(containerId) {
  return [...document.querySelectorAll(`#${containerId} input:checked`)].map((input) => input.value);
}

let canViewLogs = false;

function showView(view) {
  if (view === "logs" && !canViewLogs) {
    view = "schedule";
  }
  if ($("#scheduleView")) $("#scheduleView").hidden = view !== "schedule";
  if ($("#staffView")) $("#staffView").hidden = view !== "staff";
  if ($("#logsView")) $("#logsView").hidden = view !== "logs";
  if ($("#scheduleTab")) $("#scheduleTab").classList.toggle("active", view === "schedule");
  if ($("#staffTab")) $("#staffTab").classList.toggle("active", view === "staff");
  if ($("#logsTab")) $("#logsTab").classList.toggle("active", view === "logs");
  if (view === "logs") loadLogs();
}

function applyLogsVisibility(allowed) {
  canViewLogs = Boolean(allowed);
  if ($("#logsTab")) $("#logsTab").hidden = !canViewLogs;
  if (!canViewLogs && $("#logsView") && !$("#logsView").hidden) {
    showView("schedule");
  }
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

const expandedOperations = new Set();
let mediaObjectUrls = [];

function render() {
  const rows = filteredOperations();

  $("#operationsBody").innerHTML = rows.map((item) => {
    const expanded = expandedOperations.has(item.id);
    return `
    <tr class="op-row ${expanded ? "is-expanded" : "is-collapsed"}" data-id="${item.id}">
      <td class="col-toggle">
        <button class="collapse-toggle" data-action="toggle" data-id="${item.id}" type="button" aria-expanded="${expanded ? "true" : "false"}" title="${expanded ? "Згорнути" : "Розгорнути"}">
          <span class="collapse-chevron" aria-hidden="true"></span>
          <span class="collapse-label">${expanded ? "Згорнути" : "Деталі"}</span>
        </button>
      </td>
      <td class="col-when" data-label="Дата / час">
        <span class="date">${formatDate(item.date)}</span>
        <span class="time">${escapeHtml(item.time || "Час не вказано")}</span>
      </td>
      <td class="col-patient" data-label="Пацієнт">
        <span class="patient">${escapeHtml(item.patient)}</span>
        <span class="sub">${item.isExample ? "Прикладовий рядок" : escapeHtml(item.id)}</span>
      </td>
      <td class="col-diagnosis" data-label="Діагноз">${escapeHtml(item.diagnosis || "—")}</td>
      <td class="col-procedure" data-label="Втручання">${escapeHtml(item.procedure || "—")}</td>
      <td class="col-team" data-label="Операційна бригада">${renderPersonChips(namesForOperation(item, "teamMembers", "team"))}</td>
      <td class="col-anes" data-label="Анестезіологи">${renderPersonChips(namesForOperation(item, "anesthesiologists", "anesthesiologist"))}</td>
      <td class="col-status" data-label="Статус"><span class="status status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
      <td class="col-files" data-label="Файли"><span class="attachments-count">${item.attachments?.length || 0} файл(ів)</span></td>
      <td class="col-actions" data-label="Дії">
        <div class="row-actions">
          <button class="icon-action" data-action="view" data-id="${item.id}" type="button" title="Медіа" aria-label="Медіа">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
          </button>
          <button class="icon-action" data-action="edit" data-id="${item.id}" type="button" title="Змінити" aria-label="Змінити">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
          </button>
          <button class="icon-action danger-action" data-action="delete" data-id="${item.id}" type="button" title="Видалити" aria-label="Видалити">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 7h12v2H6V7zm2 3h8l-1 10H9L8 10zm3-6h2l1 2H10l1-2z"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
  }).join("");

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

function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function isVideoFile(file) {
  const type = file.type || file.mime || "";
  const name = file.name || "";
  return type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(name);
}

function renderAttachmentsPanel(existing = []) {
  const list = $("#attachmentsPanelList");
  const title = $("#attachmentsPanelTitle");
  const hint = $("#attachmentsPanelHint");
  const input = $("#attachments");
  if (!list || !title || !hint) return;

  const pending = [...(input?.files || [])];
  const rows = [];

  existing.forEach((file) => {
    const video = isVideoFile(file);
    rows.push(`<li class="attachment-row is-saved">
      <span class="selected-file-icon">${video ? "🎥" : "🖼️"}</span>
      <span class="selected-file-meta">
        <strong>${escapeHtml(file.name)}</strong>
        <small>${video ? "відео" : "зображення"} · уже збережено</small>
      </span>
      <span class="selected-file-status is-saved">На сервері</span>
    </li>`);
  });

  pending.forEach((file) => {
    const video = isVideoFile(file);
    rows.push(`<li class="attachment-row is-pending">
      <span class="selected-file-icon">${video ? "🎥" : "🖼️"}</span>
      <span class="selected-file-meta">
        <strong>${escapeHtml(file.name)}</strong>
        <small>${escapeHtml(formatFileSize(file.size))} · ${video ? "відео" : "зображення"} · нове</small>
      </span>
      <span class="selected-file-status">До збереження</span>
    </li>`);
  });

  list.innerHTML = rows.length
    ? rows.join("")
    : `<li class="attachment-row is-empty">Файлів ще немає. Оберіть зображення або відео вище.</li>`;

  const total = existing.length + pending.length;
  title.textContent = total ? `Прикріплені файли (${total})` : "Прикріплені файли";
  if (pending.length && existing.length) {
    hint.textContent = `${existing.length} на сервері · ${pending.length} нових буде завантажено після збереження`;
  } else if (pending.length) {
    hint.textContent = `${pending.length} файл(ів) буде завантажено після натискання «Зберегти операцію»`;
  } else if (existing.length) {
    hint.textContent = `${existing.length} файл(ів) уже збережено. Можна додати ще.`;
  } else {
    hint.textContent = "Поки файлів немає";
  }
}

let currentFormAttachments = [];

function resetForm() {
  editingId = null;
  currentFormAttachments = [];
  $("#operationForm").reset();
  $("#operationId").value = "";
  $("#dialogTitle").textContent = "Нова операція";
  if ($("#teamPickerSearch")) $("#teamPickerSearch").value = "";
  if ($("#anesthesiologistPickerSearch")) $("#anesthesiologistPickerSearch").value = "";
  if ($("#deleteOperation")) $("#deleteOperation").hidden = true;
  renderAttachmentsPanel([]);
  const progress = $("#uploadProgress");
  if (progress) progress.hidden = true;
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
    if ($("#deleteOperation")) $("#deleteOperation").hidden = false;

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
    currentFormAttachments = item.attachments || [];
    renderAttachmentsPanel(currentFormAttachments);
  } else {
    renderAttachmentsPanel([]);
  }

  $("#operationDialog").showModal();
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
  const maxBytes = 512 * 1024 * 1024;
  for (const file of files) {
    if (file.type && !file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      alert("Дозволені лише зображення та відео.");
      return;
    }
    if (file.size > maxBytes) {
      alert(`Файл «${file.name}» завеликий. Максимум 512 МБ.`);
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
    if (progress) {
      progress.hidden = false;
      progress.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
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
      if (xhr.status === 413) {
        reject(new Error((data && data.error) || "Файл завеликий для сервера (ліміт 512 МБ)."));
        return;
      }
      reject(new Error((data && data.error) || `API error ${xhr.status}`));
    };

    xhr.ontimeout = () => reject(new Error("Час очікування вичерпано під час завантаження відео. Спробуйте менший файл."));
    xhr.timeout = 600000;

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

async function deleteOperation(id) {
  const item = operations.find((operation) => operation.id === id);
  if (!item) return;
  if (!confirm(`Видалити операцію «${item.patient}» (${item.id})?`)) return;
  try {
    await api(`/operations/${id}`, { method: "DELETE" });
    if (editingId === id) $("#operationDialog")?.close();
    await refresh();
  } catch (error) {
    alert(error.message || "Не вдалося видалити операцію.");
  }
}

function clearMediaObjectUrls() {
  mediaObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  mediaObjectUrls = [];
}

function closeMediaDialog() {
  const dialog = $("#mediaDialog");
  dialog?.querySelectorAll("video").forEach((video) => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  });
  clearMediaObjectUrls();
  if ($("#mediaDialogBody")) $("#mediaDialogBody").innerHTML = "";
  dialog?.close();
}

async function viewOperation(id) {
  const item = operations.find((operation) => operation.id === id);
  if (!item) return;

  const dialog = $("#mediaDialog");
  const body = $("#mediaDialogBody");
  if (!dialog || !body) return;

  clearMediaObjectUrls();
  if ($("#mediaDialogTitle")) $("#mediaDialogTitle").textContent = item.patient || "Медіа";
  if ($("#mediaDialogMeta")) {
    $("#mediaDialogMeta").textContent = `${item.id || ""} · ${(item.attachments || []).length} файл(ів) · завантаження…`;
  }
  body.innerHTML = `<p class="empty-media">Завантаження медіа…</p>`;
  dialog.showModal();

  const files = [];
  for (const metadata of item.attachments || []) {
    try {
      const url = await attachmentUrl(metadata.id);
      mediaObjectUrls.push(url);
      files.push({ metadata, url });
    } catch {
      // skip missing file
    }
  }

  if ($("#mediaDialogMeta")) {
    $("#mediaDialogMeta").textContent = `${item.id || ""} · ${files.length} файл(ів)`;
  }

  body.innerHTML = files.length
    ? files.map(({ metadata, url }) => {
      const isVideo = (metadata.type || "").startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(metadata.name || "");
      return `<figure class="media-card">
        <figcaption>${escapeHtml(metadata.name)}</figcaption>
        ${isVideo
          ? `<video controls preload="metadata" src="${url}"></video>`
          : `<img src="${url}" alt="${escapeHtml(metadata.name)}">`}
      </figure>`;
    }).join("")
    : `<p class="empty-media">Немає прикріплених фото або відео.</p>`;
}

function toggleOperation(id) {
  if (expandedOperations.has(id)) expandedOperations.delete(id);
  else expandedOperations.add(id);
  render();
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
  const [ops, staffData, session] = await Promise.all([
    api("/operations"),
    api("/staff"),
    api("/session"),
  ]);
  operations = ops;
  staff = staffData;
  applyLogsVisibility(session?.canViewLogs);
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
on("#attachments", "change", () => renderAttachmentsPanel(currentFormAttachments));
on("#operationForm", "submit", saveOperation);
on("#search", "input", render);
on("#statusFilter", "change", render);
on("#teamPickerSearch", "input", () => paintPicker("teamPicker"));
on("#anesthesiologistPickerSearch", "input", () => paintPicker("anesthesiologistPicker"));
on("#deleteOperation", "click", () => {
  if (editingId) deleteOperation(editingId);
});
on("#closeMediaDialog", "click", closeMediaDialog);
on("#mediaDialog", "close", closeMediaDialog);
on("#mediaDialog", "click", (event) => {
  if (event.target === $("#mediaDialog")) closeMediaDialog();
});
on("#operationsBody", "click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "toggle") toggleOperation(button.dataset.id);
  if (button.dataset.action === "edit") openForm(button.dataset.id);
  if (button.dataset.action === "view") viewOperation(button.dataset.id);
  if (button.dataset.action === "delete") deleteOperation(button.dataset.id);
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
