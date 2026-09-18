if (!window.SurgeryAPI) {
  alert("Не завантажено api.js. Зробіть hard-refresh (Ctrl+F5) або перевірте деплой.");
  throw new Error("SurgeryAPI missing");
}

const { api, API_BASE, getToken, isAuthenticated, clearAuth } = window.SurgeryAPI;

if (!getToken()) {
  window.location.replace("login.html");
}

(function preventBrowserPageZoom() {
  const mediaZoomSelector = ".media-viewport, .media-fs-overlay, .media-fs-stage, img.media-zoomable, #mediaFsImage";
  let lastTouchEnd = 0;
  document.addEventListener("gesturestart", (event) => {
    if (!event.target?.closest?.(mediaZoomSelector)) event.preventDefault();
  }, { passive: false });
  document.addEventListener("gesturechange", (event) => {
    if (!event.target?.closest?.(mediaZoomSelector)) event.preventDefault();
  }, { passive: false });
  document.addEventListener("touchend", (event) => {
    const now = Date.now();
    if (now - lastTouchEnd <= 320 && event.touches.length === 0) {
      if (!event.target?.closest?.(mediaZoomSelector)) event.preventDefault();
    }
    lastTouchEnd = now;
  }, { passive: false });
})();

const $ = (selector) => document.querySelector(selector);
const on = (selector, event, handler) => {
  const node = $(selector);
  if (node) node.addEventListener(event, handler);
};
let operations = [];
let staff = { team: [], anesthesiologists: [] };
let editingId = null;
const DEPARTMENTS = [
  { id: "dept1", label: "Хірургічне відділення №1" },
  { id: "dept2", label: "Хірургічне відділення №2" },
];
const INFECTION_OPTIONS = ["HCV", "HbsAg", "HIV", "RW"];
const PATIENT_FLAG_OPTIONS = [
  { id: "zsu", label: "ЗСУ", title: "ЗСУ" },
  { id: "vip", label: "VIP", title: "VIP персона" },
];
const OPERATION_STATUSES = [
  { value: "ОК", label: "ОК", css: "status-ok" },
  { value: "Потребує дообстеження", label: "Потребує дообстеження", css: "status-check" },
  { value: "Відміна", label: "Відміна", css: "status-cancel" },
];
const MAX_SURGEONS = 2;
const MAX_ANESTHESIOLOGISTS = 1;
const PICKER_LIMITS = { teamPicker: MAX_SURGEONS, anesthesiologistPicker: MAX_ANESTHESIOLOGISTS };
const WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
let defaultDepartment = localStorage.getItem("surgery-dept") === "dept2" ? "dept2" : "dept1";
/** Selection order for surgeons: index 0 = primary (1), index 1 = assistant (2). */
let teamSelectionOrder = [];

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
  return mondayOf(todayYmd());
}

function formatDayMonth(ymd) {
  if (!ymd) return "—";
  const [year, month, day] = ymd.split("-");
  return `${day}/${month}/${String(year).slice(-2)}`;
}

function weekdayIndex(ymd) {
  const [year, month, day] = String(ymd).split("-").map(Number);
  const sunday0 = new Date(year, month - 1, day).getDay();
  return sunday0 === 0 ? 6 : sunday0 - 1;
}

function formatDayHeading(ymd) {
  if (!ymd) return "—";
  return `${WEEKDAY_SHORT[weekdayIndex(ymd)]} ${formatDayMonth(ymd)}`;
}

function formatWeekRange(monday) {
  return `${formatDayMonth(monday)}–${formatDayMonth(addDaysYmd(monday, 6))}`;
}

function queueLabel(item) {
  return item.queueNo ? String(item.queueNo) : "?";
}

function queueBadgeHtml(item) {
  const label = queueLabel(item);
  return `<span class="queue-badge${label === "?" ? " is-empty" : ""}">${escapeHtml(label)}</span>`;
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

function selectedPatientFlags() {
  return [...document.querySelectorAll("#patientFlagPicks input:checked")]
    .map((input) => input.value)
    .filter((value) => PATIENT_FLAG_OPTIONS.some((item) => item.id === value));
}

function setSelectedPatientFlags(values = []) {
  document.querySelectorAll("#patientFlagPicks input").forEach((input) => {
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
  updateViewTabCounts();
}

let weekMonday = currentWorkWeekMonday();
let selectedDay = todayYmd();
let scheduleMode = "day";
let currentView = "schedule";

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
  return formatDayMonth(date);
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

function parseBloodGroup(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const rh = /Rh\s*-/i.test(raw) ? "-" : (/Rh\s*\+/i.test(raw) ? "+" : "");
  let abo = "";
  if (/^AB/i.test(raw) || /\(IV\)/i.test(raw)) abo = "AB";
  else if (/^A/i.test(raw) || /\(II\)/i.test(raw)) abo = "A";
  else if (/^B/i.test(raw) || /\(III\)/i.test(raw)) abo = "B";
  else if (/^0|^O/i.test(raw) || /\(I\)/i.test(raw)) abo = "0";
  if (!abo) return { short: raw, full: raw, rh };
  return { short: `${abo}${rh}`, full: raw, rh, abo };
}

function bloodBadgeHtml(item) {
  const parsed = parseBloodGroup(item.bloodGroup);
  if (!parsed) return `<span class="blood-badge is-empty" title="Група крові не вказана">—</span>`;
  const label = parsed.full || item.bloodGroup || "";
  return `<span class="blood-badge" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function normalizeOperationStatus(value) {
  const raw = String(value || "").trim();
  return OPERATION_STATUSES.some((item) => item.value === raw) ? raw : "";
}

function statusMeta(value) {
  const normalized = normalizeOperationStatus(value);
  const match = OPERATION_STATUSES.find((item) => item.value === normalized);
  if (match) return match;
  return { value: "", label: "Очікує огляду анестезіолога", css: "status-pending" };
}

function statusBadgeHtml(item) {
  const meta = statusMeta(item.status);
  return `<span class="status-badge ${meta.css}" title="Статус перевірки">${escapeHtml(meta.label)}</span>`;
}

const OPERATION_SIDE_VALUES = ["справа", "зліва"];
const OPERATION_SIDE_SUFFIX_RE = /\s*[—\-–]?\s*(справа|зліва)\s*$/iu;
const PROCEDURE_OPTIONS = [
  "VATS біопсія плеври",
  "VATS санація плевральної порожнини",
  "VATS біопсія легені",
  "VATS біопсія легені і в/г лімфовузлів",
  "VATS біопсія в/г лімфовузлів",
  "VATS біопсія новоутворення",
  "VATS резекція бул з плевродезом",
  "VATS резекція бул з парієтальною плевректомією",
  "VATS плевректомія з декортикацією",
  "VATS сублобарна резекція",
  "VATS клиновидна резекція",
  "VATS сегментектомія",
  "VATS полісегментарна резекція",
  "VATS лобектомія",
  "VATS білобектомія",
  "VATS пневмонектомія",
  "VATS видалення новоутворення середостіння",
];

function normalizeOperationSide(value) {
  const raw = String(value || "").trim().toLowerCase();
  return OPERATION_SIDE_VALUES.includes(raw) ? raw : "";
}

function stripOperationSideSuffix(procedure) {
  return String(procedure || "").replace(OPERATION_SIDE_SUFFIX_RE, "").trim();
}

function detectOperationSide(procedure) {
  const match = String(procedure || "").trim().match(OPERATION_SIDE_SUFFIX_RE);
  return match ? normalizeOperationSide(match[1]) : "";
}

function formatProcedureWithSide(procedure, side) {
  const base = stripOperationSideSuffix(procedure);
  const normalized = normalizeOperationSide(side);
  if (!base) return "";
  return normalized ? `${base} ${normalized}` : base;
}

function syncProcedureSideFromSelect() {
  const procedureInput = $("#procedure");
  const sideSelect = $("#operationSide");
  if (!procedureInput || !sideSelect) return;
  const side = normalizeOperationSide(sideSelect.value);
  const base = stripOperationSideSuffix(procedureInput.value);
  // Only append side when one is selected; otherwise keep/edit the free-text base.
  procedureInput.value = side ? formatProcedureWithSide(base, side) : base;
  paintProcedureSuggestions();
}

function setProcedureFromSuggestion(label) {
  const procedureInput = $("#procedure");
  if (!procedureInput) return;
  const side = normalizeOperationSide($("#operationSide")?.value);
  procedureInput.value = formatProcedureWithSide(label, side);
  procedureInput.focus();
  // Place cursor before the side suffix so the base text is easy to edit.
  const base = stripOperationSideSuffix(procedureInput.value);
  const cursor = base.length;
  procedureInput.setSelectionRange(cursor, cursor);
  hideProcedureSuggestions();
}

function procedureSuggestionQuery() {
  return stripOperationSideSuffix($("#procedure")?.value || "").toLowerCase();
}

function filteredProcedureOptions() {
  const query = procedureSuggestionQuery();
  if (!query) return PROCEDURE_OPTIONS;
  return PROCEDURE_OPTIONS.filter((item) => item.toLowerCase().includes(query));
}

function paintProcedureSuggestions() {
  const list = $("#procedureSuggestList");
  if (!list || list.hidden) return;
  const options = filteredProcedureOptions();
  list.innerHTML = options.length
    ? options.map((item) => `<button type="button" class="procedure-suggest-item" role="option" data-procedure="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join("")
    : `<p class="procedure-suggest-empty">Немає збігів — можна ввести назву вручну.</p>`;
}

function showProcedureSuggestions() {
  const list = $("#procedureSuggestList");
  const toggle = $("#procedureSuggestToggle");
  if (!list) return;
  list.hidden = false;
  if (toggle) toggle.setAttribute("aria-expanded", "true");
  paintProcedureSuggestions();
}

function hideProcedureSuggestions() {
  const list = $("#procedureSuggestList");
  const toggle = $("#procedureSuggestToggle");
  if (list) list.hidden = true;
  if (toggle) toggle.setAttribute("aria-expanded", "false");
}

function toggleProcedureSuggestions() {
  const list = $("#procedureSuggestList");
  if (!list) return;
  if (list.hidden) showProcedureSuggestions();
  else hideProcedureSuggestions();
}

function patientFlagsHtml(item) {
  const flags = item.patientFlags || [];
  return PATIENT_FLAG_OPTIONS
    .filter((option) => flags.includes(option.id))
    .map((option) => `<span class="flag-chip flag-${option.id}" title="${escapeHtml(option.title)}">${escapeHtml(option.label)}</span>`)
    .join("");
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}

function namesForOperation(item, field, fallback) {
  const names = Array.isArray(item[field]) && item[field].length ? item[field] : (item[fallback] ? [item[fallback]] : []);
  return names.map(formatShortName);
}

function rankedTeamLabel(names) {
  if (!names.length) return escapeHtml("Не призначено");
  return names
    .map((name, index) => `${index + 1}. ${escapeHtml(formatShortName(name))}`)
    .join(", ");
}

function renderPersonChips(names, { ranked = false } = {}) {
  if (!names.length) return '<span class="sub">Не призначено</span>';
  return `<div class="people-chips">${names.map((name, index) => {
    const rank = ranked ? `<span class="person-rank" title="${index === 0 ? "Основний хірург" : "Асистент"}">${index + 1}</span>` : "";
    return `<span class="person-chip">${rank}${escapeHtml(formatShortName(name))}</span>`;
  }).join("")}</div>`;
}

function setTeamSelectionOrder(names = []) {
  const seen = new Set();
  teamSelectionOrder = [];
  for (const name of names) {
    const value = String(name || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    teamSelectionOrder.push(value);
    if (teamSelectionOrder.length >= MAX_SURGEONS) break;
  }
}

function selectedTeamMembers() {
  return teamSelectionOrder.slice(0, MAX_SURGEONS);
}

function renderPicker(containerId, options, selected = []) {
  const container = $(`#${containerId}`);
  if (!container) return;
  container.dataset.options = JSON.stringify(options || []);
  if (containerId === "teamPicker") {
    setTeamSelectionOrder(selected);
  }
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
  const isTeam = containerId === "teamPicker";
  const checked = isTeam
    ? (selected != null ? [...selected] : selectedTeamMembers())
    : (selected ?? selectedPickerValues(containerId));
  if (isTeam && selected != null) {
    setTeamSelectionOrder(checked);
  }
  const order = isTeam ? selectedTeamMembers() : checked;
  const searchInput = $(`#${containerId}Search`);
  const term = (searchInput?.value || "").trim().toLowerCase();
  const filtered = term
    ? options.filter((name) => name.toLowerCase().includes(term) || formatShortName(name).toLowerCase().includes(term))
    : options;

  container.innerHTML = filtered.length
    ? filtered.map((name) => {
      const isChecked = order.includes(name);
      const rank = isTeam && isChecked ? order.indexOf(name) + 1 : 0;
      const rankHtml = isTeam
        ? `<span class="picker-rank${rank ? " is-on" : ""}" aria-hidden="true">${rank || ""}</span>`
        : "";
      return `
      <label class="picker-option${isTeam ? " picker-option-ranked" : ""}${isChecked ? " is-checked" : ""}">
        ${rankHtml}
        <input type="checkbox" value="${escapeHtml(name)}" data-picker="${containerId}" ${isChecked ? "checked" : ""} />
        <span>${escapeHtml(formatShortName(name))}</span>
      </label>`;
    }).join("")
    : `<div class="picker-empty">Нікого не знайдено</div>`;
}

function selectedPickerValues(containerId) {
  if (containerId === "teamPicker") return selectedTeamMembers();
  return [...document.querySelectorAll(`#${containerId} input:checked`)].map((input) => input.value);
}

let canViewLogs = false;
let currentUser = null;
let siteUsers = [];
let editingUserId = null;

function applyScheduleMode() {
  const view = $("#scheduleView");
  if (view) {
    view.classList.toggle("mode-day", scheduleMode === "day");
    view.classList.toggle("mode-week", scheduleMode === "week");
    view.classList.toggle("mode-plan", scheduleMode === "plan");
  }
  const showDayBar = scheduleMode === "day";
  const showWeekBar = scheduleMode === "week" || scheduleMode === "plan";
  const dayBar = $("#dayBar");
  const weekBar = $("#weekBar");
  if (dayBar) {
    dayBar.hidden = !showDayBar;
    dayBar.style.display = showDayBar ? "" : "none";
  }
  if (weekBar) {
    weekBar.hidden = !showWeekBar;
    weekBar.style.display = showWeekBar ? "" : "none";
  }
  const weekEyebrow = $("#weekBar .eyebrow");
  if (weekEyebrow) weekEyebrow.textContent = scheduleMode === "plan" ? "План операцій" : "Розклад на тиждень";
}

function showView(view) {
  if ((view === "logs" || view === "staff" || view === "users" || view === "stats") && !canViewLogs) {
    view = "day";
  }
  if (view === "day" || view === "week" || view === "plan") {
    scheduleMode = view;
    view = "schedule";
  }
  currentView = view;
  if ($("#scheduleView")) $("#scheduleView").hidden = view !== "schedule";
  if ($("#staffView")) $("#staffView").hidden = view !== "staff";
  if ($("#usersView")) $("#usersView").hidden = view !== "users";
  if ($("#statsView")) $("#statsView").hidden = view !== "stats";
  if ($("#logsView")) $("#logsView").hidden = view !== "logs";
  if ($("#dayTab")) $("#dayTab").classList.toggle("active", view === "schedule" && scheduleMode === "day");
  if ($("#weekTab")) $("#weekTab").classList.toggle("active", view === "schedule" && scheduleMode === "week");
  if ($("#planTab")) $("#planTab").classList.toggle("active", view === "schedule" && scheduleMode === "plan");
  if ($("#staffTab")) $("#staffTab").classList.toggle("active", view === "staff");
  if ($("#usersTab")) $("#usersTab").classList.toggle("active", view === "users");
  if ($("#statsTab")) $("#statsTab").classList.toggle("active", view === "stats");
  if ($("#logsTab")) $("#logsTab").classList.toggle("active", view === "logs");
  applyScheduleMode();
  if (view === "schedule") render();
  if (view === "logs") loadLogs();
  if (view === "users") loadUsers();
  if (view === "stats") loadStats();
}

function applyAdminVisibility(allowed) {
  canViewLogs = Boolean(allowed);
  ["logsTab", "staffTab", "usersTab", "statsTab"].forEach((id) => {
    const tab = $(`#${id}`);
    if (!tab) return;
    tab.hidden = !canViewLogs;
    // Belt-and-suspenders: some CSS display rules can override [hidden].
    tab.style.display = canViewLogs ? "" : "none";
  });
  document.querySelector(".view-tabs")?.classList.toggle("is-admin", canViewLogs);
  if (!canViewLogs && (currentView === "logs" || currentView === "staff" || currentView === "users" || currentView === "stats")) {
    showView("day");
  }
}

function applySessionUser(session) {
  currentUser = session?.user || null;
  const chip = $("#sessionUser");
  if (!chip) return;
  if (!currentUser) {
    chip.hidden = true;
    chip.textContent = "";
    return;
  }
  const roleLabel = currentUser.role === "admin" ? "Адмін" : "Лікар";
  chip.hidden = false;
  chip.textContent = `${currentUser.name || currentUser.email} · ${roleLabel}`;
  chip.title = currentUser.email || "";
}

function findOperation(id) {
  return operations.find((item) => item.id === id) || null;
}

function applyLogsVisibility(allowed) {
  applyAdminVisibility(allowed);
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
  const sunday = addDaysYmd(weekMonday, 6);

  return [...operations]
    .filter((item) => {
      if (scheduleMode === "day") {
        return item.date === selectedDay;
      }
      // План = only operations that still have no date assigned.
      if (scheduleMode === "plan") {
        return !item.date;
      }
      // Тиждень = dated operations in the selected week (undated belong in План).
      if (!item.date) return false;
      return item.date >= weekMonday && item.date <= sunday;
    })
    .sort((a, b) => {
      if (!a.date && b.date) return -1;
      if (a.date && !b.date) return 1;
      const byDate = String(a.date || "").localeCompare(String(b.date || ""));
      if (byDate) return byDate;
      const aq = a.queueNo == null ? 9999 : Number(a.queueNo);
      const bq = b.queueNo == null ? 9999 : Number(b.queueNo);
      return aq - bq;
    });
}

function operationRowHtml(item) {
  const danger = infectionLabel(item);
  const dangerClass = hasInfectionRisk(item) ? "infection-alert" : "infection-ok";
  const notesText = String(item.notes || "").trim();
  return `
    <tr class="op-row is-expanded ${hasInfectionRisk(item) ? "has-danger" : ""}" data-id="${item.id}">
      <td class="col-when" data-label="Дата"><span class="date">${formatDate(item.date)}</span></td>
      <td class="col-patient" data-label="Пацієнт">
        <span class="patient">${dangerMarkHtml(item)}${escapeHtml(formatShortName(item.patient))}</span>
        <span class="patient-age">${item.patientAge !== "" && item.patientAge != null ? `${escapeHtml(String(item.patientAge))} р.` : escapeHtml(item.id)}</span>
      </td>
      <td class="col-age" data-label="Вік">${item.patientAge !== "" && item.patientAge != null ? escapeHtml(String(item.patientAge)) : "—"}</td>
      <td class="col-infection" data-label="Небезпека"><span class="${dangerClass}">${escapeHtml(danger)}</span></td>
      <td class="col-diagnosis" data-label="Діагноз">${escapeHtml(item.diagnosis || "—")}</td>
      <td class="col-procedure" data-label="Втручання">${escapeHtml(item.procedure || "—")}</td>
      <td class="col-team" data-label="Операційна бригада">${renderPersonChips(namesForOperation(item, "teamMembers", "team"), { ranked: true })}</td>
      <td class="col-anes" data-label="Анестезіологи">${renderPersonChips(namesForOperation(item, "anesthesiologists", "anesthesiologist"))}</td>
      <td class="col-blood" data-label="Група крові">${bloodBadgeHtml(item)}${patientFlagsHtml(item)}</td>
      <td class="col-status" data-label="Статус">${statusBadgeHtml(item)}</td>
      <td class="col-notes" data-label="Примітки">${notesText ? escapeHtml(notesText) : "—"}</td>
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
  const dateLabel = item.date ? formatDayHeading(item.date) : "Без дати";
  const diagnosisText = item.diagnosis || "—";
  const notesText = String(item.notes || "").trim();
  return `
    <article class="week-card ${hasInfectionRisk(item) ? "has-danger" : ""}" data-id="${item.id}">
      <p class="week-card-date">${escapeHtml(dateLabel)}</p>
      <div class="week-card-top">
        ${dangerMarkHtml(item)}
        <strong class="patient">${escapeHtml(formatShortName(item.patient))}</strong>
        ${item.patientAge !== "" && item.patientAge != null ? `<span class="patient-age">${escapeHtml(String(item.patientAge))} р.</span>` : ""}
        ${bloodBadgeHtml(item)}
        ${patientFlagsHtml(item)}
      </div>
      <div class="week-clinical">
        <p class="week-procedure"><span class="week-field-label">Втручання</span><span class="week-field-value">${escapeHtml(item.procedure || "—")}</span></p>
        <p class="week-diagnosis"><span class="week-field-label">Діагноз</span><span class="week-field-value">${escapeHtml(diagnosisText)}</span></p>
      </div>
      <p class="week-people"><span>Бригада:</span> ${rankedTeamLabel(namesForOperation(item, "teamMembers", "team"))}</p>
      <p class="week-people"><span>Анестезіолог:</span> ${escapeHtml(namesForOperation(item, "anesthesiologists", "anesthesiologist").join(", ") || "Не призначено")}</p>
      <p class="week-status">${statusBadgeHtml(item)}</p>
      ${notesText ? `<p class="week-notes"><span class="week-field-label">Примітки</span><span class="week-field-value">${escapeHtml(notesText)}</span></p>` : ""}
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
  if (!days) return;

  if (scheduleMode === "day") {
    const date = selectedDay;
    const dayRows = rows.filter((item) => item.date === date);
    days.innerHTML = dayRows.length
      ? `<section class="week-day">
          ${dayRows.map(mobileCardHtml).join("")}
        </section>`
      : `<p class="week-empty">Немає операцій на ${escapeHtml(formatDayHeading(date))}.</p>`;
    return;
  }

  if (scheduleMode === "plan") {
    const undated = rows.filter((item) => !item.date);
    days.innerHTML = undated.length
      ? `<section class="week-day week-undated">
          ${undated.map(mobileCardHtml).join("")}
        </section>`
      : `<p class="week-empty">Немає операцій без дати.</p>`;
    return;
  }

  const dayBlocks = WEEKDAY_SHORT.map((_label, index) => {
    const date = addDaysYmd(weekMonday, index);
    const dayRows = rows.filter((item) => item.date === date);
    if (!dayRows.length) return "";
    return `
      <section class="week-day">
        ${dayRows.map(mobileCardHtml).join("")}
      </section>`;
  }).join("");
  days.innerHTML = dayBlocks
    || `<p class="week-empty">Немає операцій цього тижня.</p>`;
}

const expandedOperations = new Set();
let mediaObjectUrls = [];
let mediaFiles = [];
let mediaIndex = 0;
let mediaZoom = 1;
let mediaPanX = 0;
let mediaPanY = 0;
let mediaPinch = null;
let mediaPanDrag = null;
let mediaZoomRaf = 0;
let mediaOperationId = null;
const MEDIA_ZOOM_MIN = 1;
const MEDIA_ZOOM_MAX = 4;
const MEDIA_ZOOM_STEP = 0.25;

function render() {
  const dayBar = $("#dayBar");
  const anchorTop = dayBar ? dayBar.getBoundingClientRect().top : null;
  if ($("#weekLabel")) $("#weekLabel").textContent = formatWeekRange(weekMonday);
  if ($("#dayLabel")) $("#dayLabel").textContent = formatDayHeading(selectedDay);
  applyScheduleMode();
  const rows = filteredOperations();
  renderDepartment("dept1", rows.filter((item) => item.department !== "dept2"));
  renderDepartment("dept2", rows.filter((item) => item.department === "dept2"));
  updateViewTabCounts();
  stabilizeScheduleScroll(anchorTop);
}

function stabilizeScheduleScroll(anchorTop) {
  if (document.documentElement.classList.contains("dialog-open")) return;
  const dayBar = $("#dayBar");
  if (dayBar && anchorTop != null && scheduleMode === "day") {
    const after = dayBar.getBoundingClientRect().top;
    const delta = after - anchorTop;
    if (Math.abs(delta) > 1) window.scrollBy(0, delta);
  }
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  if (window.scrollY > maxScroll) window.scrollTo(0, maxScroll);
}

let lockedScrollY = 0;
let dialogScrollLockCount = 0;

function lockBackgroundScroll() {
  if (dialogScrollLockCount === 0) {
    lockedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    document.documentElement.classList.add("dialog-open");
    document.body.style.top = `-${lockedScrollY}px`;
  }
  dialogScrollLockCount += 1;
}

function unlockBackgroundScroll() {
  if (dialogScrollLockCount === 0) return;
  dialogScrollLockCount -= 1;
  if (dialogScrollLockCount > 0) return;
  document.documentElement.classList.remove("dialog-open");
  document.body.style.top = "";
  window.scrollTo(0, lockedScrollY);
}

function openModalDialog(dialog) {
  if (!dialog) return;
  const alreadyOpen = dialog.open;
  if (!alreadyOpen) lockBackgroundScroll();
  if (!dialog.open) dialog.showModal();
}

function closeModalDialog(dialog) {
  if (!dialog?.open) return;
  dialog.close();
}

function wireModalScrollLock(dialog) {
  if (!dialog || dialog.dataset.scrollLockWired === "1") return;
  dialog.dataset.scrollLockWired = "1";
  dialog.addEventListener("close", () => {
    unlockBackgroundScroll();
  });
}

function scrollDialogFieldIntoView(target) {
  const dialog = target?.closest?.("dialog");
  if (!dialog?.open) return;
  const body = dialog.querySelector(".dialog-body") || dialog;
  const run = () => {
    try {
      target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    } catch {
      target.scrollIntoView(true);
    }
    // Extra nudge for Chrome Android when the visual viewport shrinks under the keyboard.
    if (window.visualViewport && body) {
      const fieldBottom = target.getBoundingClientRect().bottom;
      const visibleBottom = window.visualViewport.offsetTop + window.visualViewport.height - 12;
      if (fieldBottom > visibleBottom) {
        body.scrollTop += fieldBottom - visibleBottom;
      }
    }
  };
  requestAnimationFrame(() => setTimeout(run, 50));
  setTimeout(run, 280);
}

function shiftSelectedDay(delta) {
  goToSelectedDay(addDaysYmd(selectedDay, delta));
}

function goToSelectedDay(ymd) {
  selectedDay = ymd;
  render();
  // Avoid iOS focus/zoom quirks after the list height collapses.
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
}

function countOperationsForMode(mode) {
  const sunday = addDaysYmd(weekMonday, 6);
  return operations.filter((item) => {
    const inDept =
      defaultDepartment === "dept2"
        ? item.department === "dept2"
        : item.department !== "dept2";
    if (!inDept) return false;
    if (mode === "day") return item.date === selectedDay;
    if (mode === "plan") return !item.date;
    if (!item.date) return false;
    return item.date >= weekMonday && item.date <= sunday;
  }).length;
}

function updateViewTabCounts() {
  const dayCount = countOperationsForMode("day");
  const weekCount = countOperationsForMode("week");
  const planCount = countOperationsForMode("plan");
  if ($("#dayTabCount")) $("#dayTabCount").textContent = String(dayCount);
  if ($("#weekTabCount")) $("#weekTabCount").textContent = String(weekCount);
  if ($("#planTabCount")) $("#planTabCount").textContent = String(planCount);
  document.querySelectorAll("[data-add-dept]").forEach((button) => {
    button.textContent = "+ Додати операцію";
  });
}

function formatFileSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function isVideoFile(file) {
  const type = file.type || file.mime || "";
  const name = decodeFileName(file.name || "");
  return type.startsWith("video/") || /\.(mp4|mov|m4v|webm|avi|mkv|3gp|mpeg|mpg)$/i.test(name);
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
        <strong>${escapeHtml(decodeFileName(file.name))}</strong>
        <small>${video ? "відео" : "зображення"} · уже збережено</small>
      </span>
      <button type="button" class="attachment-remove" data-remove-saved="${escapeHtml(file.id)}" aria-label="Видалити файл">✕</button>
    </li>`);
  });

  pending.forEach((file, index) => {
    const video = isVideoFile(file);
    rows.push(`<li class="attachment-row is-pending">
      <span class="selected-file-icon">${video ? "🎥" : "🖼️"}</span>
      <span class="selected-file-meta">
        <strong>${escapeHtml(decodeFileName(file.name))}</strong>
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
    hint.textContent = `${existing.length} файл(ів) уже збережено. ✕ видаляє файл з сервера.`;
  } else {
    hint.textContent = "Поки файлів немає";
  }
}

let currentFormAttachments = [];
let pendingFormFiles = [];
let editingUpdatedAt = null;
const MAX_PENDING_FILES = 12;
const IMAGE_MAX_EDGE = 2048;
const IMAGE_JPEG_QUALITY = 0.82;
const IMAGE_SKIP_IF_UNDER_BYTES = 450 * 1024;

function fileKey(file) {
  return `${file.name}::${file.size}::${file.lastModified}`;
}

function isImageFile(file) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name);
}

function shouldOptimizeImage(file) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  // Keep animated GIF / HEIC as-is (HEIC may not decode in all browsers).
  if (type === "image/gif" || /\.gif$/i.test(name)) return false;
  if (type.includes("heic") || type.includes("heif") || /\.(heic|heif)$/i.test(name)) return false;
  return isImageFile(file);
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function optimizeImageFile(file) {
  if (!shouldOptimizeImage(file)) return file;
  try {
    const img = await loadImageElement(file);
    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (!srcW || !srcH) return file;

    const longest = Math.max(srcW, srcH);
    const needsResize = longest > IMAGE_MAX_EDGE;
    const needsRecompress = file.size > IMAGE_SKIP_IF_UNDER_BYTES;
    if (!needsResize && !needsRecompress) return file;

    const scale = needsResize ? IMAGE_MAX_EDGE / longest : 1;
    const width = Math.max(1, Math.round(srcW * scale));
    const height = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return file;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const preferWebp = typeof canvas.toBlob === "function";
    let blob = preferWebp
      ? await canvasToBlob(canvas, "image/webp", IMAGE_JPEG_QUALITY)
      : null;
    let outType = "image/webp";
    if (!blob || blob.size === 0) {
      blob = await canvasToBlob(canvas, "image/jpeg", IMAGE_JPEG_QUALITY);
      outType = "image/jpeg";
    }
    if (!blob || blob.size === 0) return file;
    // Keep original if compression somehow made it larger.
    if (blob.size >= file.size && !needsResize) return file;

    const base = String(file.name || "image").replace(/\.[^.]+$/, "") || "image";
    const ext = outType === "image/webp" ? ".webp" : ".jpg";
    return new File([blob], `${base}${ext}`, {
      type: outType,
      lastModified: Date.now(),
    });
  } catch {
    return file;
  }
}

async function addPendingFiles(fileList) {
  const incoming = [...(fileList || [])];
  const input = $("#attachments");
  if (input) input.value = "";
  if (!incoming.length) return;

  const hint = $("#attachmentsPanelHint");
  if (hint) hint.textContent = "Оптимізація зображень…";

  for (const raw of incoming) {
    const type = String(raw.type || "").toLowerCase();
    const name = String(raw.name || "").toLowerCase();
    const allowed = type.startsWith("image/") || type.startsWith("video/")
      || /\.(mp4|mov|m4v|webm|avi|mkv|3gp|jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name);
    if (!allowed) {
      alert(`Файл «${raw.name}» пропущено. Дозволені лише зображення та відео.`);
      continue;
    }
    if (pendingFormFiles.length >= MAX_PENDING_FILES) {
      alert(`Можна додати максимум ${MAX_PENDING_FILES} нових файлів за раз.`);
      break;
    }

    const file = await optimizeImageFile(raw);
    if (pendingFormFiles.some((item) => fileKey(item) === fileKey(file) || fileKey(item) === fileKey(raw))) {
      continue;
    }
    pendingFormFiles.push(file);
  }

  renderAttachmentsPanel(currentFormAttachments);
}

function removePendingFile(index) {
  pendingFormFiles.splice(index, 1);
  renderAttachmentsPanel(currentFormAttachments);
}

function dropAttachmentFromCaches(attachmentId) {
  const drop = (item) => {
    if (!item?.attachments) return;
    item.attachments = item.attachments.filter((file) => file.id !== attachmentId);
  };
  operations.forEach(drop);
  currentFormAttachments = currentFormAttachments.filter((file) => file.id !== attachmentId);
}

async function removeSavedAttachment(attachmentId) {
  const file = currentFormAttachments.find((item) => item.id === attachmentId);
  const name = file?.name || "файл";
  if (!confirm(`Видалити файл «${name}»? Це не можна скасувати.`)) return;
  try {
    await api(`/attachments/${attachmentId}`, { method: "DELETE" });
    dropAttachmentFromCaches(attachmentId);
    renderAttachmentsPanel(currentFormAttachments);
    render();
  } catch (error) {
    alert(error.message || "Не вдалося видалити файл.");
  }
}

function resetForm() {
  editingId = null;
  editingUpdatedAt = null;
  currentFormAttachments = [];
  pendingFormFiles = [];
  $("#operationForm").reset();
  $("#operationId").value = "";
  $("#dialogTitle").textContent = "Нова операція";
  if ($("#teamPickerSearch")) $("#teamPickerSearch").value = "";
  if ($("#anesthesiologistPickerSearch")) $("#anesthesiologistPickerSearch").value = "";
  if ($("#deleteOperation")) $("#deleteOperation").hidden = true;
  setSelectedInfections([]);
  setSelectedPatientFlags([]);
  if ($("#department")) $("#department").value = defaultDepartment;
  if ($("#operationStatus")) $("#operationStatus").value = "";
  if ($("#operationSide")) $("#operationSide").value = "";
  hideProcedureSuggestions();
  renderAttachmentsPanel([]);
  const progress = $("#uploadProgress");
  if (progress) progress.hidden = true;
  setTeamSelectionOrder([]);
  renderPicker("teamPicker", staff.team, []);
  renderPicker("anesthesiologistPicker", staff.anesthesiologists);
}

function openForm(id = null) {
  resetForm();

  if (id) {
    const item = findOperation(id);
    if (!item) return;
    editingId = id;
    editingUpdatedAt = item.updatedAt || null;
    $("#dialogTitle").textContent = "Редагування операції";
    if ($("#deleteOperation")) $("#deleteOperation").hidden = false;

    const fields = {
      department: item.department || "dept1",
      operationDate: item.date,
      patientName: formatShortName(item.patient),
      patientAge: item.patientAge,
      bloodGroup: item.bloodGroup,
      diagnosis: item.diagnosis,
      procedure: item.procedure,
      notes: item.notes,
      operationStatus: normalizeOperationStatus(item.status),
      operationSide: detectOperationSide(item.procedure),
    };

    Object.entries(fields).forEach(([field, value]) => {
      if ($(`#${field}`)) $(`#${field}`).value = value ?? "";
    });
    setSelectedInfections(item.infections || []);
    setSelectedPatientFlags(item.patientFlags || []);
    const teamSelected = Array.isArray(item.teamMembers) && item.teamMembers.length
      ? item.teamMembers
      : (item.team ? [item.team] : []);
    const anesSelected = Array.isArray(item.anesthesiologists) && item.anesthesiologists.length
      ? item.anesthesiologists
      : (item.anesthesiologist ? [item.anesthesiologist] : []);
    renderPicker("teamPicker", staff.team, teamSelected);
    renderPicker("anesthesiologistPicker", staff.anesthesiologists, anesSelected);
    currentFormAttachments = item.attachments || [];
    renderAttachmentsPanel(currentFormAttachments);
  } else {
    renderAttachmentsPanel([]);
  }

  openModalDialog($("#operationDialog"));
}

async function saveOperation(event) {
  event.preventDefault();

  const data = {
    date: $("#operationDate").value,
    queueNo: "",
    department: $("#department")?.value || "dept1",
    patient: formatShortName($("#patientName").value),
    patientAge: $("#patientAge")?.value || "",
    bloodGroup: $("#bloodGroup").value,
    teamMembers: selectedTeamMembers(),
    diagnosis: $("#diagnosis").value.trim(),
    procedure: formatProcedureWithSide($("#procedure").value.trim(), $("#operationSide")?.value),
    anesthesiologists: selectedPickerValues("anesthesiologistPicker").slice(0, MAX_ANESTHESIOLOGISTS),
    infections: selectedInfections(),
    patientFlags: selectedPatientFlags(),
    status: normalizeOperationStatus($("#operationStatus")?.value),
    notes: $("#notes").value.trim(),
  };
  if (editingId && editingUpdatedAt) {
    data.expectedUpdatedAt = editingUpdatedAt;
  }

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
    if (!files.length) {
      // No new files: plain JSON save — avoid upload progress UX for existing attachments.
      await api(path, { method, json: data });
    } else {
      const formData = new FormData();
      Object.entries(data).forEach(([key, value]) => {
        if (Array.isArray(value)) formData.append(key, JSON.stringify(value));
        else formData.append(key, value ?? "");
      });
      files.forEach((file) => formData.append("files", file));

      setProgress(0, `Завантаження ${files.length} файл(ів)…`);
      await uploadForm(path, method, formData, (loaded, total) => {
        if (!total) {
          setProgress(50, "Завантаження файлів…");
          return;
        }
        const percent = (loaded / total) * 100;
        setProgress(percent, percent >= 100 ? "Обробка на сервері…" : `Завантаження файлів… ${Math.round(percent)}%`);
      });
      setProgress(100, "Готово");
    }

    closeModalDialog($("#operationDialog"));
    await refresh();
  } catch (error) {
    const message = String(error?.message || "");
    if (/конфлікт|змінив інший|оновить|409/i.test(message)) {
      alert(message);
      await refresh();
      if (editingId) openForm(editingId);
    } else {
      alert(message || "Не вдалося зберегти операцію.");
    }
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

function attachmentUrl(id) {
  const token = getToken();
  return `${API_BASE}/attachments/${id}?access_token=${encodeURIComponent(token || "")}`;
}

function decodeFileName(name) {
  const raw = String(name || "");
  if (!raw) return "";
  if (/[А-Яа-яІіЇїЄєҐґЁё]/.test(raw)) return raw;
  try {
    const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0) & 0xff);
    const decoded = new TextDecoder("utf-8").decode(bytes);
    if (!decoded.includes("\uFFFD") && /[А-Яа-яІіЇїЄєҐґЁё]/.test(decoded)) return decoded;
  } catch {
    // keep original
  }
  return raw;
}

async function deleteOperation(id) {
  const item = findOperation(id);
  if (!item) return;
  if (!confirm(`Видалити операцію «${item.patient}» (${item.id})?`)) return;
  try {
    await api(`/operations/${id}`, { method: "DELETE" });
    if (editingId === id) closeModalDialog($("#operationDialog"));
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
  resetMediaZoomState();
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
  if ($("#mediaDelete")) $("#mediaDelete").hidden = true;
  updateMediaZoomUi();
  syncMediaFullscreenUi();
  mediaOperationId = null;
  closeModalDialog(dialog);
}

function updateMediaNavState() {
  const many = mediaFiles.length > 1;
  if ($("#mediaPrev")) $("#mediaPrev").hidden = !many;
  if ($("#mediaNext")) $("#mediaNext").hidden = !many;
  if ($("#mediaDownload")) $("#mediaDownload").hidden = !mediaFiles.length;
  if ($("#mediaDelete")) $("#mediaDelete").hidden = !mediaFiles.length;
}

function currentMediaIsVideo() {
  const current = mediaFiles[mediaIndex];
  if (!current) return false;
  return isVideoFile(current.metadata);
}

function mediaTransformValue() {
  return `translate3d(${mediaPanX}px, ${mediaPanY}px, 0) scale(${mediaZoom})`;
}

function resetMediaPan() {
  mediaPanX = 0;
  mediaPanY = 0;
  mediaPinch = null;
  mediaPanDrag = null;
}

function resetMediaZoomState() {
  mediaZoom = 1;
  resetMediaPan();
}

function touchPairDistance(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function touchPairCenter(a, b) {
  return {
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
  };
}

function applyMediaTransform() {
  const transform = mediaTransformValue();
  const moving = Boolean(mediaPinch || mediaPanDrag);
  const img = $("#mediaDialogBody")?.querySelector("img.media-zoomable");
  const fsImg = $("#mediaFsImage");
  if (img) {
    img.style.transform = transform;
    img.classList.toggle("is-zoomed", mediaZoom > 1);
    img.classList.toggle("is-pinching", moving);
  }
  if (fsImg?.getAttribute("src")) {
    fsImg.style.transform = transform;
    fsImg.classList.toggle("is-zoomed", mediaZoom > 1);
    fsImg.classList.toggle("is-pinching", moving);
  }
}

function scheduleMediaTransform() {
  if (mediaZoomRaf) return;
  mediaZoomRaf = requestAnimationFrame(() => {
    mediaZoomRaf = 0;
    applyMediaTransform();
  });
}

function updateMediaZoomUi() {
  const isImage = Boolean($("#mediaDialogBody")?.querySelector("img.media-zoomable")) && !currentMediaIsVideo();
  const imageTools = $("#mediaImageTools");
  if (imageTools) imageTools.hidden = !isImage;

  if ($("#mediaZoomLabel")) $("#mediaZoomLabel").textContent = `${Math.round(mediaZoom * 100)}%`;
  if ($("#mediaZoomOut")) $("#mediaZoomOut").disabled = mediaZoom <= MEDIA_ZOOM_MIN;
  if ($("#mediaZoomIn")) $("#mediaZoomIn").disabled = mediaZoom >= MEDIA_ZOOM_MAX;
  applyMediaTransform();
}

function setMediaZoom(nextZoom) {
  if (currentMediaIsVideo()) return;
  mediaZoom = Math.min(MEDIA_ZOOM_MAX, Math.max(MEDIA_ZOOM_MIN, Number(nextZoom.toFixed(2))));
  if (mediaZoom <= 1) resetMediaPan();
  updateMediaZoomUi();
}

function isMediaFullscreenView() {
  return isPseudoFullscreenActive() || Boolean(document.fullscreenElement);
}

function bindMediaPinchTarget(target) {
  if (!target || target.dataset.pinchBound === "1") return;
  target.dataset.pinchBound = "1";

  target.addEventListener("touchstart", (event) => {
    if (currentMediaIsVideo()) return;
    if (event.touches.length === 2) {
      event.preventDefault();
      mediaPanDrag = null;
      const [a, b] = event.touches;
      const center = touchPairCenter(a, b);
      mediaPinch = {
        startDist: Math.max(touchPairDistance(a, b), 1),
        startZoom: mediaZoom,
        startPanX: mediaPanX,
        startPanY: mediaPanY,
        startCenterX: center.x,
        startCenterY: center.y,
      };
      applyMediaTransform();
      return;
    }
    if (event.touches.length === 1 && mediaZoom > 1) {
      const touch = event.touches[0];
      mediaPanDrag = {
        startX: touch.clientX,
        startY: touch.clientY,
        startPanX: mediaPanX,
        startPanY: mediaPanY,
      };
      applyMediaTransform();
    }
  }, { passive: false });

  target.addEventListener("touchmove", (event) => {
    if (mediaPinch && event.touches.length >= 2) {
      event.preventDefault();
      const [a, b] = event.touches;
      const dist = Math.max(touchPairDistance(a, b), 1);
      const center = touchPairCenter(a, b);
      const nextZoom = mediaPinch.startZoom * (dist / mediaPinch.startDist);
      mediaZoom = Math.min(MEDIA_ZOOM_MAX, Math.max(MEDIA_ZOOM_MIN, nextZoom));
      mediaPanX = mediaPinch.startPanX + (center.x - mediaPinch.startCenterX);
      mediaPanY = mediaPinch.startPanY + (center.y - mediaPinch.startCenterY);
      if (mediaZoom <= 1) {
        mediaPanX = 0;
        mediaPanY = 0;
      }
      scheduleMediaTransform();
      return;
    }
    if (mediaPanDrag && event.touches.length === 1 && mediaZoom > 1) {
      event.preventDefault();
      const touch = event.touches[0];
      mediaPanX = mediaPanDrag.startPanX + (touch.clientX - mediaPanDrag.startX);
      mediaPanY = mediaPanDrag.startPanY + (touch.clientY - mediaPanDrag.startY);
      scheduleMediaTransform();
    }
  }, { passive: false });

  const endPinch = () => {
    const wasInteracting = Boolean(mediaPinch || mediaPanDrag);
    mediaPinch = null;
    mediaPanDrag = null;
    if (mediaZoom <= 1) resetMediaPan();
    else mediaZoom = Math.min(MEDIA_ZOOM_MAX, Math.max(MEDIA_ZOOM_MIN, Number(mediaZoom.toFixed(2))));
    if (wasInteracting) updateMediaZoomUi();
  };
  target.addEventListener("touchend", endPinch);
  target.addEventListener("touchcancel", endPinch);
}

function downloadCurrentMedia() {
  const current = mediaFiles[mediaIndex];
  if (!current) return;
  const link = document.createElement("a");
  link.href = current.url;
  link.download = decodeFileName(current.metadata.name) || `media-${mediaIndex + 1}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function deleteCurrentMedia() {
  const current = mediaFiles[mediaIndex];
  if (!current?.metadata?.id) return;
  const name = current.metadata.name || "файл";
  if (!confirm(`Видалити файл «${name}»? Це не можна скасувати.`)) return;
  const button = $("#mediaDelete");
  if (button) button.disabled = true;
  try {
    await api(`/attachments/${current.metadata.id}`, { method: "DELETE" });
    URL.revokeObjectURL(current.url);
    mediaObjectUrls = mediaObjectUrls.filter((url) => url !== current.url);
    mediaFiles.splice(mediaIndex, 1);
    dropAttachmentFromCaches(current.metadata.id);
    renderAttachmentsPanel(currentFormAttachments);
    render();
    if (!mediaFiles.length) {
      closeMediaDialog();
      return;
    }
    showMediaAt(Math.min(mediaIndex, mediaFiles.length - 1));
    const item = findOperation(mediaOperationId);
    if ($("#mediaDialogMeta")) {
      $("#mediaDialogMeta").textContent = `${item?.id || mediaOperationId || ""} · ${mediaFiles.length} файл(ів)`;
    }
  } catch (error) {
    alert(error.message || "Не вдалося видалити файл.");
  } finally {
    if (button) button.disabled = false;
  }
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
  const stage = overlay?.querySelector(".media-fs-stage");
  if (!current || !overlay || !fsImg) return;

  stage?.classList.add("is-loading");
  fsImg.src = current.url;
  fsImg.alt = decodeFileName(current.metadata.name) || "Зображення";
  fsImg.style.transform = mediaTransformValue();
  const markLoaded = () => stage?.classList.remove("is-loading");
  if (fsImg.complete && fsImg.naturalWidth > 0) markLoaded();
  else {
    fsImg.addEventListener("load", markLoaded, { once: true });
    fsImg.addEventListener("error", markLoaded, { once: true });
  }
  bindMediaPinchTarget(overlay);
  bindMediaPinchTarget(stage);
  bindMediaPinchTarget(fsImg);
  document.body.classList.add("media-fs-open");
  openModalDialog(overlay);
  syncMediaFullscreenUi();
}

function exitMediaFullscreen(silent = false) {
  const overlay = $("#mediaFsOverlay");
  closeModalDialog(overlay);
  const fsImg = $("#mediaFsImage");
  if (fsImg) {
    fsImg.removeAttribute("src");
    fsImg.style.transform = "";
    fsImg.classList.remove("is-zoomed", "is-pinching");
  }
  resetMediaZoomState();
  document.body.classList.remove("media-fs-open");
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
    document.webkitExitFullscreen?.();
  }
  if (!silent) syncMediaFullscreenUi();
  updateMediaZoomUi();
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
  const fileName = decodeFileName(current.metadata.name);
  resetMediaZoomState();
  exitMediaFullscreen(true);

  body.innerHTML = `<figure class="media-card ${isVideo ? "is-video" : "is-image"}">
    <div class="media-viewport is-loading">
      <div class="media-loading" aria-live="polite">
        <span class="media-loading-spinner" aria-hidden="true"></span>
        <span>Завантаження…</span>
      </div>
      ${isVideo
        ? `<video controls playsinline webkit-playsinline preload="metadata" src="${current.url}"></video>`
        : `<img class="media-zoomable" src="${current.url}" alt="${escapeHtml(fileName)}">`}
    </div>
  </figure>`;

  if ($("#mediaCounter")) $("#mediaCounter").textContent = `${mediaIndex + 1} / ${mediaFiles.length}`;
  if ($("#mediaFileName")) $("#mediaFileName").textContent = fileName || "";
  if ($("#mediaImageTools")) $("#mediaImageTools").hidden = isVideo;
  updateMediaNavState();
  updateMediaZoomUi();
  syncMediaFullscreenUi();

  const viewport = body.querySelector(".media-viewport");
  const markLoaded = () => viewport?.classList.remove("is-loading");

  const video = body.querySelector("video");
  if (video) {
    if (video.readyState >= 2) markLoaded();
    else {
      video.addEventListener("loadeddata", markLoaded, { once: true });
      video.addEventListener("error", markLoaded, { once: true });
    }
    video.addEventListener("error", () => {
      if (body.querySelector(".empty-media")) return;
      const note = document.createElement("p");
      note.className = "empty-media";
      note.textContent = "Не вдалося відтворити відео в браузері. Завантажте файл кнопкою нижче.";
      body.appendChild(note);
    });
  }

  const img = body.querySelector("img.media-zoomable");
  if (img) {
    if (img.complete && img.naturalWidth > 0) markLoaded();
    else {
      img.addEventListener("load", markLoaded, { once: true });
      img.addEventListener("error", markLoaded, { once: true });
    }
    bindMediaPinchTarget(viewport);
    bindMediaPinchTarget(img);
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
  mediaOperationId = id;
  if ($("#mediaDialogTitle")) $("#mediaDialogTitle").textContent = item.patient || "Медіа";
  if ($("#mediaDialogMeta")) {
    $("#mediaDialogMeta").textContent = `${item.id || ""} · ${(item.attachments || []).length} файл(ів) · завантаження…`;
  }
  body.innerHTML = `<div class="media-viewport is-loading" style="min-height:240px;width:100%;border-radius:10px">
    <div class="media-loading" aria-live="polite">
      <span class="media-loading-spinner" aria-hidden="true"></span>
      <span>Завантаження медіа…</span>
    </div>
  </div>`;
  if ($("#mediaPrev")) $("#mediaPrev").hidden = true;
  if ($("#mediaNext")) $("#mediaNext").hidden = true;
  if ($("#mediaDelete")) $("#mediaDelete").hidden = true;
  openModalDialog(dialog);

  const files = (item.attachments || []).map((metadata) => ({
    metadata: { ...metadata, name: decodeFileName(metadata.name) },
    url: attachmentUrl(metadata.id),
  }));

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

function logPlaceHtml(item) {
  const ip = item.ip || "—";
  const geo = item.geo ? `<span class="sub">${escapeHtml(item.geo)}</span>` : "";
  return `${escapeHtml(ip)}${geo}`;
}

function logActorHtml(item) {
  const name = String(item.actorName || "").trim();
  const email = String(item.actorEmail || "").trim();
  if (!name && !email) {
    return `<span class="sub">Пароль відділення / невідомо</span>`;
  }
  const title = name || email;
  const sub = name && email && name !== email ? `<span class="sub">${escapeHtml(email)}</span>` : "";
  return `<strong>${escapeHtml(title)}</strong>${sub}`;
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
        <td data-label="Користувач">${logActorHtml(item)}</td>
        <td data-label="Дія">${escapeHtml(item.action)}</td>
        <td data-label="Опис">${escapeHtml(item.summary)}</td>
        <td data-label="Поля">${escapeHtml((item.changedFields || []).join(", ") || "—")}</td>
        <td data-label="IP / місце">${logPlaceHtml(item)}</td>
      </tr>
    `).join("") || `<tr><td colspan="6">Змін ще немає.</td></tr>`;

    $("#accessLogsBody").innerHTML = access.map((item) => `
      <tr>
        <td data-label="Час">${escapeHtml(formatDateTime(item.createdAt))}</td>
        <td data-label="Подія">${escapeHtml(item.event)}</td>
        <td data-label="IP / місце">${logPlaceHtml(item)}</td>
        <td data-label="Браузер">${escapeHtml(item.userAgent || "—")}</td>
      </tr>
    `).join("") || `<tr><td colspan="4">Записів ще немає.</td></tr>`;
  } catch (error) {
    alert(error.message || "Не вдалося завантажити журнали.");
  }
}

async function loadStats() {
  const from = $("#statsFrom")?.value || "";
  const to = $("#statsTo")?.value || "";
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const query = params.toString() ? `?${params.toString()}` : "";
  try {
    const data = await api(`/stats${query}`);
    const rows = Array.isArray(data?.byPrimarySurgeon) ? data.byPrimarySurgeon : [];
    const total = Number(data?.totalOperations) || 0;
    const withPrimary = Number(data?.withPrimarySurgeon) || 0;
    const without = Number(data?.withoutPrimarySurgeon) || 0;
    if ($("#statsTotal")) $("#statsTotal").textContent = String(total);
    if ($("#statsWithPrimary")) $("#statsWithPrimary").textContent = String(withPrimary);
    if ($("#statsWithoutPrimary")) $("#statsWithoutPrimary").textContent = String(without);
    const body = $("#statsBody");
    if (!body) return;
    body.innerHTML = rows.length
      ? rows.map((row, index) => `
        <tr>
          <td data-label="#">${index + 1}</td>
          <td data-label="Хірург">${escapeHtml(formatShortName(row.name))}</td>
          <td data-label="Операцій (як основний)"><strong>${Number(row.count) || 0}</strong></td>
        </tr>`).join("")
      : `<tr><td colspan="3">Немає операцій за обраний період.</td></tr>`;
    if ($("#statsEmpty")) $("#statsEmpty").hidden = rows.length > 0 || total > 0;
  } catch (error) {
    alert(error.message || "Не вдалося завантажити статистику.");
  }
}

function userRoleLabel(role) {
  return role === "admin" ? "Адмін" : "Лікар";
}

function userStatusLabel(status) {
  return status === "disabled" ? "Заблокований" : "Активний";
}

function userAuthFlags(user) {
  const parts = [];
  if (user.hasPassword) parts.push("пароль");
  if (user.googleLinked) parts.push("Google");
  return parts.length ? parts.join(" · ") : "—";
}

function renderUsers() {
  const body = $("#usersBody");
  const empty = $("#usersEmpty");
  if (!body) return;
  if (empty) empty.hidden = siteUsers.length > 0;
  body.innerHTML = siteUsers.map((user) => {
    const statusClass = user.status === "disabled" ? "is-disabled" : "is-active";
    const banLabel = user.status === "disabled" ? "Розблокувати" : "Заблокувати";
    const isSelf = currentUser?.id && currentUser.id === user.id;
    return `
      <tr data-user-id="${escapeHtml(user.id)}">
        <td data-label="Імʼя"><strong>${escapeHtml(user.name || "—")}</strong>${isSelf ? " <small>(ви)</small>" : ""}</td>
        <td data-label="Email">${escapeHtml(user.email || "—")}</td>
        <td data-label="Роль"><span class="user-role">${escapeHtml(userRoleLabel(user.role))}</span></td>
        <td data-label="Статус"><span class="user-status ${statusClass}">${escapeHtml(userStatusLabel(user.status))}</span></td>
        <td data-label="Вхід"><span class="user-auth-flags">${escapeHtml(userAuthFlags(user))}</span></td>
        <td data-label="Створено">${escapeHtml(formatDateTime(user.createdAt))}</td>
        <td data-label="Дії">
          <div class="users-actions">
            <button type="button" data-user-action="edit" data-user-id="${escapeHtml(user.id)}">Редагувати</button>
            <button type="button" data-user-action="toggle-ban" data-user-id="${escapeHtml(user.id)}">${banLabel}</button>
            <button type="button" class="danger" data-user-action="delete" data-user-id="${escapeHtml(user.id)}" ${isSelf ? "disabled" : ""}>Видалити</button>
          </div>
        </td>
      </tr>`;
  }).join("") || `<tr><td colspan="7">Користувачів ще немає.</td></tr>`;
}

async function loadUsers() {
  if (!canViewLogs) return;
  try {
    siteUsers = await api("/users");
    renderUsers();
  } catch (error) {
    alert(error.message || "Не вдалося завантажити користувачів.");
  }
}

function fillUserMeta(user) {
  const meta = $("#userMeta");
  if (!meta) return;
  meta.innerHTML = `
    <dt>ID</dt><dd>${escapeHtml(user.id)}</dd>
    <dt>Вхід</dt><dd>${escapeHtml(userAuthFlags(user))}</dd>
    <dt>Створено</dt><dd>${escapeHtml(formatDateTime(user.createdAt))}</dd>
    <dt>Оновлено</dt><dd>${escapeHtml(formatDateTime(user.updatedAt))}</dd>
  `;
}

function openUserEditor(user) {
  editingUserId = user.id;
  if ($("#userEditId")) $("#userEditId").value = user.id;
  if ($("#userDialogTitle")) $("#userDialogTitle").textContent = user.name || user.email || "Користувач";
  if ($("#userName")) $("#userName").value = user.name || "";
  if ($("#userEmail")) $("#userEmail").value = user.email || "";
  if ($("#userRole")) $("#userRole").value = user.role === "admin" ? "admin" : "doctor";
  if ($("#userStatus")) $("#userStatus").value = user.status === "disabled" ? "disabled" : "active";
  if ($("#userPassword")) $("#userPassword").value = "";
  fillUserMeta(user);
  openModalDialog($("#userDialog"));
}

function closeUserEditor() {
  editingUserId = null;
  closeModalDialog($("#userDialog"));
}

async function saveUserEdit(event) {
  event.preventDefault();
  const id = $("#userEditId")?.value || editingUserId;
  if (!id) return;
  const payload = {
    name: $("#userName")?.value.trim() || "",
    email: $("#userEmail")?.value.trim() || "",
    role: $("#userRole")?.value || "doctor",
    status: $("#userStatus")?.value || "active",
  };
  const password = $("#userPassword")?.value || "";
  if (password) payload.password = password;
  const saveButton = $("#saveUser");
  if (saveButton) saveButton.disabled = true;
  try {
    await api(`/users/${id}`, { method: "PUT", json: payload });
    closeUserEditor();
    await loadUsers();
  } catch (error) {
    alert(error.message || "Не вдалося зберегти користувача.");
  } finally {
    if (saveButton) saveButton.disabled = false;
  }
}

async function toggleBanUser(userId) {
  const user = siteUsers.find((item) => item.id === userId);
  if (!user) return;
  if (currentUser?.id && currentUser.id === userId && user.status !== "disabled") {
    alert("Не можна заблокувати власний акаунт.");
    return;
  }
  const nextStatus = user.status === "disabled" ? "active" : "disabled";
  const confirmText = nextStatus === "disabled"
    ? `Заблокувати ${user.email}? Користувач втратить доступ одразу.`
    : `Розблокувати ${user.email}?`;
  if (!window.confirm(confirmText)) return;
  try {
    await api(`/users/${userId}`, { method: "PUT", json: { status: nextStatus } });
    await loadUsers();
  } catch (error) {
    alert(error.message || "Не вдалося змінити статус.");
  }
}

async function deleteSiteUser(userId) {
  const user = siteUsers.find((item) => item.id === userId);
  if (!user) return;
  if (currentUser?.id && currentUser.id === userId) {
    alert("Не можна видалити власний акаунт.");
    return;
  }
  if (!window.confirm(`Видалити користувача ${user.email}? Цю дію не можна скасувати.`)) return;
  try {
    await api(`/users/${userId}`, { method: "DELETE" });
    await loadUsers();
  } catch (error) {
    alert(error.message || "Не вдалося видалити користувача.");
  }
}

function setTheme(theme, { animate = true } = {}) {
  const apply = () => {
    document.documentElement.classList.toggle("theme-dark", theme === "dark");
    localStorage.setItem("surgery-theme", theme);
    if ($("#themeToggle")) $("#themeToggle").checked = theme === "dark";
  };

  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nextIsDark = theme === "dark";
  const currentIsDark = root.classList.contains("theme-dark");
  if (nextIsDark === currentIsDark) {
    apply();
    return;
  }

  if (!animate || reduceMotion) {
    apply();
    return;
  }

  if (typeof document.startViewTransition === "function") {
    document.startViewTransition(apply);
    return;
  }

  root.classList.remove("theme-fade-in");
  root.classList.add("theme-fade-out");
  window.setTimeout(() => {
    apply();
    root.classList.remove("theme-fade-out");
    root.classList.add("theme-fade-in");
    window.setTimeout(() => root.classList.remove("theme-fade-in"), 280);
  }, 160);
}

async function refresh() {
  const [ops, staffData, session] = await Promise.all([
    api("/operations"),
    api("/staff"),
    api("/session"),
  ]);
  operations = ops;
  staff = staffData;
  applyAdminVisibility(session?.isAdmin || session?.canViewLogs);
  applySessionUser(session);
  renderStaffLists();
  render();
}

on("#themeToggle", "change", (event) => setTheme(event.target.checked ? "dark" : "light"));
on("#dayTab", "click", () => showView("day"));
on("#weekTab", "click", () => showView("week"));
on("#planTab", "click", () => showView("plan"));
on("#staffTab", "click", () => showView("staff"));
on("#usersTab", "click", () => showView("users"));
on("#statsTab", "click", () => showView("stats"));
on("#logsTab", "click", () => showView("logs"));
on("#refreshUsers", "click", () => loadUsers());
on("#refreshStats", "click", () => loadStats());
on("#statsFilterForm", "submit", (event) => {
  event.preventDefault();
  loadStats();
});
on("#statsReset", "click", () => {
  if ($("#statsFrom")) $("#statsFrom").value = "";
  if ($("#statsTo")) $("#statsTo").value = "";
  loadStats();
});
on("#closeUserDialog", "click", () => closeUserEditor());
on("#cancelUserEdit", "click", () => closeUserEditor());
on("#userForm", "submit", saveUserEdit);
on("#usersBody", "click", (event) => {
  const button = event.target.closest("button[data-user-action]");
  if (!button) return;
  const userId = button.dataset.userId;
  const action = button.dataset.userAction;
  if (action === "edit") {
    const user = siteUsers.find((item) => item.id === userId);
    if (user) openUserEditor(user);
    return;
  }
  if (action === "toggle-ban") {
    toggleBanUser(userId);
    return;
  }
  if (action === "delete") deleteSiteUser(userId);
});
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
on("#prevDay", "click", () => {
  shiftSelectedDay(-1);
});
on("#nextDay", "click", () => {
  shiftSelectedDay(1);
});
on("#thisDay", "click", () => {
  goToSelectedDay(todayYmd());
});
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
on("#closeOperation", "click", () => closeModalDialog($("#operationDialog")));
on("#cancelOperation", "click", () => closeModalDialog($("#operationDialog")));
on("#attachments", "change", (event) => addPendingFiles(event.target.files));
on("#attachmentsPanelList", "click", (event) => {
  const saved = event.target.closest("[data-remove-saved]");
  if (saved) {
    removeSavedAttachment(saved.dataset.removeSaved);
    return;
  }
  const pending = event.target.closest("[data-remove-pending]");
  if (!pending) return;
  removePendingFile(Number(pending.dataset.removePending));
});
on("#operationForm", "submit", saveOperation);
on("#operationSide", "change", syncProcedureSideFromSelect);
on("#procedureSuggestToggle", "click", (event) => {
  event.preventDefault();
  toggleProcedureSuggestions();
});
on("#procedure", "focus", () => showProcedureSuggestions());
on("#procedure", "input", () => {
  showProcedureSuggestions();
  paintProcedureSuggestions();
});
on("#procedureSuggestList", "mousedown", (event) => {
  const button = event.target.closest("[data-procedure]");
  if (!button) return;
  event.preventDefault();
  setProcedureFromSuggestion(button.getAttribute("data-procedure") || "");
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".procedure-field")) return;
  hideProcedureSuggestions();
});
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
document.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-picker]");
  if (!input) return;
  const pickerId = input.dataset.picker;
  const max = PICKER_LIMITS[pickerId];
  if (!max) return;

  if (pickerId === "teamPicker") {
    const name = input.value;
    if (input.checked) {
      if (teamSelectionOrder.includes(name)) {
        paintPicker("teamPicker");
        return;
      }
      if (teamSelectionOrder.length >= MAX_SURGEONS) {
        input.checked = false;
        alert("Можна обрати максимум 2 хірургів: 1 — основний, 2 — асистент.");
        return;
      }
      teamSelectionOrder.push(name);
    } else {
      teamSelectionOrder = teamSelectionOrder.filter((item) => item !== name);
    }
    paintPicker("teamPicker");
    return;
  }

  const selected = selectedPickerValues(pickerId);
  if (selected.length <= max) {
    paintPicker(pickerId);
    return;
  }
  if (max === 1) {
    document.querySelectorAll(`#${pickerId} input[type="checkbox"]`).forEach((box) => {
      if (box !== input) box.checked = false;
    });
    paintPicker(pickerId);
    return;
  }
  input.checked = false;
  alert("Можна обрати максимум 1 анестезіолога.");
});
on("#deleteOperation", "click", () => {
  if (editingId) deleteOperation(editingId);
});
on("#closeMediaDialog", "click", closeMediaDialog);
on("#mediaPrev", "click", () => showMediaAt(mediaIndex - 1));
on("#mediaNext", "click", () => showMediaAt(mediaIndex + 1));
on("#mediaDownload", "click", downloadCurrentMedia);
on("#mediaDelete", "click", deleteCurrentMedia);
on("#mediaZoomIn", "click", () => setMediaZoom(mediaZoom + MEDIA_ZOOM_STEP));
on("#mediaZoomOut", "click", () => setMediaZoom(mediaZoom - MEDIA_ZOOM_STEP));
on("#mediaZoomReset", "click", () => setMediaZoom(1));
on("#mediaFullscreen", "click", toggleMediaFullscreen);
on("#mediaFsClose", "click", () => exitMediaFullscreen());
on("#mediaFsOverlay", "click", (event) => {
  if (mediaPinch || mediaPanDrag) return;
  if (event.target === $("#mediaFsOverlay") || event.target?.classList?.contains("media-fs-stage")) {
    exitMediaFullscreen();
  }
});
bindMediaPinchTarget($("#mediaFsOverlay"));
bindMediaPinchTarget($("#mediaFsOverlay")?.querySelector(".media-fs-stage"));
bindMediaPinchTarget($("#mediaFsImage"));
on("#mediaFsOverlay", "cancel", (event) => {
  event.preventDefault();
  exitMediaFullscreen();
});
on("#mediaFsOverlay", "close", () => {
  document.body.classList.remove("media-fs-open");
  syncMediaFullscreenUi();
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    resetMediaZoomState();
    updateMediaZoomUi();
  }
  syncMediaFullscreenUi();
});
document.addEventListener("webkitfullscreenchange", () => {
  if (!document.webkitFullscreenElement && !document.fullscreenElement) {
    resetMediaZoomState();
    updateMediaZoomUi();
  }
  syncMediaFullscreenUi();
});
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
on("#refreshLogs", "click", () => loadLogs());

(function watchScheduleOrientation() {
  let lastLandscape = window.matchMedia("(orientation: landscape)").matches;
  const sync = () => {
    const landscape = window.matchMedia("(orientation: landscape)").matches;
    if (landscape === lastLandscape) return;
    lastLandscape = landscape;
    if (currentView === "schedule" && (scheduleMode === "day" || scheduleMode === "week" || scheduleMode === "plan")) {
      render();
    }
  };
  window.addEventListener("orientationchange", () => window.setTimeout(sync, 120));
  window.addEventListener("resize", () => {
    window.clearTimeout(watchScheduleOrientation._timer);
    watchScheduleOrientation._timer = window.setTimeout(sync, 180);
  });
})();

setTheme(localStorage.getItem("surgery-theme") || "light", { animate: false });
showView("day");

["operationDialog", "userDialog", "mediaDialog", "mediaFsOverlay"].forEach((id) => {
  wireModalScrollLock($(`#${id}`));
});

document.addEventListener("focusin", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (!target.closest("#operationDialog, #userDialog")) return;
  if (!/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
  scrollDialogFieldIntoView(target);
});

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (!active.closest("#operationDialog[open], #userDialog[open]")) return;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
    scrollDialogFieldIntoView(active);
  });
}

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
