const DB_NAME = "surgery-operation-files";
const DB_VERSION = 1;
const FILE_STORE = "files";
const OPERATIONS_KEY = "surgery-operations-v1";
const AUTH_KEY = "surgery-authenticated";
const DEFAULT_TEAM_MEMBERS = [
  "Ковальчук Олександр Петрович",
  "Мельник Ірина Вікторівна",
  "Бондаренко Андрій Сергійович",
  "Шевченко Наталія Олегівна",
  "Ткаченко Дмитро Ігорович",
];
const DEFAULT_ANESTHESIOLOGISTS = [
  "Петренко Олена Володимирівна",
  "Савчук Роман Олександрович",
  "Лисенко Марія Ігорівна",
];

if (sessionStorage.getItem(AUTH_KEY) !== "1") {
  window.location.replace("login.html");
}

const $ = (selector) => document.querySelector(selector);
let operations = JSON.parse(localStorage.getItem(OPERATIONS_KEY) || "null");
const STAFF_KEY = "surgery-staff-v1";
let staff = JSON.parse(localStorage.getItem(STAFF_KEY) || "null") || {
  team: DEFAULT_TEAM_MEMBERS,
  anesthesiologists: DEFAULT_ANESTHESIOLOGISTS,
};
let editingId = null;

function seed() {
  if (operations) return;

  operations = [{
    id: "OP-0001",
    isExample: true,
    date: "2026-08-15",
    time: "08:30",
    patient: "ПРИКЛАД: Іваненко Іван Іванович",
    birthDate: "1980-01-01",
    diagnosis: "ПРИКЛАД: плановий діагноз",
    procedure: "ПРИКЛАД: планове втручання",
    teamMembers: [staff.team[0] || "Ковальчук Олександр Петрович", staff.team[1] || "Мельник Ірина Вікторівна"],
    anesthesiologists: [staff.anesthesiologists[0] || "Петренко Олена Володимирівна"],
    bloodGroup: "A (II) Rh+",
    status: "Заплановано",
    notes: "Це тестовий рядок. Реальні записи додавайте кнопкою «Додати операцію».",
    attachments: [],
    createdAt: new Date().toISOString(),
  }];

  persist();
}

function persist() {
  localStorage.setItem(OPERATIONS_KEY, JSON.stringify(operations));
}

function persistStaff() {
  localStorage.setItem(STAFF_KEY, JSON.stringify(staff));
}

function renderPersonChips(names) {
  if (!names.length) return '<span class="sub">Не призначено</span>';
  return `<div class="people-chips">${names.map((name) => `<span class="person-chip">${escapeHtml(name)}</span>`).join("")}</div>`;
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

function submitStaff(type, event) {
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
  persistStaff();
  resetStaffForm(type);
  renderStaffLists();
}

function editStaff(type, index) {
  const prefix = type === "team" ? "team" : "anesthesiologist";
  $(`#${prefix}NameInput`).value = staff[type][index];
  $(`#${prefix}EditIndex`).value = index;
  $(`#${prefix}SaveButton`).textContent = "Зберегти зміни";
  $(`#${prefix}CancelEdit`).hidden = false;
  $(`#${prefix}NameInput`).focus();
}

function deleteStaff(type, index) {
  if (!confirm(`Видалити «${staff[type][index]}» зі списку?`)) return;
  staff[type].splice(index, 1);
  persistStaff();
  renderStaffLists();
}

function showView(view) {
  const isStaff = view === "staff";
  $("#scheduleView").hidden = isStaff;
  $("#staffView").hidden = !isStaff;
  $("#scheduleTab").classList.toggle("active", !isStaff);
  $("#staffTab").classList.toggle("active", isStaff);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(FILE_STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveFile(file) {
  const db = await openDb();
  const id = crypto.randomUUID();

  await new Promise((resolve, reject) => {
    const transaction = db.transaction(FILE_STORE, "readwrite");
    transaction.objectStore(FILE_STORE).put({ id, name: file.name, type: file.type, size: file.size, blob: file });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });

  return { id, name: file.name, type: file.type, size: file.size };
}

async function getFile(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(FILE_STORE, "readonly").objectStore(FILE_STORE).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function nextId() {
  const max = operations.reduce(
    (highest, item) => Math.max(highest, Number(item.id?.replace("OP-", "")) || 0),
    0,
  );
  return `OP-${String(max + 1).padStart(4, "0")}`;
}

function formatDate(date) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00`));
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[character]));
}

function namesForOperation(item, field, fallback) {
  return Array.isArray(item[field]) && item[field].length ? item[field] : (item[fallback] ? [item[fallback]] : []);
}

function renderPicker(containerId, options, selected = []) {
  const container = $(`#${containerId}`);
  container.innerHTML = options.map((name, index) => `
    <label><input type="checkbox" value="${escapeHtml(name)}" data-picker="${containerId}" ${selected.includes(name) ? "checked" : ""} /> ${escapeHtml(name)}</label>
  `).join("");
}

function selectedPickerValues(containerId) {
  return [...document.querySelectorAll(`#${containerId} input:checked`)].map((input) => input.value);
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
        <span class="sub">${item.isExample ? "Прикладовий рядок" : ""}</span>
      </td>
      <td data-label="Діагноз">${escapeHtml(item.diagnosis || "—")}</td>
      <td data-label="Втручання">${escapeHtml(item.procedure || "—")}</td>
      <td data-label="Операційна бригада">${renderPersonChips(namesForOperation(item, "teamMembers", "team"))}</td>
      <td data-label="Анестезіологи">${renderPersonChips(namesForOperation(item, "anesthesiologists", "anesthesiologist"))}</td>
      <td data-label="Статус"><span class="status status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
      <td data-label="Файли"><span class="attachments-count">${item.attachments?.length || 0} файл(ів)</span></td>
      <td data-label="Дії">
        <div class="row-actions">
          <button data-action="view" data-id="${item.id}">Відкрити</button>
          <button data-action="edit" data-id="${item.id}">Змінити</button>
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
      teamMembers: namesForOperation(item, "teamMembers", "team"),
      diagnosis: item.diagnosis,
      procedure: item.procedure,
      status: item.status,
      notes: item.notes,
    };

    Object.entries(fields).forEach(([field, value]) => {
      if ($(`#${field}`)) $(`#${field}`).value = value || "";
    });
    renderPicker("teamPicker", staff.team, fields.teamMembers);
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

  const newFiles = [];
  for (const file of [...$("#attachments").files]) {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      alert("Дозволені лише зображення та відео.");
      return;
    }
    newFiles.push(await saveFile(file));
  }

  if (editingId) {
    const item = operations.find((operation) => operation.id === editingId);
    Object.assign(item, data);
    item.attachments = [...(item.attachments || []), ...newFiles];
  } else {
    operations.push({ id: nextId(), ...data, attachments: newFiles, isExample: false, createdAt: new Date().toISOString() });
  }

  persist();
  $("#operationDialog").close();
  render();
}

async function viewOperation(id) {
  const item = operations.find((operation) => operation.id === id);
  if (!item) return;

  const files = [];
  for (const metadata of item.attachments || []) {
    const stored = await getFile(metadata.id);
    if (stored) files.push({ metadata, url: URL.createObjectURL(stored.blob) });
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

function setTheme(theme) {
  document.documentElement.classList.toggle("theme-dark", theme === "dark");
  localStorage.setItem("surgery-theme", theme);
  $("#themeToggle").checked = theme === "dark";
}

$("#themeToggle").addEventListener("change", (event) => setTheme(event.target.checked ? "dark" : "light"));
$("#scheduleTab").addEventListener("click", () => showView("schedule"));
$("#staffTab").addEventListener("click", () => showView("staff"));
$("#teamStaffForm").addEventListener("submit", (event) => submitStaff("team", event));
$("#anesthesiologistStaffForm").addEventListener("submit", (event) => submitStaff("anesthesiologists", event));
$("#teamCancelEdit").addEventListener("click", () => resetStaffForm("team"));
$("#anesthesiologistCancelEdit").addEventListener("click", () => resetStaffForm("anesthesiologists"));
$("#staffView").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-staff-action]");
  if (!button) return;
  const type = button.dataset.staffType;
  const index = Number(button.dataset.index);
  if (button.dataset.staffAction === "edit") editStaff(type, index);
  if (button.dataset.staffAction === "delete") deleteStaff(type, index);
});
$("#logout").addEventListener("click", () => { sessionStorage.removeItem(AUTH_KEY); window.location.replace("login.html"); });
$("#addOperation").addEventListener("click", () => openForm());
$("#closeOperation").addEventListener("click", () => $("#operationDialog").close());
$("#cancelOperation").addEventListener("click", () => $("#operationDialog").close());
$("#operationForm").addEventListener("submit", saveOperation);
$("#search").addEventListener("input", render);
$("#statusFilter").addEventListener("change", render);
$("#operationsBody").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "edit") openForm(button.dataset.id);
  if (button.dataset.action === "view") viewOperation(button.dataset.id);
});
$("#exportData").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(operations, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `surgery-operations-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
});
$("#importData").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported)) throw new Error();
    operations = imported;
    persist();
    render();
  } catch {
    alert("Не вдалося імпортувати файл JSON.");
  }
  event.target.value = "";
});

setTheme(localStorage.getItem("surgery-theme") || "light");
seed();
renderStaffLists();
showView("schedule");
render();
