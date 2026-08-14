if (!window.SurgeryAPI) {
  alert("Не завантажено api.js. Зробіть hard-refresh (Ctrl+F5) або перевірте деплой.");
  throw new Error("SurgeryAPI missing");
}

const { api, API_BASE, getToken, isAuthenticated, clearAuth } = window.SurgeryAPI;

if (!getToken()) {
  window.location.replace("login.html");
}

const $ = (selector) => document.querySelector(selector);
const on = (selector, event, handler) => {
  const node = $(selector);
  if (node) node.addEventListener(event, handler);
};
let operations = [];
let archivedOperations = [];
let staff = { team: [], anesthesiologists: [] };
let editingId = null;
const ARCHIVE_RETENTION_DAYS = 7;
const DEPARTMENTS = [
  { id: "dept1", label: "Хірургічне відділення №1" },
  { id: "dept2", label: "Хірургічне відділення №2" },
];
const INFECTION_OPTIONS = ["HCV", "HbsAg", "HIV", "RW"];
const WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт"];
let defaultDepartment = localStorage.getItem("surgery-dept") === "dept2" ? "dept2" : "dept1";

function addDaysYmd(ymd, days) {
  const [year, month, day] = String(ymd).split("-").map(Number);
  const date = new Date(year, month - 1, day + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function todayYmd() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function mondayOf(ymd) {
  const [year, month, day] = String(ymd).split("-").map(Number);
  const sunday0 = new Date(year, month - 1, day).getDay();
  const offset = sunday0 === 0 ? -6 : 1 - sunday0;
  return addDaysYmd(ymd, offset);
}

function currentWorkWeekMonday() {
  const today = todayYmd();
  const monday = mondayOf(today);
  const sunday0 = new Date(`${today}T12:00:00`).getDay();
  if (sunday0 === 0 || sunday0 === 6) return addDaysYmd(monday, 7);
  return monday;
}

function formatDayMonth(ymd) {
  if (!ymd) return "—";
  const [, month, day] = ymd.split("-");
  return `${day}.${month}`;
}

function formatWeekRange(monday) {
  return `${formatDayMonth(monday)}–${formatDayMonth(addDaysYmd(monday, 4))}`;
}

function departmentLabel(id) {
  return DEPARTMENTS.find((item) => item.id === id)?.label || "Відділення";
}

function infectionLabel(item) {
  const selected = (item.infections || []).filter((value) => INFECTION_OPTIONS.includes(value));
  return selected.length ? selected.join(", ") : "Без супутніх інфекцій";
}

function selectedInfections() {
  return [...document.querySelectorAll("#infectionPicks input:checked")].map((input) => input.value);
}

function setSelectedInfections(values = []) {
  document.querySelectorAll("#infectionPicks input").forEach((input) => {
    input.checked = values.includes(input.value);
  });
}

function setActiveDepartment(id) {
  defaultDepartment = id === "dept2" ? "dept2" : "dept1";
  localStorage.setItem("surgery-dept", defaultDepartment);
  document.querySelectorAll(".dept-board").forEach((board) => {
    board.hidden = board.dataset.dept !== defaultDepartment;
  });
  document.querySelectorAll(".dept-pill").forEach((button) => {
    button.classList.toggle("active", button.dataset.dept === defaultDepartment);
  });
  if ($("#activeDeptLabel")) $("#activeDeptLabel").textContent = departmentLabel(defaultDepartment);
  if ($("#department") && !$("#operationDialog")?.open) {
    $("#department").value = defaultDepartment;
  }
}

function cycleDepartment(step) {
  const index = DEPARTMENTS.findIndex((item) => item.id === defaultDepartment);
  const next = DEPARTMENTS[(index + step + DEPARTMENTS.length) % DEPARTMENTS.length];
  setActiveDepartment(next.id);
}

let weekMonday = currentWorkWeekMonday();

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
  if (!date) return "Без дати";
  return new Intl.DateTimeFormat("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00`));
}

function formatShortName(value) {
  const raw = String(value || "").trim().replace(/\s+/g, " ");
  if (!raw) return "";
  const parts = raw.split(" ");
  const surname = parts[0];
  const initials = parts.slice(1).flatMap((token) => {
    if (token.includes(".")) {
      return token.split(".").filter(Boolean).map((part) => {
        const letter = part.match(/[A-Za-zА-Яа-яІіЇїЄєҐґЁё]/);
        return letter ? `${letter[0].toUpperCase()}.` : "";
      }).filter(Boolean);
    }
    const letter = token.match(/[A-Za-zА-Яа-яІіЇїЄєҐґЁё]/);
    return letter ? [`${letter[0].toUpperCase()}.`] : [];
  });
  return initials.length ? `${surname} ${initials.join("")}` : surname;
}

function hasInfectionRisk(item) {
  return (item.infections || []).some((value) => INFECTION_OPTIONS.includes(value));
}

function dangerMarkHtml(item) {
  if (!hasInfectionRisk(item)) return "";
  return `<span class="danger-bang" title="${escapeHtml(infectionLabel(item))}" aria-label="Потенційна небезпека для лікаря">!</span>`;
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
  const names = Array.isArray(item[field]) && item[field].length ? item[field] : (item[fallback] ? [item[fallback]] : []);
  return names.map(formatShortName);
}

function renderPersonChips(names) {
  if (!names.length) return '<span class="sub">Не призначено</span>';
  return `<div class="people-chips">${names.map((name) => `<span class="person-chip">${escapeHtml(formatShortName(name))}</span>`).join("")}</div>`;
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
    ? options.filter((name) => name.toLowerCase().includes(term) || formatShortName(name).toLowerCase().includes(term))
    : options;

  container.innerHTML = filtered.length
    ? filtered.map((name) => `
      <label class="picker-option">
        <input type="checkbox" value="${escapeHtml(name)}" data-picker="${containerId}" ${checked.includes(name) ? "checked" : ""} />
        <span>${escapeHtml(formatShortName(name))}</span>
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
  if ($("#archiveView")) $("#archiveView").hidden = view !== "archive";
  if ($("#staffView")) $("#staffView").hidden = view !== "staff";
  if ($("#logsView")) $("#logsView").hidden = view !== "logs";
  if ($("#scheduleTab")) $("#scheduleTab").classList.toggle("active", view === "schedule");
  if ($("#archiveTab")) $("#archiveTab").classList.toggle("active", view === "archive");
  if ($("#staffTab")) $("#staffTab").classList.toggle("active", view === "staff");
  if ($("#logsTab")) $("#logsTab").classList.toggle("active", view === "logs");
  if (view === "logs") loadLogs();
  if (view === "archive") renderArchive();
}

function findOperation(id) {
  return operations.find((item) => item.id === id)
    || archivedOperations.find((item) => item.id === id)
    || null;
}

function archiveDaysLeft(archivedAt) {
  if (!archivedAt) return ARCHIVE_RETENTION_DAYS;
  const start = new Date(archivedAt).getTime();
  if (Number.isNaN(start)) return ARCHIVE_RETENTION_DAYS;
  const end = start + ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((end - Date.now()) / (24 * 60 * 60 * 1000)));
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
      const initials = formatShortName(name).replace(/[^A-Za-zА-Яа-яІіЇїЄєҐґЁё]/g, "").slice(0, 2).toUpperCase() || "?";
      return `<div class="staff-person">
        <span class="staff-person-avatar">${escapeHtml(initials)}</span>
        <span class="staff-person-name">${escapeHtml(formatShortName(name))}</span>
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
  const name = formatShortName($(`#${prefix}NameInput`).value);
  const editIndex = $(`#${prefix}EditIndex`).value;
  if (!name) return;
  if (staff[type].some((item, index) => formatShortName(item).toLowerCase() === name.toLowerCase() && String(index) !== editIndex)) {
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
  $(`#${prefix}NameInput`).value = formatShortName(staff[type][index]);
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
  const searchTerm = ($("#search")?.value || "").trim().toLowerCase();
  const friday = addDaysYmd(weekMonday, 4);

  return [...operations]
    .filter((item) => {
      if (item.date && (item.date < weekMonday || item.date > friday)) return false;
      const text = [
        item.patient,
        item.diagnosis,
        item.procedure,
        ...(item.teamMembers || []),
        ...(item.anesthesiologists || []),
        infectionLabel(item),
        item.id,
      ].join(" ").toLowerCase();
      return !searchTerm || text.includes(searchTerm);
    })
    .sort((a, b) => {
      if (!a.date && b.date) return -1;
      if (a.date && !b.date) return 1;
      const byDate = String(a.date || "").localeCompare(String(b.date || ""));
      if (byDate) return byDate;
      return Number(a.queueNo || 0) - Number(b.queueNo || 0);
    });
}

function operationRowHtml(item) {
  const danger = infectionLabel(item);
  const dangerClass = hasInfectionRisk(item) ? "infection-alert" : "infection-ok";
  const queueLabel = item.date ? String(item.queueNo || 1) : (item.queueNo ? String(item.queueNo) : "—");
  return `
    <tr class="op-row is-expanded ${hasInfectionRisk(item) ? "has-danger" : ""}" data-id="${item.id}">
      <td class="col-queue" data-label="Черга"><span class="queue-badge">${escapeHtml(queueLabel)}</span></td>
      <td class="col-when" data-label="Дата"><span class="date">${formatDate(item.date)}</span></td>
      <td class="col-patient" data-label="Пацієнт">
        <span class="patient">${dangerMarkHtml(item)}${escapeHtml(formatShortName(item.patient))}</span>
        <span class="sub">${item.patientAge !== "" && item.patientAge != null ? `${escapeHtml(String(item.patientAge))} р.` : escapeHtml(item.id)}</span>
      </td>
      <td class="col-age" data-label="Вік">${item.patientAge !== "" && item.patientAge != null ? escapeHtml(String(item.patientAge)) : "—"}</td>
      <td class="col-infection" data-label="Небезпека"><span class="${dangerClass}">${escapeHtml(danger)}</span></td>
      <td class="col-diagnosis" data-label="Діагноз">${escapeHtml(item.diagnosis || "—")}</td>
      <td class="col-procedure" data-label="Втручання">${escapeHtml(item.procedure || "—")}</td>
      <td class="col-team" data-label="Операційна бригада">${renderPersonChips(namesForOperation(item, "teamMembers", "team"))}</td>
      <td class="col-anes" data-label="Анестезіологи">${renderPersonChips(namesForOperation(item, "anesthesiologists", "anesthesiologist"))}</td>
      <td class="col-files" data-label="Файли"><span class="attachments-count">${item.attachments?.length || 0}</span></td>
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
}

function mobileCardHtml(item) {
  const danger = infectionLabel(item);
  const dangerClass = hasInfectionRisk(item) ? "infection-alert" : "infection-ok";
  const diagnosis = item.diagnosis ? `<p class="week-diagnosis">${escapeHtml(item.diagnosis)}</p>` : "";
  const queueLabel = item.date ? String(item.queueNo || 1) : (item.queueNo ? String(item.queueNo) : "—");
  return `
    <article class="week-card ${hasInfectionRisk(item) ? "has-danger" : ""}" data-id="${item.id}">
      <div class="week-card-top">
        ${dangerMarkHtml(item)}
        <span class="queue-badge">${escapeHtml(queueLabel)}</span>
        <strong class="patient">${escapeHtml(formatShortName(item.patient))}</strong>
        ${item.patientAge !== "" && item.patientAge != null ? `<span class="sub">${escapeHtml(String(item.patientAge))} р.</span>` : ""}
      </div>
      <p class="week-procedure">${escapeHtml(item.procedure || "—")}</p>
      ${diagnosis}
      <p class="week-people"><span>Бригада:</span> ${escapeHtml(namesForOperation(item, "teamMembers", "team").join(", ") || "Не призначено")}</p>
      <p class="week-people"><span>Анестезіолог:</span> ${escapeHtml(namesForOperation(item, "anesthesiologists", "anesthesiologist").join(", ") || "Не призначено")}</p>
      <p class="${dangerClass} week-infection">${escapeHtml(danger)}</p>
      <div class="row-actions">
        <button class="icon-action" data-action="view" data-id="${item.id}" type="button" title="Медіа" aria-label="Медіа">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>
        </button>
        <button class="icon-action" data-action="edit" data-id="${item.id}" type="button" title="Змінити" aria-label="Змінити">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
        </button>
        <button class="icon-action danger-action" data-action="delete" data-id="${item.id}" type="button" title="Видалити" aria-label="Видалити">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6 7h12v2H6V7zm2 3h8l-1 10H9L8 10zm3-6h2l1 2H10l1-2z"/></svg>
        </button>
      </div>
    </article>`;
}

function renderDepartment(deptId, rows) {
  const body = $(`#${deptId}Body`);
  const empty = $(`#${deptId}Empty`);
  const days = $(`#${deptId}Days`);
  if (body) body.innerHTML = rows.map(operationRowHtml).join("");
  if (empty) empty.hidden = rows.length > 0;

  if (days) {
    const undated = rows.filter((item) => !item.date);
    const undatedBlock = undated.length
      ? `<section class="week-day week-undated">
          <h3>Без дати</h3>
          ${undated.map(mobileCardHtml).join("")}
        </section>`
      : "";
    days.innerHTML = undatedBlock + WEEKDAY_SHORT.map((label, index) => {
      const date = addDaysYmd(weekMonday, index);
      const dayRows = rows.filter((item) => item.date === date);
      return `
        <section class="week-day">
          <h3>${label} ${formatDayMonth(date)}</h3>
          ${dayRows.length ? dayRows.map(mobileCardHtml).join("") : `<p class="week-empty">Немає операцій</p>`}
        </section>`;
    }).join("");
  }
}

const expandedOperations = new Set();
let mediaObjectUrls = [];
let mediaFiles = [];
let mediaIndex = 0;
let mediaZoom = 1;
const MEDIA_ZOOM_MIN = 1;
const MEDIA_ZOOM_MAX = 4;
const MEDIA_ZOOM_STEP = 0.25;

function render() {
  if ($("#weekLabel")) $("#weekLabel").textContent = formatWeekRange(weekMonday);
  const rows = filteredOperations();
  renderDepartment("dept1", rows.filter((item) => item.department !== "dept2"));
  renderDepartment("dept2", rows.filter((item) => item.department === "dept2"));

  if ($("#weekCount")) $("#weekCount").textContent = String(rows.length);
  if ($("#dept1Count")) $("#dept1Count").textContent = String(rows.filter((item) => item.department !== "dept2").length);
  if ($("#dept2Count")) $("#dept2Count").textContent = String(rows.filter((item) => item.department === "dept2").length);
  if ($("#fileCount")) {
    $("#fileCount").textContent = rows.reduce((sum, item) => sum + (item.attachments?.length || 0), 0);
  }
  renderArchive();
}

function renderArchive() {
  const body = $("#archiveBody");
  const empty = $("#archiveEmptyState");
  const count = $("#archiveCount");
  if (!body) return;

  const rows = [...archivedOperations].sort((a, b) => {
    const byDate = String(b.date || "").localeCompare(String(a.date || ""));
    if (byDate) return byDate;
    return Number(a.queueNo || 0) - Number(b.queueNo || 0);
  });

  body.innerHTML = rows.map((item) => {
    const daysLeft = archiveDaysLeft(item.archivedAt);
    const deleteLabel = daysLeft <= 0 ? "сьогодні" : `через ${daysLeft} дн.`;
    const danger = infectionLabel(item);
    return `
    <tr class="op-row is-expanded" data-id="${item.id}">
      <td class="col-queue" data-label="Черга"><span class="queue-badge">${escapeHtml(String(item.queueNo || 1))}</span></td>
      <td class="col-when" data-label="Дата"><span class="date">${formatDate(item.date)}</span></td>
      <td class="col-patient" data-label="Пацієнт">
        <span class="patient">${dangerMarkHtml(item)}${escapeHtml(formatShortName(item.patient))}</span>
        <span class="sub">${escapeHtml(item.id)}</span>
      </td>
      <td data-label="Відділення">${escapeHtml(departmentLabel(item.department))}</td>
      <td class="col-infection" data-label="Небезпека">${escapeHtml(danger)}</td>
      <td class="col-procedure" data-label="Втручання">${escapeHtml(item.procedure || "—")}</td>
      <td class="col-files" data-label="Файли"><span class="attachments-count">${item.attachments?.length || 0}</span></td>
      <td class="col-purge" data-label="Автовидалення"><span class="archive-purge">${escapeHtml(deleteLabel)}</span></td>
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

  if (empty) empty.hidden = rows.length > 0;
  if (count) count.textContent = String(rows.length);
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
  if (!list || !title || !hint) return;

  const pending = pendingFormFiles;
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

  pending.forEach((file, index) => {
    const video = isVideoFile(file);
    rows.push(`<li class="attachment-row is-pending">
      <span class="selected-file-icon">${video ? "🎥" : "🖼️"}</span>
      <span class="selected-file-meta">
        <strong>${escapeHtml(file.name)}</strong>
        <small>${escapeHtml(formatFileSize(file.size))} · ${video ? "відео" : "зображення"} · нове</small>
      </span>
      <button type="button" class="attachment-remove" data-remove-pending="${index}" aria-label="Прибрати файл">✕</button>
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
let pendingFormFiles = [];
const MAX_PENDING_FILES = 12;

function fileKey(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function addPendingFiles(fileList) {
  const incoming = [...(fileList || [])];
  for (const file of incoming) {
    const type = String(file.type || "").toLowerCase();
    const name = String(file.name || "").toLowerCase();
    const allowed = type.startsWith("image/") || type.startsWith("video/")
      || /\.(mp4|mov|m4v|webm|avi|mkv|3gp|jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name);
    if (!allowed) {
      alert(`Файл «${file.name}» пропущено. Дозволені лише зображення та відео.`);
      continue;
    }
    if (pendingFormFiles.some((item) => fileKey(item) === fileKey(file))) continue;
    if (pendingFormFiles.length >= MAX_PENDING_FILES) {
      alert(`Можна додати максимум ${MAX_PENDING_FILES} нових файлів за раз.`);
      break;
    }
    pendingFormFiles.push(file);
  }
  const input = $("#attachments");
  if (input) input.value = "";
  renderAttachmentsPanel(currentFormAttachments);
}

function removePendingFile(index) {
  pendingFormFiles.splice(index, 1);
  renderAttachmentsPanel(currentFormAttachments);
}

function resetForm() {
  editingId = null;
  currentFormAttachments = [];
  pendingFormFiles = [];
  $("#operationForm").reset();
  $("#operationId").value = "";
  $("#dialogTitle").textContent = "Нова операція";
  if ($("#teamPickerSearch")) $("#teamPickerSearch").value = "";
  if ($("#anesthesiologistPickerSearch")) $("#anesthesiologistPickerSearch").value = "";
  if ($("#deleteOperation")) $("#deleteOperation").hidden = true;
  setSelectedInfections([]);
  if ($("#department")) $("#department").value = defaultDepartment;
  renderAttachmentsPanel([]);
  const progress = $("#uploadProgress");
  if (progress) progress.hidden = true;
  renderPicker("teamPicker", staff.team);
  renderPicker("anesthesiologistPicker", staff.anesthesiologists);
}

function openForm(id = null) {
  resetForm();

  if (id) {
    const item = findOperation(id);
    if (!item) return;
    editingId = id;
    $("#dialogTitle").textContent = "Редагування операції";
    if ($("#deleteOperation")) $("#deleteOperation").hidden = false;

    const fields = {
      department: item.department || "dept1",
      operationDate: item.date,
      queueNo: item.queueNo || "",
      patientName: formatShortName(item.patient),
      patientAge: item.patientAge,
      bloodGroup: item.bloodGroup,
      diagnosis: item.diagnosis,
      procedure: item.procedure,
      notes: item.notes,
    };

    Object.entries(fields).forEach(([field, value]) => {
      if ($(`#${field}`)) $(`#${field}`).value = value ?? "";
    });
    setSelectedInfections(item.infections || []);
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
    queueNo: $("#queueNo")?.value || "",
    department: $("#department")?.value || "dept1",
    patient: formatShortName($("#patientName").value),
    patientAge: $("#patientAge")?.value || "",
    bloodGroup: $("#bloodGroup").value,
    teamMembers: selectedPickerValues("teamPicker"),
    diagnosis: $("#diagnosis").value.trim(),
    procedure: $("#procedure").value.trim(),
    anesthesiologists: selectedPickerValues("anesthesiologistPicker"),
    infections: selectedInfections(),
    notes: $("#notes").value.trim(),
  };

  if (!data.patient || !data.procedure) {
    alert("Заповніть ПІБ пацієнта та вид втручання.");
    return;
  }

  const files = [...pendingFormFiles];
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
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (typeof onProgress === "function") {
        onProgress(event.loaded, event.lengthComputable ? event.total : 0);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 401) {
        clearAuth();
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
  const token = getToken();
  const response = await fetch(`${API_BASE}/attachments/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Не вдалося завантажити файл");
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

async function deleteOperation(id) {
  const item = findOperation(id);
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
  mediaFiles = [];
  mediaIndex = 0;
  mediaZoom = 1;
}

function closeMediaDialog() {
  const dialog = $("#mediaDialog");
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
    document.webkitExitFullscreen?.();
  }
  dialog?.querySelectorAll("video").forEach((video) => {
    video.pause();
    video.removeAttribute("src");
    video.load();
  });
  clearMediaObjectUrls();
  if ($("#mediaDialogBody")) $("#mediaDialogBody").innerHTML = "";
  if ($("#mediaCounter")) $("#mediaCounter").textContent = "0 / 0";
  if ($("#mediaFileName")) $("#mediaFileName").textContent = "";
  exitMediaFullscreen(true);
  if ($("#mediaImageTools")) $("#mediaImageTools").hidden = true;
  if ($("#mediaDownload")) $("#mediaDownload").hidden = true;
  updateMediaZoomUi();
  syncMediaFullscreenUi();
  dialog?.close();
}

function updateMediaNavState() {
  const many = mediaFiles.length > 1;
  if ($("#mediaPrev")) $("#mediaPrev").hidden = !many;
  if ($("#mediaNext")) $("#mediaNext").hidden = !many;
  if ($("#mediaDownload")) $("#mediaDownload").hidden = !mediaFiles.length;
}

function currentMediaIsVideo() {
  const current = mediaFiles[mediaIndex];
  if (!current) return false;
  return (current.metadata.type || "").startsWith("video/")
    || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(current.metadata.name || "");
}

function updateMediaZoomUi() {
  const isImage = Boolean($("#mediaDialogBody")?.querySelector("img.media-zoomable")) && !currentMediaIsVideo();
  const imageTools = $("#mediaImageTools");
  if (imageTools) imageTools.hidden = !isImage;

  const img = $("#mediaDialogBody")?.querySelector("img.media-zoomable");
  const fsImg = $("#mediaFsImage");
  if ($("#mediaZoomLabel")) $("#mediaZoomLabel").textContent = `${Math.round(mediaZoom * 100)}%`;
  if ($("#mediaZoomOut")) $("#mediaZoomOut").disabled = mediaZoom <= MEDIA_ZOOM_MIN;
  if ($("#mediaZoomIn")) $("#mediaZoomIn").disabled = mediaZoom >= MEDIA_ZOOM_MAX;
  if (img) {
    img.style.transform = `scale(${mediaZoom})`;
    img.classList.toggle("is-zoomed", mediaZoom > 1);
  }
  if (fsImg && !fsImg.hidden) {
    fsImg.style.transform = `scale(${mediaZoom})`;
  }
}

function setMediaZoom(nextZoom) {
  if (currentMediaIsVideo()) return;
  mediaZoom = Math.min(MEDIA_ZOOM_MAX, Math.max(MEDIA_ZOOM_MIN, Number(nextZoom.toFixed(2))));
  updateMediaZoomUi();
}

function downloadCurrentMedia() {
  const current = mediaFiles[mediaIndex];
  if (!current) return;
  const link = document.createElement("a");
  link.href = current.url;
  link.download = current.metadata.name || `media-${mediaIndex + 1}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function isPseudoFullscreenActive() {
  return Boolean($("#mediaFsOverlay")?.open);
}

function needsPseudoFullscreen() {
  const touchLike = window.matchMedia("(max-width: 900px), (hover: none)").matches;
  const noApi = !document.documentElement.requestFullscreen && !document.documentElement.webkitRequestFullscreen;
  return touchLike || noApi;
}

function enterPseudoFullscreen() {
  if (currentMediaIsVideo()) return;
  const current = mediaFiles[mediaIndex];
  const overlay = $("#mediaFsOverlay");
  const fsImg = $("#mediaFsImage");
  if (!current || !overlay || !fsImg) return;

  fsImg.src = current.url;
  fsImg.alt = current.metadata.name || "Зображення";
  fsImg.style.transform = `scale(${mediaZoom})`;
  document.body.classList.add("media-fs-open");
  if (!overlay.open) overlay.showModal();
  syncMediaFullscreenUi();
}

function exitMediaFullscreen(silent = false) {
  const overlay = $("#mediaFsOverlay");
  if (overlay?.open) overlay.close();
  const fsImg = $("#mediaFsImage");
  if (fsImg) {
    fsImg.removeAttribute("src");
    fsImg.style.transform = "";
  }
  document.body.classList.remove("media-fs-open");
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
    document.webkitExitFullscreen?.();
  }
  if (!silent) syncMediaFullscreenUi();
}

async function toggleMediaFullscreen() {
  if (currentMediaIsVideo()) return;

  if (isPseudoFullscreenActive()) {
    exitMediaFullscreen();
    return;
  }
  if (document.fullscreenElement) {
    exitMediaFullscreen();
    return;
  }

  if (needsPseudoFullscreen()) {
    enterPseudoFullscreen();
    return;
  }

  const target = $("#mediaDialogBody")?.querySelector(".media-viewport");
  try {
    if (target?.requestFullscreen) await target.requestFullscreen();
    else if (target?.webkitRequestFullscreen) await target.webkitRequestFullscreen();
    else enterPseudoFullscreen();
  } catch {
    enterPseudoFullscreen();
  }
  syncMediaFullscreenUi();
}

function syncMediaFullscreenUi() {
  const active = Boolean(document.fullscreenElement) || isPseudoFullscreenActive();
  const btn = $("#mediaFullscreen");
  if (btn) {
    btn.hidden = currentMediaIsVideo();
    btn.title = active ? "Вийти з повного екрана" : "На весь екран";
    btn.setAttribute("aria-label", btn.title);
    btn.textContent = active ? "✕" : "⛶";
  }
}

function renderMediaSlide() {
  const body = $("#mediaDialogBody");
  if (!body) return;

  if (!mediaFiles.length) {
    body.innerHTML = `<p class="empty-media">Немає прикріплених фото або відео.</p>`;
    if ($("#mediaCounter")) $("#mediaCounter").textContent = "0 / 0";
    if ($("#mediaFileName")) $("#mediaFileName").textContent = "";
    if ($("#mediaImageTools")) $("#mediaImageTools").hidden = true;
    exitMediaFullscreen(true);
    updateMediaNavState();
    updateMediaZoomUi();
    return;
  }

  const current = mediaFiles[mediaIndex];
  const isVideo = currentMediaIsVideo();
  mediaZoom = 1;
  exitMediaFullscreen(true);

  body.innerHTML = `<figure class="media-card ${isVideo ? "is-video" : "is-image"}">
    <div class="media-viewport">
      ${isVideo
        ? `<video controls preload="metadata" playsinline src="${current.url}"></video>`
        : `<img class="media-zoomable" src="${current.url}" alt="${escapeHtml(current.metadata.name)}">`}
    </div>
  </figure>`;

  if ($("#mediaCounter")) $("#mediaCounter").textContent = `${mediaIndex + 1} / ${mediaFiles.length}`;
  if ($("#mediaFileName")) $("#mediaFileName").textContent = current.metadata.name || "";
  if ($("#mediaImageTools")) $("#mediaImageTools").hidden = isVideo;
  updateMediaNavState();
  updateMediaZoomUi();
  syncMediaFullscreenUi();

  const img = body.querySelector("img.media-zoomable");
  if (img) {
    img.addEventListener("dblclick", () => {
      setMediaZoom(mediaZoom > 1 ? 1 : 2);
    });
    img.addEventListener("wheel", (event) => {
      event.preventDefault();
      setMediaZoom(mediaZoom + (event.deltaY < 0 ? MEDIA_ZOOM_STEP : -MEDIA_ZOOM_STEP));
    }, { passive: false });
  }
}

function showMediaAt(index) {
  if (!mediaFiles.length) return;
  exitMediaFullscreen(true);
  const body = $("#mediaDialogBody");
  body?.querySelectorAll("video").forEach((video) => {
    video.pause();
  });
  mediaIndex = ((index % mediaFiles.length) + mediaFiles.length) % mediaFiles.length;
  renderMediaSlide();
}

async function viewOperation(id) {
  const item = findOperation(id);
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
  if ($("#mediaPrev")) $("#mediaPrev").hidden = true;
  if ($("#mediaNext")) $("#mediaNext").hidden = true;
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

  mediaFiles = files;
  mediaIndex = 0;
  if ($("#mediaDialogMeta")) {
    $("#mediaDialogMeta").textContent = `${item.id || ""} · ${files.length} файл(ів)`;
  }
  renderMediaSlide();
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
  const [ops, archived, staffData, session] = await Promise.all([
    api("/operations"),
    api("/operations?archived=1"),
    api("/staff"),
    api("/session"),
  ]);
  operations = ops;
  archivedOperations = archived;
  staff = staffData;
  applyLogsVisibility(session?.canViewLogs);
  renderStaffLists();
  render();
}

on("#themeToggle", "change", (event) => setTheme(event.target.checked ? "dark" : "light"));
on("#scheduleTab", "click", () => showView("schedule"));
on("#archiveTab", "click", () => showView("archive"));
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
  clearAuth();
  window.location.replace("login.html");
});
on("#addOperation", "click", () => openForm());
on("#prevWeek", "click", () => {
  weekMonday = addDaysYmd(weekMonday, -7);
  render();
});
on("#nextWeek", "click", () => {
  weekMonday = addDaysYmd(weekMonday, 7);
  render();
});
on("#thisWeek", "click", () => {
  weekMonday = currentWorkWeekMonday();
  render();
});
on("#prevDept", "click", () => cycleDepartment(-1));
on("#nextDept", "click", () => cycleDepartment(1));
document.addEventListener("click", (event) => {
  const pill = event.target.closest(".dept-pill");
  if (pill?.dataset.dept) setActiveDepartment(pill.dataset.dept);
});
document.addEventListener("click", (event) => {
  const addBtn = event.target.closest("[data-add-dept]");
  if (!addBtn) return;
  defaultDepartment = addBtn.dataset.addDept === "dept2" ? "dept2" : "dept1";
  openForm();
});
on("#closeOperation", "click", () => $("#operationDialog")?.close());
on("#cancelOperation", "click", () => $("#operationDialog")?.close());
on("#attachments", "change", (event) => addPendingFiles(event.target.files));
on("#attachmentsPanelList", "click", (event) => {
  const button = event.target.closest("[data-remove-pending]");
  if (!button) return;
  removePendingFile(Number(button.dataset.removePending));
});
on("#operationForm", "submit", saveOperation);
on("#search", "input", render);
on("#patientName", "blur", (event) => {
  event.target.value = formatShortName(event.target.value);
});
on("#teamNameInput", "blur", (event) => {
  event.target.value = formatShortName(event.target.value);
});
on("#anesthesiologistNameInput", "blur", (event) => {
  event.target.value = formatShortName(event.target.value);
});
on("#teamPickerSearch", "input", () => paintPicker("teamPicker"));
on("#anesthesiologistPickerSearch", "input", () => paintPicker("anesthesiologistPicker"));
on("#deleteOperation", "click", () => {
  if (editingId) deleteOperation(editingId);
});
on("#closeMediaDialog", "click", closeMediaDialog);
on("#mediaPrev", "click", () => showMediaAt(mediaIndex - 1));
on("#mediaNext", "click", () => showMediaAt(mediaIndex + 1));
on("#mediaDownload", "click", downloadCurrentMedia);
on("#mediaZoomIn", "click", () => setMediaZoom(mediaZoom + MEDIA_ZOOM_STEP));
on("#mediaZoomOut", "click", () => setMediaZoom(mediaZoom - MEDIA_ZOOM_STEP));
on("#mediaZoomReset", "click", () => setMediaZoom(1));
on("#mediaFullscreen", "click", toggleMediaFullscreen);
on("#mediaFsClose", "click", () => exitMediaFullscreen());
on("#mediaFsOverlay", "click", (event) => {
  if (event.target === $("#mediaFsOverlay") || event.target?.classList?.contains("media-fs-stage")) {
    exitMediaFullscreen();
  }
});
on("#mediaFsOverlay", "cancel", (event) => {
  event.preventDefault();
  exitMediaFullscreen();
});
on("#mediaFsOverlay", "close", () => {
  document.body.classList.remove("media-fs-open");
  syncMediaFullscreenUi();
});
document.addEventListener("fullscreenchange", syncMediaFullscreenUi);
document.addEventListener("webkitfullscreenchange", syncMediaFullscreenUi);
on("#mediaDialog", "close", closeMediaDialog);
on("#mediaDialog", "click", (event) => {
  if (event.target === $("#mediaDialog")) closeMediaDialog();
});
document.addEventListener("keydown", (event) => {
  const dialog = $("#mediaDialog");
  if (!dialog?.open) return;
  if (event.key === "ArrowLeft") showMediaAt(mediaIndex - 1);
  if (event.key === "ArrowRight") showMediaAt(mediaIndex + 1);
  if (event.key === "+" || event.key === "=") setMediaZoom(mediaZoom + MEDIA_ZOOM_STEP);
  if (event.key === "-" || event.key === "_") setMediaZoom(mediaZoom - MEDIA_ZOOM_STEP);
  if (event.key === "0") setMediaZoom(1);
  if ((event.key === "f" || event.key === "F") && !currentMediaIsVideo()) toggleMediaFullscreen();
  if (event.key === "Escape") {
    if (isPseudoFullscreenActive() || document.fullscreenElement) {
      exitMediaFullscreen();
      return;
    }
    closeMediaDialog();
  }
});
function handleOperationRowClick(event) {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.action === "toggle") toggleOperation(button.dataset.id);
  if (button.dataset.action === "edit") openForm(button.dataset.id);
  if (button.dataset.action === "view") viewOperation(button.dataset.id);
  if (button.dataset.action === "delete") deleteOperation(button.dataset.id);
}
on("#dept1Body", "click", handleOperationRowClick);
on("#dept2Body", "click", handleOperationRowClick);
on("#dept1Days", "click", handleOperationRowClick);
on("#dept2Days", "click", handleOperationRowClick);
on("#archiveBody", "click", handleOperationRowClick);
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

(async function boot() {
  try {
    await api("/session");
    document.documentElement.classList.add("app-ready");
    setActiveDepartment(defaultDepartment);
    await refresh();
  } catch (error) {
    console.error(error);
    if (String(error.message || "") !== "Unauthorized") {
      document.documentElement.classList.add("app-ready");
      alert("Не вдалося завантажити дані з сервера. Перевірте API / MySQL.");
    }
  }
})();
