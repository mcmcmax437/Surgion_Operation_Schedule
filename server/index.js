import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import {
  createPool,
  waitForDatabase,
  migrate,
  seedStaff,
  mapOperation,
  parseJson,
  decodeOriginalName,
  guessMime,
} from "./db.js";
import {
  clientIp,
  userAgent,
  logAccess,
  logChange,
  diffFields,
  requireAuth,
  attachGeo,
  createSession,
} from "./auth.js";
import {
  normalizeEmail,
  isValidEmail,
  hashPassword,
  verifyPassword,
  publicUser,
  normalizeRole,
  adminUserDetails,
  findUserByEmail,
  findUserById,
  findUserByGoogleSub,
  createUser,
  linkGoogleSub,
  ensureAdminUser,
  countActiveAdmins,
  listUsers,
  updateUser,
  deleteUser,
  revokeUserSessions,
} from "./users.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const uploadsDir = path.join(rootDir, "uploads");
const PORT = Number(process.env.PORT || 3001);
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 365);
const ARCHIVE_RETENTION_DAYS = Number(process.env.ARCHIVE_RETENTION_DAYS || 7);
const ARCHIVE_TZ = process.env.ARCHIVE_TZ || "Europe/Kyiv";
const ARCHIVE_JOB_MS = Number(process.env.ARCHIVE_JOB_MS || 60 * 60 * 1000);
const REGISTRATION_ENABLED = String(process.env.REGISTRATION_ENABLED || "true").toLowerCase() !== "false";

function loadGoogleClientId() {
  const fromEnv = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(rootDir, "auth.config.json"), "utf8");
    const conf = JSON.parse(raw);
    const id = String(conf?.googleClientId || "").trim();
    if (id && !id.includes("YOUR_GOOGLE")) return id;
  } catch {
    // optional file
  }
  return "";
}

const GOOGLE_CLIENT_ID = loadGoogleClientId();
if (GOOGLE_CLIENT_ID) {
  console.log("Google Sign-In enabled");
} else {
  console.log("Google Sign-In disabled (set googleClientId in auth.config.json or GOOGLE_CLIENT_ID in .env)");
}

const hasSharedPassword = Boolean(ACCESS_PASSWORD);
const hasAdminBootstrap = Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD);
if (!hasSharedPassword && !hasAdminBootstrap) {
  console.error("Set ACCESS_PASSWORD and/or ADMIN_EMAIL + ADMIN_PASSWORD in .env");
  process.exit(1);
}
if (!process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) {
  console.error("MYSQL_USER and MYSQL_DATABASE are required in .env");
  process.exit(1);
}

/** In-memory login brute-force protection (per process). */
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_LOCK_MS = Number(process.env.LOGIN_LOCK_MS || 15 * 60 * 1000);
const loginAttempts = new Map();

function loginAttemptKey(ip, email = "") {
  return `${String(ip || "unknown")}|${normalizeEmail(email || "")}`;
}

function getLoginAttempt(ip, email = "") {
  const key = loginAttemptKey(ip, email);
  const entry = loginAttempts.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (entry.lockedUntil && entry.lockedUntil > now) return entry;
  if (entry.lockedUntil && entry.lockedUntil <= now) {
    loginAttempts.delete(key);
    return null;
  }
  if (entry.firstAt && now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return null;
  }
  return entry;
}

function loginThrottleMessage(entry) {
  const waitMs = Math.max(0, (entry?.lockedUntil || 0) - Date.now());
  const mins = Math.max(1, Math.ceil(waitMs / 60000));
  return `Забагато невдалих спроб входу. Спробуйте знову через ${mins} хв.`;
}

function assertLoginAllowed(ip, email = "") {
  const entry = getLoginAttempt(ip, email);
  if (entry?.lockedUntil && entry.lockedUntil > Date.now()) {
    return loginThrottleMessage(entry);
  }
  return null;
}

function recordLoginFailure(ip, email = "") {
  const key = loginAttemptKey(ip, email);
  const now = Date.now();
  let entry = loginAttempts.get(key);
  if (!entry || (entry.firstAt && now - entry.firstAt > LOGIN_WINDOW_MS) || (entry.lockedUntil && entry.lockedUntil <= now)) {
    entry = { count: 0, firstAt: now, lockedUntil: 0 };
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOGIN_LOCK_MS;
    entry.count = 0;
    entry.firstAt = now;
  }
  loginAttempts.set(key, entry);
  return entry;
}

function clearLoginFailures(ip, email = "") {
  loginAttempts.delete(loginAttemptKey(ip, email));
}

fs.mkdirSync(uploadsDir, { recursive: true });

const pool = createPool();
const app = express();
const auth = requireAuth(pool);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const name = decodeOriginalName(file.originalname);
      const ext = path.extname(name || "").slice(0, 20);
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: 512 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    const name = String(decodeOriginalName(file.originalname) || "").toLowerCase();
    const videoExt = /\.(mp4|mov|m4v|webm|avi|mkv|3gp|mpeg|mpg)$/i.test(name);
    const imageExt = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i.test(name);
    if (mime.startsWith("image/") || mime.startsWith("video/") || videoExt || imageExt) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image and video files are allowed"));
  },
});

function optionalUpload(req, res, next) {
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("multipart/form-data")) {
    return upload.array("files", 12)(req, res, next);
  }
  req.files = [];
  next();
}

app.set("trust proxy", true);
app.use(cors({ origin: true, credentials: true }));
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "2mb" }));

function operationLogRef(id, patient) {
  const name = String(patient || "").trim();
  return name ? `${id} (${name})` : String(id || "");
}

function summaryWithPatient(summary, patient, entityId) {
  const text = String(summary || "");
  const name = String(patient || "").trim();
  if (!name || text.includes(name)) return text;
  const id = String(entityId || "");
  if (id && text.includes(id)) return text.replace(id, `${id} (${name})`);
  return text;
}

const LOG_OPERATION_FIELDS = [
  ["date", "Дата"],
  ["queueNo", "Черга"],
  ["department", "Відділення"],
  ["patient", "Пацієнт"],
  ["birthDate", "Дата народження"],
  ["patientAge", "Вік"],
  ["bloodGroup", "Група крові"],
  ["diagnosis", "Діагноз"],
  ["procedure", "Втручання"],
  ["teamMembers", "Операційна бригада"],
  ["anesthesiologists", "Анестезіолог"],
  ["infections", "Інфекційні маркери"],
  ["patientFlags", "Позначки"],
  ["status", "Статус"],
  ["notes", "Примітки"],
];

const LOG_STAFF_FIELDS = [
  ["team", "Список хірургів"],
  ["anesthesiologists", "Список анестезіологів"],
];

const LOG_USER_FIELDS = [
  ["name", "Користувач"],
  ["email", "Email"],
  ["role", "Роль"],
  ["status", "Статус акаунта"],
];

function clipLogText(value, max = 280) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatLogDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value || "").trim();
  return `${match[3]}/${match[2]}/${match[1].slice(-2)}`;
}

function formatLogList(value) {
  if (!Array.isArray(value)) return "";
  return value.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
}

function formatLogScalar(field, value) {
  if (value == null || value === "") return "";
  if (field === "department") {
    if (value === "dept2") return "Хірургічне відділення №2";
    if (value === "dept1") return "Хірургічне відділення №1";
  }
  if (field === "date" || field === "birthDate") return formatLogDate(value);
  if (field === "role") {
    if (value === "admin") return "Адміністратор";
    if (value === "anesthesiologist") return "Анестезіолог";
    return "Лікар";
  }
  if (field === "status" && (value === "active" || value === "disabled")) {
    return value === "disabled" ? "Заблокований" : "Активний";
  }
  if (field === "patientFlags") {
    const labels = { zsu: "ЗСУ", vip: "VIP" };
    return (Array.isArray(value) ? value : []).map((item) => labels[item] || item).join(", ");
  }
  if (field === "attachments") return "";
  if (Array.isArray(value)) return formatLogList(value);
  return clipLogText(value);
}

function attachmentNames(value) {
  if (!Array.isArray(value)) return [];
  return value.map((file) => String(file?.name || file?.original_name || "").trim()).filter(Boolean);
}

function logChangeLine(label, from, to) {
  const left = clipLogText(from) || "не вказано";
  const right = clipLogText(to) || "не вказано";
  if (left === right) return null;
  return {
    label,
    from: left,
    to: right,
    text: `Зміна «${label}» з «${left}» на «${right}»`,
  };
}

function logSetLine(label, value, prefix = "") {
  const text = clipLogText(value);
  if (!text) return null;
  return {
    label,
    from: "",
    to: text,
    text: prefix ? `${label}: ${prefix} «${text}»` : `${label}: «${text}»`,
  };
}

function describeFieldChanges(before, after, fields, mode) {
  const changes = [];
  for (const [field, label] of fields) {
    if (field === "attachments") continue;
    const left = formatLogScalar(field, before?.[field]);
    const right = formatLogScalar(field, after?.[field]);
    if (mode === "update") {
      const line = logChangeLine(label, left, right);
      if (line) changes.push(line);
    } else if (mode === "create") {
      const line = logSetLine(label, right);
      if (line) changes.push(line);
    } else if (mode === "delete") {
      const line = logSetLine(label, left, "було");
      if (line) changes.push(line);
    }
  }
  return changes;
}

function describeAttachmentChanges(before, after) {
  const left = attachmentNames(before?.attachments);
  const right = attachmentNames(after?.attachments);
  const added = right.filter((name) => !left.includes(name));
  const removed = left.filter((name) => !right.includes(name));
  const changes = [];
  if (added.length) {
    changes.push({
      label: "Файли",
      from: "",
      to: added.join(", "),
      text: `Додано файл: «${added.join("», «")}»`,
    });
  }
  if (removed.length) {
    changes.push({
      label: "Файли",
      from: removed.join(", "),
      to: "",
      text: `Видалено файл: «${removed.join("», «")}»`,
    });
  }
  return changes;
}

function describeLogChanges({ entityType, action, before, after, changedFields }) {
  if (entityType === "attachment") {
    const fileName = before?.name || before?.original_name || "без назви";
    return [{ label: "Файл", from: fileName, to: "", text: `Видалено файл: «${fileName}»` }];
  }

  if (entityType === "staff") {
    return describeFieldChanges(before, after, LOG_STAFF_FIELDS, action === "create" ? "create" : "update");
  }

  if (entityType === "user") {
    const mode = action === "delete" ? "delete" : "update";
    const changes = describeFieldChanges(before, after, LOG_USER_FIELDS, mode);
    if ((changedFields || []).includes("password")) {
      changes.push({ label: "Пароль", from: "", to: "", text: "Пароль: змінено" });
    }
    return changes;
  }

  const mode = action === "create" ? "create" : action === "delete" ? "delete" : "update";
  const changes = describeFieldChanges(before, after, LOG_OPERATION_FIELDS, mode);
  if (mode === "update") changes.push(...describeAttachmentChanges(before, after));
  return changes;
}

function logDetailsText(changes) {
  const text = (changes || []).map((item) => item.text).filter(Boolean).join("\n");
  return text || null;
}

function logPatientName(before, after) {
  return String(after?.patient || before?.patient || "").trim();
}

function nameList(value) {
  return (Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean);
}

function logDoctorNames(entityType, before, after, actorName) {
  const names = new Set();
  const add = (value) => {
    const text = String(value || "").trim();
    if (text) names.add(text);
  };
  add(actorName);

  if (entityType === "staff") {
    const beforeNames = new Set([...nameList(before?.team), ...nameList(before?.anesthesiologists)]);
    const afterNames = new Set([...nameList(after?.team), ...nameList(after?.anesthesiologists)]);
    for (const name of new Set([...beforeNames, ...afterNames])) {
      if (beforeNames.has(name) !== afterNames.has(name)) add(name);
    }
    return [...names];
  }

  if (entityType === "user") {
    add(before?.name);
    add(after?.name);
    return [...names];
  }

  for (const snap of [before, after]) {
    nameList(snap?.teamMembers).forEach(add);
    nameList(snap?.anesthesiologists).forEach(add);
  }
  return [...names];
}

function actorFromReq(req) {
  const user = req?.user;
  if (!user) {
    return { actorUserId: null, actorName: null, actorEmail: null };
  }
  return {
    actorUserId: user.id || null,
    actorName: user.name || null,
    actorEmail: user.email || null,
  };
}

function normalizeNameList(value, limit) {
  const list = Array.isArray(value) ? value : [];
  const names = [];
  for (const item of list) {
    const name = String(item || "").trim();
    if (!name || names.includes(name)) continue;
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

function canSetClearanceStatus(user) {
  const role = user?.role;
  return role === "admin" || role === "anesthesiologist";
}

function bodyToOperation(body) {
  const teamMembers = Array.isArray(body.teamMembers)
    ? body.teamMembers
    : parseJson(body.teamMembers, []);
  const anesthesiologists = Array.isArray(body.anesthesiologists)
    ? body.anesthesiologists
    : parseJson(body.anesthesiologists, []);
  const infectionsRaw = Array.isArray(body.infections)
    ? body.infections
    : parseJson(body.infections, []);
  const allowedInfections = ["HCV", "HbsAg", "HIV", "RW"];
  const infections = infectionsRaw.filter((item) => allowedInfections.includes(item));
  const allowedFlags = ["zsu", "vip"];
  const flagsRaw = Array.isArray(body.patientFlags)
    ? body.patientFlags
    : parseJson(body.patientFlags, []);
  const patientFlags = flagsRaw.filter((item) => allowedFlags.includes(item));
  const ageRaw = body.patientAge;
  const patientAge = ageRaw === "" || ageRaw == null ? null : Number(ageRaw);
  const queueRaw = body.queueNo;
  const queueNo = queueRaw === "" || queueRaw == null ? null : Number(queueRaw);
  const allowedStatuses = ["ОК", "Потребує дообстеження", "Відміна"];
  const statusRaw = String(body.status || "").trim();
  const status = allowedStatuses.includes(statusRaw) ? statusRaw : "";

  return {
    date: body.date || null,
    time: body.time || null,
    queueNo: Number.isFinite(queueNo) && queueNo > 0 ? Math.round(queueNo) : null,
    department: body.department === "dept2" ? "dept2" : "dept1",
    patient: String(body.patient || "").trim(),
    birthDate: body.birthDate || null,
    patientAge: Number.isFinite(patientAge) && patientAge >= 0 ? Math.round(patientAge) : null,
    bloodGroup: body.bloodGroup || null,
    diagnosis: String(body.diagnosis || "").trim(),
    procedure: String(body.procedure || "").trim(),
    teamMembers: normalizeNameList(teamMembers, 3),
    anesthesiologists: normalizeNameList(anesthesiologists, 1),
    infections,
    patientFlags,
    status,
    notes: String(body.notes || "").trim(),
  };
}

function fileMeta(file) {
  const originalName = decodeOriginalName(file.originalname);
  return {
    originalName,
    mimeType: guessMime(originalName, file.mimetype),
  };
}

function isConvertibleImage(mime, name) {
  const type = String(mime || "").toLowerCase();
  const fileName = String(name || "").toLowerCase();
  if (type === "image/gif" || /\.gif$/i.test(fileName)) return false;
  if (type.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|bmp|heic|heif|avif|tiff?)$/i.test(fileName);
}

function attachmentBaseName(name) {
  const decoded = decodeOriginalName(name);
  const base = String(decoded || "image").replace(/\.[^.]+$/, "").trim();
  return base || "image";
}

const execFileAsync = promisify(execFile);
let ffmpegBin = null;
let ffprobeBin = null;

async function resolveBin(name, candidates) {
  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ["-version"], { timeout: 8000, windowsHide: true });
      return bin;
    } catch {
      // try next path
    }
  }
  console.warn(`${name} not found — .mov preview for PC/Android is unavailable`);
  return "";
}

async function ensureFfmpeg() {
  if (ffmpegBin == null) {
    ffmpegBin = await resolveBin("ffmpeg", ["ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]);
  }
  if (ffprobeBin == null) {
    ffprobeBin = await resolveBin("ffprobe", ["ffprobe", "/usr/bin/ffprobe", "/usr/local/bin/ffprobe"]);
  }
  return Boolean(ffmpegBin);
}

function isVideoUpload(mime, name) {
  const type = String(mime || "").toLowerCase();
  const fileName = String(name || "").toLowerCase();
  if (type.startsWith("video/")) return true;
  return /\.(mp4|mov|m4v|webm|avi|mkv|3gp|mpeg|mpg)$/i.test(fileName);
}

function needsBrowserMp4(mime, name) {
  const type = String(mime || "").toLowerCase();
  const fileName = String(name || "").toLowerCase();
  if (/\.mp4$/i.test(fileName) || type === "video/mp4") return false;
  if (/\.webm$/i.test(fileName) || type === "video/webm") return false;
  return isVideoUpload(mime, name);
}

/** iPhone/iPad and desktop Safari play the original .mov. Chrome/Edge/Android get MP4. */
function clientPlaysOriginalVideo(req) {
  const ua = String(req.headers["user-agent"] || "");
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  const mac = /Macintosh|Mac OS X/i.test(ua);
  const safari = /Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox|Android/i.test(ua);
  return mac && safari;
}

function previewMp4Path(storagePath) {
  const base = path.parse(String(storagePath || "video")).name || "video";
  return path.join(uploadsDir, `${base}.preview.mp4`);
}

const previewJobs = new Map();

async function videoCodecName(srcPath) {
  if (!ffprobeBin) return "";
  const { stdout } = await execFileAsync(
    ffprobeBin,
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name",
      "-of", "default=nw=1:nk=1",
      srcPath,
    ],
    { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return String(stdout || "").trim().toLowerCase();
}

async function buildBrowserMp4(srcPath, destPath) {
  const tmp = `${destPath}.part`;
  const ff = { timeout: 20 * 60 * 1000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
  let codec = "";
  try {
    codec = await videoCodecName(srcPath);
  } catch {
    codec = "";
  }

  const finish = async () => {
    await fs.promises.rename(tmp, destPath);
  };

  // Already H.264: change container only — no quality loss.
  if (codec === "h264" || codec === "avc1") {
    try {
      await execFileAsync(ffmpegBin, [
        "-y", "-i", srcPath,
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c", "copy",
        "-movflags", "+faststart",
        tmp,
      ], ff);
      await finish();
      return;
    } catch (error) {
      console.warn("MP4 remux failed, re-encoding:", error?.message || error);
      await fs.promises.unlink(tmp).catch(() => {});
    }
  }

  await execFileAsync(ffmpegBin, [
    "-y", "-i", srcPath,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "160k",
    "-movflags", "+faststart",
    tmp,
  ], ff);
  await finish();
}

function ensureBrowserMp4(srcPath, destPath) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1024) {
    return Promise.resolve(destPath);
  }
  if (!previewJobs.has(destPath)) {
    const job = buildBrowserMp4(srcPath, destPath)
      .catch(async (error) => {
        await fs.promises.unlink(`${destPath}.part`).catch(() => {});
        await fs.promises.unlink(destPath).catch(() => {});
        throw error;
      })
      .finally(() => previewJobs.delete(destPath));
    previewJobs.set(destPath, job);
  }
  return previewJobs.get(destPath).then(() => destPath);
}

/** Convert uploaded images to AVIF. Videos stay as the original file. */
async function prepareUploadedFile(file) {
  const meta = fileMeta(file);
  const srcPath = path.join(uploadsDir, file.filename);

  if (!isConvertibleImage(meta.mimeType, meta.originalName)) {
    return {
      originalName: meta.originalName,
      mimeType: meta.mimeType,
      sizeBytes: file.size,
      storagePath: file.filename,
    };
  }

  if (meta.mimeType === "image/avif" || /\.avif$/i.test(meta.originalName)) {
    return {
      originalName: meta.originalName.endsWith(".avif")
        ? meta.originalName
        : `${attachmentBaseName(meta.originalName)}.avif`,
      mimeType: "image/avif",
      sizeBytes: file.size,
      storagePath: file.filename,
    };
  }

  const newFilename = `${path.parse(file.filename).name}.avif`;
  const destPath = path.join(uploadsDir, newFilename);
  try {
    await sharp(srcPath, { failOn: "none" })
      .rotate()
      .avif({ quality: 72, effort: 4 })
      .toFile(destPath);
    fs.unlinkSync(srcPath);
    const sizeBytes = fs.statSync(destPath).size;
    return {
      originalName: `${attachmentBaseName(meta.originalName)}.avif`,
      mimeType: "image/avif",
      sizeBytes,
      storagePath: newFilename,
    };
  } catch (error) {
    console.warn("AVIF conversion failed, keeping original:", meta.originalName, error?.message || error);
    if (fs.existsSync(destPath)) {
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    }
    return {
      originalName: meta.originalName,
      mimeType: meta.mimeType,
      sizeBytes: file.size,
      storagePath: file.filename,
    };
  }
}

async function prepareUploadedFiles(files) {
  const prepared = [];
  for (const file of files || []) {
    prepared.push(await prepareUploadedFile(file));
  }
  return prepared;
}

async function sendStoredFile(req, res, file) {
  const full = path.join(uploadsDir, file.storage_path);
  if (!fs.existsSync(full)) {
    res.status(404).json({ error: "File missing" });
    return;
  }

  const downloadName = decodeOriginalName(file.original_name);
  const mime = guessMime(downloadName, file.mime_type);
  const wantDownload = ["1", "true", "png"].includes(String(req.query.download || "").toLowerCase());
  const asPng = wantDownload && isConvertibleImage(mime, downloadName);

  const forceBrowserMp4 = String(req.query.playback || "") === "mp4";
  if (!wantDownload && needsBrowserMp4(mime, downloadName) && (forceBrowserMp4 || !clientPlaysOriginalVideo(req))) {
    if (await ensureFfmpeg()) {
      try {
        const preview = await ensureBrowserMp4(full, previewMp4Path(file.storage_path));
        streamLocalFile(req, res, preview, {
          mime: "video/mp4",
          downloadName: `${attachmentBaseName(downloadName)}.mp4`,
          wantDownload: false,
        });
        return;
      } catch (error) {
        console.warn("Browser MP4 preview failed, sending original:", downloadName, error?.message || error);
        if (res.headersSent) return;
      }
    }
  }

  if (asPng) {
    const pngName = `${attachmentBaseName(downloadName)}.png`;
    res.setHeader("Content-Type", "image/png");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(pngName)}`,
    );
    res.setHeader("Cache-Control", "private, no-store");
    const pipeline = sharp(full, { failOn: "none" }).rotate().png({ compressionLevel: 6 });
    pipeline.on("error", (error) => {
      console.warn("PNG conversion failed:", downloadName, error?.message || error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Не вдалося конвертувати зображення в PNG" });
      } else {
        res.destroy(error);
      }
    });
    pipeline.pipe(res);
    return;
  }

  streamLocalFile(req, res, full, { mime, downloadName, wantDownload });
}

function streamLocalFile(req, res, full, { mime, downloadName, wantDownload }) {
  const stat = fs.statSync(full);
  const size = stat.size;
  const range = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mime);
  res.setHeader(
    "Content-Disposition",
    `${wantDownload ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  );
  res.setHeader("Cache-Control", "private, no-store");

  if (!range) {
    res.setHeader("Content-Length", size);
    fs.createReadStream(full).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }

  let start = match[1] === "" ? 0 : Number(match[1]);
  let end = match[2] === "" ? size - 1 : Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${size}`);
    res.end();
    return;
  }
  end = Math.min(end, size - 1);
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", end - start + 1);
  fs.createReadStream(full, { start, end }).pipe(res);
}

async function nextOperationId(connection) {
  const [rows] = await connection.query(
    `SELECT id FROM operations ORDER BY id DESC LIMIT 1`,
  );
  const max = rows.length
    ? Number(String(rows[0].id).replace("OP-", "")) || 0
    : 0;
  return `OP-${String(max + 1).padStart(4, "0")}`;
}

async function loadAttachments(connection, operationId) {
  const [rows] = await connection.query(
    `SELECT id, original_name, mime_type, size_bytes
     FROM attachments WHERE operation_id = :operation_id ORDER BY created_at ASC`,
    { operation_id: operationId },
  );
  return rows;
}

async function loadOperation(connection, id) {
  const [rows] = await connection.query(
    `SELECT * FROM operations WHERE id = :id LIMIT 1`,
    { id },
  );
  if (!rows.length) return null;
  const attachments = await loadAttachments(connection, id);
  return mapOperation(rows[0], attachments);
}

function todayInArchiveTz() {
  return new Date().toLocaleDateString("en-CA", { timeZone: ARCHIVE_TZ });
}

function addDaysYmd(ymd, days) {
  const [year, month, day] = String(ymd).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function mondayOfWeek(ymd) {
  const [year, month, day] = String(ymd).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const sunday0 = date.getUTCDay();
  const mondayOffset = sunday0 === 0 ? -6 : 1 - sunday0;
  return addDaysYmd(ymd, mondayOffset);
}

function currentWeekMonday() {
  return mondayOfWeek(todayInArchiveTz());
}

function shouldArchiveDate(_dateYmd) {
  // Keep all operations in the active schedule forever (no auto week archive).
  return false;
}

async function unlinkAttachmentFiles(files) {
  for (const file of files) {
    const full = path.join(uploadsDir, file.storage_path);
    await fs.promises.unlink(full).catch(() => {});
    const preview = previewMp4Path(file.storage_path);
    await fs.promises.unlink(preview).catch(() => {});
    await fs.promises.unlink(`${preview}.part`).catch(() => {});
  }
}

async function permanentlyDeleteOperation(id, meta = {}) {
  const before = await loadOperation(pool, id);
  if (!before) return false;

  const [files] = await pool.query(
    `SELECT storage_path FROM attachments WHERE operation_id = :id`,
    { id },
  );
  await pool.query(`DELETE FROM operations WHERE id = :id`, { id });
  await unlinkAttachmentFiles(files);

  const deleteChanges = describeLogChanges({
    entityType: "operation",
    action: "delete",
    before,
    after: null,
  });
  await logChange(pool, {
    entityType: "operation",
    entityId: id,
    action: meta.action || "delete",
    summary: meta.summary || `Видалено операцію ${id} (${before.patient})`,
    details: logDetailsText(deleteChanges),
    before,
    ip: meta.ip || null,
    userAgent: meta.userAgent || null,
    actorUserId: meta.actorUserId || null,
    actorName: meta.actorName || null,
    actorEmail: meta.actorEmail || null,
  });
  return true;
}

let lastArchiveMaintenanceAt = 0;
let archiveMaintenancePromise = null;

async function runArchiveMaintenance(force = false) {
  const now = Date.now();
  if (!force && now - lastArchiveMaintenanceAt < 30_000) {
    return { skipped: true };
  }
  if (archiveMaintenancePromise) return archiveMaintenancePromise;

  archiveMaintenancePromise = (async () => {
  lastArchiveMaintenanceAt = Date.now();
  // Restore previously auto-archived operations back into the live schedule.
  // Do not auto-archive past weeks and do not purge by age.
  const [restoreResult] = await pool.query(
    `UPDATE operations
     SET archived_at = NULL,
         updated_at = UTC_TIMESTAMP(3)
     WHERE archived_at IS NOT NULL`,
  );

  const restored = Number(restoreResult?.affectedRows || 0);
  if (restored) {
    console.log(`Archive maintenance: restored=${restored} operations to active schedule`);
  }
  return { archived: 0, purged: 0, restored, today: todayInArchiveTz() };
  })();

  try {
    return await archiveMaintenancePromise;
  } finally {
    archiveMaintenancePromise = null;
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/config", (_req, res) => {
  res.json({
    registrationEnabled: REGISTRATION_ENABLED,
    googleEnabled: Boolean(GOOGLE_CLIENT_ID),
    googleClientId: GOOGLE_CLIENT_ID || null,
    sharedPasswordEnabled: hasSharedPassword,
  });
});

app.get("/api/session", auth, async (req, res) => {
  const admin = Boolean(req.isAdmin);
  res.json({
    ip: req.clientIp,
    user: req.user || null,
    canViewLogs: admin,
    isAdmin: admin,
  });
});

async function issueLoginResponse(res, {
  pool,
  user = null,
  ip,
  ua,
  event = "login_success",
  details = {},
}) {
  const session = await createSession(pool, {
    userId: user?.id || null,
    ip,
    userAgent: ua,
    sessionDays: SESSION_DAYS,
  });
  try {
    await logAccess(pool, {
      event,
      ip,
      userAgent: ua,
      details: {
        ...details,
        userId: user?.id || null,
        email: user?.email || null,
        expiresAt: session.expiresAt,
      },
    });
  } catch (logError) {
    console.error(`${event} log failed:`, logError);
  }
  res.json({
    token: session.token,
    expiresAt: session.expiresAt,
    user: user ? publicUser(user) : null,
  });
}

app.post("/api/register", async (req, res) => {
  if (!REGISTRATION_ENABLED) {
    return res.status(403).json({ error: "Реєстрація вимкнена." });
  }
  const ip = clientIp(req);
  const ua = userAgent(req);
  const email = normalizeEmail(req.body?.email);
  const name = String(req.body?.name || "").trim();
  const password = String(req.body?.password || "");

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Вкажіть коректний email." });
  }
  if (name.length < 2) {
    return res.status(400).json({ error: "Вкажіть ПІБ або імʼя лікаря." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Пароль має містити щонайменше 8 символів." });
  }

  try {
    const existing = await findUserByEmail(pool, email);
    if (existing) {
      return res.status(409).json({ error: "Користувач із таким email уже існує." });
    }
    const passwordHash = await hashPassword(password);
    // No .env admin setup required: the first registered account becomes admin.
    const role = (await countActiveAdmins(pool)) === 0 ? "admin" : "doctor";
    const user = await createUser(pool, {
      email,
      name,
      passwordHash,
      role,
      status: "active",
    });
    await issueLoginResponse(res, {
      pool,
      user,
      ip,
      ua,
      event: "register_success",
      details: { method: "password", role },
    });
  } catch (error) {
    console.error("register failed:", error);
    res.status(503).json({
      error: "Сервер тимчасово недоступний. Спробуйте ще раз за хвилину.",
    });
  }
});

app.post("/api/login", async (req, res) => {
  const ip = clientIp(req);
  const ua = userAgent(req);
  const email = normalizeEmail(req.body?.email || "");
  const password = String(req.body?.password || "");

  try {
    // Account login (doctors / admin).
    if (email) {
      const throttleError = assertLoginAllowed(ip, email) || assertLoginAllowed(ip, "");
      if (throttleError) {
        await logAccess(pool, {
          event: "login_blocked",
          ip,
          userAgent: ua,
          details: { email, method: "password", reason: "brute_force" },
        }).catch(() => {});
        return res.status(429).json({ error: throttleError });
      }
      if (!isValidEmail(email) || !password) {
        return res.status(400).json({ error: "Вкажіть email і пароль." });
      }
      const user = await findUserByEmail(pool, email);
      if (!user || user.status !== "active" || !user.password_hash) {
        recordLoginFailure(ip, email);
        recordLoginFailure(ip, "");
        await logAccess(pool, { event: "login_fail", ip, userAgent: ua, details: { email, method: "password" } }).catch(() => {});
        return res.status(401).json({ error: "Невірний email або пароль." });
      }
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        recordLoginFailure(ip, email);
        recordLoginFailure(ip, "");
        await logAccess(pool, { event: "login_fail", ip, userAgent: ua, details: { email, method: "password" } }).catch(() => {});
        return res.status(401).json({ error: "Невірний email або пароль." });
      }
      clearLoginFailures(ip, email);
      clearLoginFailures(ip, "");
      return issueLoginResponse(res, {
        pool,
        user,
        ip,
        ua,
        event: "login_success",
        details: { method: "password" },
      });
    }

    // Legacy shared department password (optional).
    const sharedThrottle = assertLoginAllowed(ip, "");
    if (sharedThrottle) {
      await logAccess(pool, {
        event: "login_blocked",
        ip,
        userAgent: ua,
        details: { method: "shared", reason: "brute_force" },
      }).catch(() => {});
      return res.status(429).json({ error: sharedThrottle });
    }
    if (!hasSharedPassword || password !== ACCESS_PASSWORD) {
      recordLoginFailure(ip, "");
      try {
        await logAccess(pool, {
          event: "login_fail",
          ip,
          userAgent: ua,
          details: { method: "shared" },
        });
      } catch (logError) {
        console.error("login_fail log failed:", logError);
      }
      return res.status(401).json({ error: "Invalid password" });
    }

    clearLoginFailures(ip, "");
    return issueLoginResponse(res, {
      pool,
      user: null,
      ip,
      ua,
      event: "login_success",
      details: { method: "shared" },
    });
  } catch (error) {
    console.error("login failed:", error);
    res.status(503).json({
      error: "Сервер тимчасово недоступний. Спробуйте ще раз за хвилину.",
    });
  }
});

app.post("/api/auth/google", async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: "Вхід через Google не налаштовано." });
  }
  const ip = clientIp(req);
  const ua = userAgent(req);
  const credential = String(req.body?.credential || "").trim();
  if (!credential) {
    return res.status(400).json({ error: "Немає Google credential." });
  }

  try {
    const { OAuth2Client } = await import("google-auth-library");
    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload() || {};
    const googleSub = payload.sub;
    const email = normalizeEmail(payload.email || "");
    const name = String(payload.name || email || "Google user").trim();
    const emailVerified = Boolean(payload.email_verified);
    if (!googleSub || !email || !emailVerified) {
      return res.status(401).json({ error: "Google акаунт не підтверджено." });
    }

    let user = await findUserByGoogleSub(pool, googleSub);
    if (!user) {
      user = await findUserByEmail(pool, email);
      if (user) {
        if (!user.google_sub) await linkGoogleSub(pool, user.id, googleSub);
      } else if (REGISTRATION_ENABLED) {
        const role = (await countActiveAdmins(pool)) === 0 ? "admin" : "doctor";
        user = await createUser(pool, {
          email,
          name,
          googleSub,
          role,
          status: "active",
        });
      } else {
        return res.status(403).json({ error: "Реєстрація нових користувачів вимкнена." });
      }
    }

    if (!user || user.status !== "active") {
      return res.status(403).json({ error: "Обліковий запис вимкнено." });
    }

    return issueLoginResponse(res, {
      pool,
      user,
      ip,
      ua,
      event: "login_success",
      details: { method: "google" },
    });
  } catch (error) {
    console.error("google auth failed:", error);
    try {
      await logAccess(pool, {
        event: "login_fail",
        ip,
        userAgent: ua,
        details: { method: "google" },
      });
    } catch {
      // ignore
    }
    res.status(401).json({ error: "Не вдалося увійти через Google." });
  }
});

app.post("/api/logout", auth, async (req, res) => {
  await pool.query(`DELETE FROM sessions WHERE token = :token`, {
    token: req.sessionToken,
  });
  await logAccess(pool, {
    event: "logout",
    ip: req.clientIp,
    userAgent: req.clientUa,
    details: { userId: req.user?.id || null },
  });
  res.json({ ok: true });
});

app.get("/api/operations", auth, async (req, res) => {
  await runArchiveMaintenance();
  const archived = req.query.archived === "1" || req.query.archived === "true";
  const [rows] = await pool.query(
    archived
      ? `SELECT * FROM operations
         WHERE archived_at IS NOT NULL
         ORDER BY date DESC, queue_no DESC, id DESC`
      : `SELECT * FROM operations
         WHERE archived_at IS NULL
         ORDER BY date IS NULL, date ASC, department ASC, queue_no ASC, id ASC`,
  );
  const result = [];
  for (const row of rows) {
    const attachments = await loadAttachments(pool, row.id);
    result.push(mapOperation(row, attachments));
  }
  res.json(result);
});

app.post("/api/operations", auth, optionalUpload, async (req, res) => {
  const data = bodyToOperation(req.body);
  if (!data.patient || !data.procedure) {
    return res.status(400).json({ error: "patient and procedure are required" });
  }
  if (!canSetClearanceStatus(req.user)) data.status = "";

  const uploadedFiles = await prepareUploadedFiles(req.files || []);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const id = await nextOperationId(connection);
    const now = new Date();

    const archivedAt = shouldArchiveDate(data.date) ? now : null;
    await connection.query(
      `INSERT INTO operations
        (id, date, time, queue_no, department, patient, birth_date, patient_age, blood_group, diagnosis, \`procedure\`,
         team_members, anesthesiologists, infections, patient_flags, status, notes, is_example, archived_at, created_at, updated_at)
       VALUES
        (:id, :date, :time, :queue_no, :department, :patient, :birth_date, :patient_age, :blood_group, :diagnosis, :procedure,
         :team_members, :anesthesiologists, :infections, :patient_flags, :status, :notes, 0, :archived_at, :created_at, :updated_at)`,
      {
        id,
        date: data.date,
        time: data.time || null,
        queue_no: data.queueNo,
        department: data.department,
        patient: data.patient,
        birth_date: data.birthDate || null,
        patient_age: data.patientAge,
        blood_group: data.bloodGroup || null,
        diagnosis: data.diagnosis || null,
        procedure: data.procedure,
        team_members: JSON.stringify(data.teamMembers),
        anesthesiologists: JSON.stringify(data.anesthesiologists),
        infections: JSON.stringify(data.infections),
        patient_flags: JSON.stringify(data.patientFlags),
        status: data.status,
        notes: data.notes || null,
        archived_at: archivedAt,
        created_at: now,
        updated_at: now,
      },
    );

    for (const file of uploadedFiles) {
      await connection.query(
        `INSERT INTO attachments
          (id, operation_id, original_name, mime_type, size_bytes, storage_path, created_at)
         VALUES
          (:id, :operation_id, :original_name, :mime_type, :size_bytes, :storage_path, :created_at)`,
        {
          id: uuidv4(),
          operation_id: id,
          original_name: file.originalName,
          mime_type: file.mimeType,
          size_bytes: file.sizeBytes,
          storage_path: file.storagePath,
          created_at: now,
        },
      );
    }

    const created = await loadOperation(connection, id);
    await connection.commit();

    const createChanges = describeLogChanges({
      entityType: "operation",
      action: "create",
      before: null,
      after: created,
    });
    await logChange(pool, {
      entityType: "operation",
      entityId: id,
      action: "create",
      summary: `Додано операцію ${id} (${data.patient})`,
      details: logDetailsText(createChanges),
      changedFields: Object.keys(data),
      after: created,
      ip: req.clientIp,
      userAgent: req.clientUa,
      ...actorFromReq(req),
    });

    res.status(201).json(created);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

app.put("/api/operations/:id", auth, optionalUpload, async (req, res) => {
  const data = bodyToOperation(req.body);
  if (!data.patient || !data.procedure) {
    return res.status(400).json({ error: "patient and procedure are required" });
  }

  const expectedRaw = req.body?.expectedUpdatedAt;
  const expectedUpdatedAt = expectedRaw
    ? new Date(expectedRaw)
    : null;
  const hasExpected = expectedRaw
    && !Number.isNaN(expectedUpdatedAt?.getTime?.() ?? Number.NaN);

  const uploadedFiles = await prepareUploadedFiles(req.files || []);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const before = await loadOperation(connection, req.params.id);
    if (!before) {
      await connection.rollback();
      return res.status(404).json({ error: "Not found" });
    }

    if (hasExpected) {
      const currentUpdated = before.updatedAt ? new Date(before.updatedAt).getTime() : null;
      const expectedMs = expectedUpdatedAt.getTime();
      if (currentUpdated != null && Math.abs(currentUpdated - expectedMs) > 1000) {
        await connection.rollback();
        return res.status(409).json({
          error: "Операцію вже змінив інший користувач. Оновіть сторінку й збережіть ще раз.",
          conflict: true,
          updatedAt: before.updatedAt,
        });
      }
    }

    if (!canSetClearanceStatus(req.user)) data.status = before.status || "";

    const now = new Date();
    const keepArchived = shouldArchiveDate(data.date);
    await connection.query(
      `UPDATE operations SET
        date = :date,
        time = :time,
        queue_no = :queue_no,
        department = :department,
        patient = :patient,
        birth_date = :birth_date,
        patient_age = :patient_age,
        blood_group = :blood_group,
        diagnosis = :diagnosis,
        \`procedure\` = :procedure,
        team_members = :team_members,
        anesthesiologists = :anesthesiologists,
        infections = :infections,
        patient_flags = :patient_flags,
        status = :status,
        notes = :notes,
        archived_at = CASE
          WHEN :keep_archived = 1 THEN COALESCE(archived_at, :archived_at)
          ELSE NULL
        END,
        updated_at = :updated_at
       WHERE id = :id`,
      {
        id: req.params.id,
        date: data.date,
        time: data.time || null,
        queue_no: data.queueNo,
        department: data.department,
        patient: data.patient,
        birth_date: data.birthDate || null,
        patient_age: data.patientAge,
        blood_group: data.bloodGroup || null,
        diagnosis: data.diagnosis || null,
        procedure: data.procedure,
        team_members: JSON.stringify(data.teamMembers),
        anesthesiologists: JSON.stringify(data.anesthesiologists),
        infections: JSON.stringify(data.infections),
        patient_flags: JSON.stringify(data.patientFlags),
        status: data.status,
        notes: data.notes || null,
        keep_archived: keepArchived ? 1 : 0,
        archived_at: now,
        updated_at: now,
      },
    );

    for (const file of uploadedFiles) {
      await connection.query(
        `INSERT INTO attachments
          (id, operation_id, original_name, mime_type, size_bytes, storage_path, created_at)
         VALUES
          (:id, :operation_id, :original_name, :mime_type, :size_bytes, :storage_path, :created_at)`,
        {
          id: uuidv4(),
          operation_id: req.params.id,
          original_name: file.originalName,
          mime_type: file.mimeType,
          size_bytes: file.sizeBytes,
          storage_path: file.storagePath,
          created_at: now,
        },
      );
    }

    const after = await loadOperation(connection, req.params.id);
    await connection.commit();

    const fields = [
      "date", "queueNo", "department", "patient", "birthDate", "patientAge", "bloodGroup", "diagnosis",
      "procedure", "teamMembers", "anesthesiologists", "infections", "patientFlags", "status", "notes", "attachments",
    ];
    const changed = diffFields(before, after, fields);
    const updateChanges = describeLogChanges({
      entityType: "operation",
      action: "update",
      before,
      after,
      changedFields: changed,
    });

    await logChange(pool, {
      entityType: "operation",
      entityId: req.params.id,
      action: "update",
      summary: changed.length
        ? `Змінено операцію ${operationLogRef(req.params.id, after?.patient || data.patient)}`
        : `Оновлено операцію ${operationLogRef(req.params.id, after?.patient || data.patient)}`,
      details: logDetailsText(updateChanges),
      changedFields: changed,
      before,
      after,
      ip: req.clientIp,
      userAgent: req.clientUa,
      ...actorFromReq(req),
    });

    res.json(after);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

app.delete("/api/operations/:id", auth, async (req, res) => {
  const ok = await permanentlyDeleteOperation(req.params.id, {
    ip: req.clientIp,
    userAgent: req.clientUa,
    ...actorFromReq(req),
  });
  if (!ok) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
});

app.delete("/api/attachments/:id", auth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM attachments WHERE id = :id LIMIT 1`,
    { id: req.params.id },
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });

  const file = rows[0];
  await pool.query(`DELETE FROM attachments WHERE id = :id`, { id: file.id });
  await unlinkAttachmentFiles([file]);
  const after = await loadOperation(pool, file.operation_id);

  const fileChanges = describeLogChanges({
    entityType: "attachment",
    action: "delete",
    before: { name: decodeOriginalName(file.original_name), operationId: file.operation_id },
    after,
  });
  await logChange(pool, {
    entityType: "attachment",
    entityId: file.id,
    action: "delete",
    summary: `Видалено файл «${file.original_name}» з операції ${operationLogRef(file.operation_id, after?.patient)}`,
    details: logDetailsText(fileChanges),
    changedFields: ["attachments"],
    before: {
      id: file.id,
      name: file.original_name,
      type: file.mime_type,
      size: Number(file.size_bytes),
      operationId: file.operation_id,
    },
    after,
    ip: req.clientIp,
    userAgent: req.clientUa,
    ...actorFromReq(req),
  });

  res.json({ ok: true });
});

app.get("/api/attachments/:id", auth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM attachments WHERE id = :id LIMIT 1`,
    { id: req.params.id },
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  await sendStoredFile(req, res, rows[0]);
});

app.get("/api/staff", auth, async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT type, name FROM staff ORDER BY type ASC, sort_order ASC, id ASC`,
  );
  res.json({
    team: rows.filter((row) => row.type === "team").map((row) => row.name),
    anesthesiologists: rows
      .filter((row) => row.type === "anesthesiologists")
      .map((row) => row.name),
  });
});

app.put("/api/staff", auth, async (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: "Staff list is available only for admin" });
  }
  const before = {
    team: [],
    anesthesiologists: [],
  };
  const [existing] = await pool.query(`SELECT type, name FROM staff ORDER BY sort_order ASC, id ASC`);
  before.team = existing.filter((row) => row.type === "team").map((row) => row.name);
  before.anesthesiologists = existing
    .filter((row) => row.type === "anesthesiologists")
    .map((row) => row.name);

  const team = Array.isArray(req.body?.team) ? req.body.team.map((name) => String(name).trim()).filter(Boolean) : before.team;
  const anesthesiologists = Array.isArray(req.body?.anesthesiologists)
    ? req.body.anesthesiologists.map((name) => String(name).trim()).filter(Boolean)
    : before.anesthesiologists;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`DELETE FROM staff`);
    const now = new Date();
    for (const [index, name] of team.entries()) {
      await connection.query(
        `INSERT INTO staff (type, name, sort_order, created_at, updated_at)
         VALUES ('team', :name, :sort_order, :created_at, :updated_at)`,
        { name, sort_order: index, created_at: now, updated_at: now },
      );
    }
    for (const [index, name] of anesthesiologists.entries()) {
      await connection.query(
        `INSERT INTO staff (type, name, sort_order, created_at, updated_at)
         VALUES ('anesthesiologists', :name, :sort_order, :created_at, :updated_at)`,
        { name, sort_order: index, created_at: now, updated_at: now },
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const after = { team, anesthesiologists };
  const changed = diffFields(before, after, ["team", "anesthesiologists"]);
  const staffChanges = describeLogChanges({
    entityType: "staff",
    action: "update",
    before,
    after,
    changedFields: changed,
  });
  await logChange(pool, {
    entityType: "staff",
    entityId: "staff",
    action: "update",
    summary: changed.length ? "Змінено список працівників" : "Оновлено список працівників",
    details: logDetailsText(staffChanges),
    changedFields: changed,
    before,
    after,
    ip: req.clientIp,
    userAgent: req.clientUa,
    ...actorFromReq(req),
  });

  res.json(after);
});

function requireLogsAccess(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: "Logs are available only for admin" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: "Доступ лише для адміністратора." });
  }
  next();
}

function isYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function toStatsYmd(value) {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, "0"),
      String(value.getDate()).padStart(2, "0"),
    ].join("-");
  }
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function bumpCount(map, key, by = 1) {
  const name = String(key || "").trim() || "—";
  map.set(name, (map.get(name) || 0) + by);
}

function sortedCountEntries(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "uk"));
}

function ageBucket(age) {
  if (!Number.isFinite(age)) return null;
  if (age < 18) return "0–17";
  if (age < 30) return "18–29";
  if (age < 45) return "30–44";
  if (age < 60) return "45–59";
  if (age < 75) return "60–74";
  return "75+";
}

app.get("/api/stats", auth, requireAdmin, async (req, res) => {
  try {
    const from = isYmd(req.query.from) ? String(req.query.from) : null;
    const to = isYmd(req.query.to) ? String(req.query.to) : null;
    const yearRaw = Number(req.query.year);
    const year = Number.isFinite(yearRaw) && yearRaw >= 2000 && yearRaw <= 2100
      ? Math.round(yearRaw)
      : null;

    const clauses = [];
    const params = {};
    if (from) {
      clauses.push("date >= :from");
      params.from = from;
    }
    if (to) {
      clauses.push("date <= :to");
      params.to = to;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT date, department, patient, patient_age, blood_group, diagnosis, \`procedure\`,
              team_members, anesthesiologists, infections, patient_flags, status
       FROM operations ${where}`,
      params,
    );

    const primaryCounts = new Map();
    const assistantCounts = new Map();
    const anesCounts = new Map();
    const deptCounts = new Map();
    const statusCounts = new Map();
    const bloodCounts = new Map();
    const ageCounts = new Map();
    const procedureCounts = new Map();
    const infectionCounts = new Map();
    const dayCounts = new Map();
    const patients = new Set();
    let withPrimarySurgeon = 0;
    let withoutPrimarySurgeon = 0;
    let zsuCount = 0;
    let vipCount = 0;
    let ageSum = 0;
    let ageN = 0;
    let ageMin = null;
    let ageMax = null;
    const years = new Set();

    for (const row of rows) {
      const team = parseJson(row.team_members, []);
      const anes = parseJson(row.anesthesiologists, []);
      const infections = parseJson(row.infections, []);
      const flags = parseJson(row.patient_flags, []);
      const primary = Array.isArray(team) && team.length ? String(team[0] || "").trim() : "";
      const date = toStatsYmd(row.date);
      if (date) {
        bumpCount(dayCounts, date);
        years.add(Number(date.slice(0, 4)));
      }

      if (row.patient) patients.add(String(row.patient).trim());
      bumpCount(deptCounts, row.department === "dept2" ? "Хірургічне відділення №2" : "Хірургічне відділення №1");
      bumpCount(statusCounts, row.status || "Очікує огляду");
      if (row.blood_group) bumpCount(bloodCounts, row.blood_group);
      if (row.procedure) bumpCount(procedureCounts, String(row.procedure).trim());

      const age = row.patient_age == null || row.patient_age === "" ? null : Number(row.patient_age);
      if (Number.isFinite(age) && age >= 0) {
        ageSum += age;
        ageN += 1;
        ageMin = ageMin == null ? age : Math.min(ageMin, age);
        ageMax = ageMax == null ? age : Math.max(ageMax, age);
        const bucket = ageBucket(age);
        if (bucket) bumpCount(ageCounts, bucket);
      }

      if (Array.isArray(infections)) {
        for (const item of infections) bumpCount(infectionCounts, item);
      }
      if (Array.isArray(flags)) {
        if (flags.includes("zsu")) zsuCount += 1;
        if (flags.includes("vip")) vipCount += 1;
      }

      if (!primary) {
        withoutPrimarySurgeon += 1;
      } else {
        withPrimarySurgeon += 1;
        bumpCount(primaryCounts, primary);
      }
      if (Array.isArray(team)) {
        for (const member of team.slice(1, 3)) {
          const name = String(member || "").trim();
          if (name) bumpCount(assistantCounts, name);
        }
      }
      if (Array.isArray(anes)) {
        for (const member of anes) {
          const name = String(member || "").trim();
          if (name) bumpCount(anesCounts, name);
        }
      }
    }

    const heatmapYear = year
      || (years.size ? Math.max(...years) : new Date().getFullYear());
    const byDay = [...dayCounts.entries()]
      .filter(([date]) => date.startsWith(`${heatmapYear}-`))
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const ageOrder = ["0–17", "18–29", "30–44", "45–59", "60–74", "75+"];
    const byAge = ageOrder
      .filter((name) => ageCounts.has(name))
      .map((name) => ({ name, count: ageCounts.get(name) }));

    res.json({
      from,
      to,
      year: heatmapYear,
      availableYears: [...years].sort((a, b) => b - a),
      totalOperations: rows.length,
      uniquePatients: patients.size,
      withPrimarySurgeon,
      withoutPrimarySurgeon,
      averageAge: ageN ? Math.round((ageSum / ageN) * 10) / 10 : null,
      ageMin,
      ageMax,
      zsuCount,
      vipCount,
      rule: "Primary surgeon stats use teamMembers[0]. Assistants are positions 2–3.",
      byPrimarySurgeon: sortedCountEntries(primaryCounts),
      byAssistant: sortedCountEntries(assistantCounts),
      byAnesthesiologist: sortedCountEntries(anesCounts),
      byDepartment: sortedCountEntries(deptCounts),
      byStatus: sortedCountEntries(statusCounts),
      byBloodGroup: sortedCountEntries(bloodCounts),
      byAge,
      byProcedure: sortedCountEntries(procedureCounts).slice(0, 20),
      byInfection: sortedCountEntries(infectionCounts),
      byDay,
    });
  } catch (error) {
    console.error("stats failed:", error);
    res.status(500).json({ error: "Не вдалося завантажити статистику." });
  }
});

app.get("/api/users", auth, requireAdmin, async (_req, res) => {
  try {
    res.json(await listUsers(pool));
  } catch (error) {
    console.error("list users failed:", error);
    res.status(500).json({ error: "Не вдалося завантажити користувачів." });
  }
});

app.get("/api/users/:id", auth, requireAdmin, async (req, res) => {
  try {
    const user = await findUserById(pool, req.params.id);
    if (!user) return res.status(404).json({ error: "Користувача не знайдено." });
    res.json(adminUserDetails(user));
  } catch (error) {
    console.error("get user failed:", error);
    res.status(500).json({ error: "Не вдалося завантажити користувача." });
  }
});

app.put("/api/users/:id", auth, requireAdmin, async (req, res) => {
  try {
    const existing = await findUserById(pool, req.params.id);
    if (!existing) return res.status(404).json({ error: "Користувача не знайдено." });

    const name = req.body?.name != null ? String(req.body.name || "").trim() : undefined;
    const email = req.body?.email != null ? normalizeEmail(req.body.email) : undefined;
    const role = req.body?.role != null ? normalizeRole(req.body.role) : undefined;
    const status = req.body?.status != null
      ? (String(req.body.status) === "disabled" ? "disabled" : "active")
      : undefined;
    const password = req.body?.password != null ? String(req.body.password || "") : undefined;

    if (name !== undefined && name.length < 2) {
      return res.status(400).json({ error: "Вкажіть ПІБ або імʼя." });
    }
    if (email !== undefined && !isValidEmail(email)) {
      return res.status(400).json({ error: "Вкажіть коректний email." });
    }
    if (password !== undefined && password !== "" && password.length < 8) {
      return res.status(400).json({ error: "Пароль має містити щонайменше 8 символів." });
    }

    if (email && email !== existing.email) {
      const clash = await findUserByEmail(pool, email);
      if (clash && clash.id !== existing.id) {
        return res.status(409).json({ error: "Користувач із таким email уже існує." });
      }
    }

    const nextRole = role ?? existing.role;
    const nextStatus = status ?? (existing.status || "active");
    const wasActiveAdmin = existing.role === "admin" && existing.status === "active";
    const staysActiveAdmin = nextRole === "admin" && nextStatus === "active";
    if (wasActiveAdmin && !staysActiveAdmin) {
      const admins = await countActiveAdmins(pool);
      if (admins <= 1) {
        return res.status(400).json({
          error: "Не можна зняти або заблокувати останнього активного адміністратора.",
        });
      }
    }

    if (req.user?.id && req.user.id === existing.id && nextStatus === "disabled") {
      return res.status(400).json({ error: "Не можна заблокувати власний акаунт." });
    }

    let passwordHash;
    if (password) passwordHash = await hashPassword(password);

    const updated = await updateUser(pool, existing.id, {
      name,
      email,
      role,
      status,
      passwordHash,
    });

    if (nextStatus === "disabled" || (password && password.length >= 8)) {
      await revokeUserSessions(pool, existing.id);
    }

    try {
      await logChange(pool, {
        entityType: "user",
        entityId: existing.id,
        action: nextStatus === "disabled" && existing.status !== "disabled" ? "ban" : "update",
        summary: `Оновлено користувача ${updated.email}`,
        details: logDetailsText(describeLogChanges({
          entityType: "user",
          action: nextStatus === "disabled" && existing.status !== "disabled" ? "ban" : "update",
          before: adminUserDetails(existing),
          after: adminUserDetails(updated),
          changedFields: ["name", "email", "role", "status", password ? "password" : null].filter(Boolean),
        })),
        changedFields: ["name", "email", "role", "status", password ? "password" : null].filter(Boolean),
        before: adminUserDetails(existing),
        after: adminUserDetails(updated),
        ip: req.clientIp,
        userAgent: req.clientUa,
        ...actorFromReq(req),
      });
    } catch (logError) {
      console.error("user update log failed:", logError);
    }

    res.json(adminUserDetails(updated));
  } catch (error) {
    console.error("update user failed:", error);
    res.status(500).json({ error: "Не вдалося оновити користувача." });
  }
});

app.delete("/api/users/:id", auth, requireAdmin, async (req, res) => {
  try {
    const existing = await findUserById(pool, req.params.id);
    if (!existing) return res.status(404).json({ error: "Користувача не знайдено." });

    if (req.user?.id && req.user.id === existing.id) {
      return res.status(400).json({ error: "Не можна видалити власний акаунт." });
    }

    if (existing.role === "admin" && existing.status === "active") {
      const admins = await countActiveAdmins(pool);
      if (admins <= 1) {
        return res.status(400).json({ error: "Не можна видалити останнього активного адміністратора." });
      }
    }

    await deleteUser(pool, existing.id);

    try {
      await logChange(pool, {
        entityType: "user",
        entityId: existing.id,
        action: "delete",
        summary: `Видалено користувача ${existing.email}`,
        details: logDetailsText(describeLogChanges({
          entityType: "user",
          action: "delete",
          before: adminUserDetails(existing),
          after: null,
        })),
        changedFields: [],
        before: adminUserDetails(existing),
        after: null,
        ip: req.clientIp,
        userAgent: req.clientUa,
        ...actorFromReq(req),
      });
    } catch (logError) {
      console.error("user delete log failed:", logError);
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("delete user failed:", error);
    res.status(500).json({ error: "Не вдалося видалити користувача." });
  }
});

app.get("/api/logs/changes", auth, requireLogsAccess, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const [rows] = await pool.query(
    `SELECT id, entity_type, entity_id, action, summary, details, changed_fields, before_json, after_json,
            actor_user_id, actor_name, actor_email, ip, geo, user_agent, created_at
     FROM change_logs
     ORDER BY created_at DESC
     LIMIT ${limit}`,
  );
  const mapped = rows.map((row) => {
    const before = parseJson(row.before_json, null);
    const after = parseJson(row.after_json, null);
    const changedFields = parseJson(row.changed_fields, []);
    const patient = logPatientName(before, after);
    let changes = describeLogChanges({
      entityType: row.entity_type,
      action: row.action,
      before,
      after,
      changedFields,
    });
    if (!changes.length && row.details) {
      changes = String(row.details).split("\n").map((line) => line.trim()).filter(Boolean)
        .map((text) => ({ text }));
    }
    return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    summary: summaryWithPatient(row.summary, patient, row.entity_id),
    details: changes.map((item) => item.text).join("\n"),
    changes,
    patient,
    doctors: logDoctorNames(row.entity_type, before, after, row.actor_name),
    changedFields,
    actorUserId: row.actor_user_id || null,
    actorName: row.actor_name || null,
    actorEmail: row.actor_email || null,
    ip: row.ip,
    geo: row.geo,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    };
  });
  res.json(await attachGeo(mapped));
});

app.get("/api/logs/access", auth, requireLogsAccess, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const [rows] = await pool.query(
    `SELECT id, event, ip, geo, user_agent, details, created_at
     FROM access_logs
     ORDER BY created_at DESC
     LIMIT ${limit}`,
  );
  const mapped = rows.map((row) => ({
    id: row.id,
    event: row.event,
    ip: row.ip,
    geo: row.geo,
    userAgent: row.user_agent,
    details: parseJson(row.details, null),
    createdAt: row.created_at,
  }));
  res.json(await attachGeo(mapped));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Файл завеликий. Максимум 512 МБ." });
    }
    return res.status(400).json({ error: `Помилка завантаження: ${error.message}` });
  }
  if (String(error.message || "").includes("Only image and video")) {
    return res.status(400).json({ error: "Дозволені лише зображення та відео." });
  }
  res.status(500).json({ error: error.message || "Server error" });
});

try {
  await waitForDatabase(pool);
  await migrate(pool);
  await seedStaff(pool);
  const admin = await ensureAdminUser(pool);
  if (admin) {
    console.log(`Admin account ready: ${admin.email}`);
  }
} catch (error) {
  console.error("Fatal: database bootstrap failed:", error);
  process.exit(1);
}

try {
  await runArchiveMaintenance(true);
} catch (error) {
  // Do not block API startup / login if archive job fails.
  console.error("Archive maintenance at boot failed:", error);
}

setInterval(() => {
  runArchiveMaintenance(true).catch((error) => {
    console.error("Archive maintenance failed:", error);
  });
}, ARCHIVE_JOB_MS);

app.listen(PORT, () => {
  console.log(`API listening on http://127.0.0.1:${PORT}`);
  console.log(
    `Archive: keep all operations forever; restore any archived on boot (${ARCHIVE_TZ})`,
  );
});
