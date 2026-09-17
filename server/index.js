import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import cors from "cors";
import multer from "multer";
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
    const imageExt = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name);
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
app.use(express.json({ limit: "2mb" }));

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
    teamMembers: Array.isArray(teamMembers) ? teamMembers.slice(0, 3) : [],
    anesthesiologists: Array.isArray(anesthesiologists) ? anesthesiologists.slice(0, 1) : [],
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

function sendStoredFile(req, res, file) {
  const full = path.join(uploadsDir, file.storage_path);
  if (!fs.existsSync(full)) {
    res.status(404).json({ error: "File missing" });
    return;
  }

  const downloadName = decodeOriginalName(file.original_name);
  const mime = guessMime(downloadName, file.mime_type);
  const stat = fs.statSync(full);
  const size = stat.size;
  const range = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mime);
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  );
  res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

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

  await logChange(pool, {
    entityType: "operation",
    entityId: id,
    action: meta.action || "delete",
    summary: meta.summary || `Видалено операцію ${id} (${before.patient})`,
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
      if (!isValidEmail(email) || !password) {
        return res.status(400).json({ error: "Вкажіть email і пароль." });
      }
      const user = await findUserByEmail(pool, email);
      if (!user || user.status !== "active" || !user.password_hash) {
        await logAccess(pool, { event: "login_fail", ip, userAgent: ua, details: { email, method: "password" } }).catch(() => {});
        return res.status(401).json({ error: "Невірний email або пароль." });
      }
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        await logAccess(pool, { event: "login_fail", ip, userAgent: ua, details: { email, method: "password" } }).catch(() => {});
        return res.status(401).json({ error: "Невірний email або пароль." });
      }
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
    if (!hasSharedPassword || password !== ACCESS_PASSWORD) {
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

    for (const file of req.files || []) {
      await connection.query(
        `INSERT INTO attachments
          (id, operation_id, original_name, mime_type, size_bytes, storage_path, created_at)
         VALUES
          (:id, :operation_id, :original_name, :mime_type, :size_bytes, :storage_path, :created_at)`,
        {
          id: uuidv4(),
          operation_id: id,
          original_name: fileMeta(file).originalName,
          mime_type: fileMeta(file).mimeType,
          size_bytes: file.size,
          storage_path: file.filename,
          created_at: now,
        },
      );
    }

    const created = await loadOperation(connection, id);
    await connection.commit();

    await logChange(pool, {
      entityType: "operation",
      entityId: id,
      action: "create",
      summary: `Додано операцію ${id} (${data.patient})`,
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

    for (const file of req.files || []) {
      await connection.query(
        `INSERT INTO attachments
          (id, operation_id, original_name, mime_type, size_bytes, storage_path, created_at)
         VALUES
          (:id, :operation_id, :original_name, :mime_type, :size_bytes, :storage_path, :created_at)`,
        {
          id: uuidv4(),
          operation_id: req.params.id,
          original_name: fileMeta(file).originalName,
          mime_type: fileMeta(file).mimeType,
          size_bytes: file.size,
          storage_path: file.filename,
          created_at: now,
        },
      );
    }

    const after = await loadOperation(connection, req.params.id);
    await connection.commit();

    const fields = [
      "date", "queueNo", "department", "patient", "patientAge", "bloodGroup", "diagnosis",
      "procedure", "teamMembers", "anesthesiologists", "infections", "patientFlags", "notes", "attachments",
    ];
    const changed = diffFields(before, after, fields);

    await logChange(pool, {
      entityType: "operation",
      entityId: req.params.id,
      action: "update",
      summary: changed.length
        ? `Змінено операцію ${req.params.id}: ${changed.join(", ")}`
        : `Оновлено операцію ${req.params.id}`,
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

  await logChange(pool, {
    entityType: "attachment",
    entityId: file.id,
    action: "delete",
    summary: `Видалено файл «${file.original_name}» з операції ${file.operation_id}`,
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
  sendStoredFile(req, res, rows[0]);
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
  await logChange(pool, {
    entityType: "staff",
    entityId: "staff",
    action: "update",
    summary: changed.length
      ? `Змінено список працівників: ${changed.join(", ")}`
      : "Оновлено список працівників",
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
    const role = req.body?.role != null
      ? (String(req.body.role) === "admin" ? "admin" : "doctor")
      : undefined;
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
    `SELECT id, entity_type, entity_id, action, summary, changed_fields, before_json, after_json,
            actor_user_id, actor_name, actor_email, ip, geo, user_agent, created_at
     FROM change_logs
     ORDER BY created_at DESC
     LIMIT ${limit}`,
  );
  const mapped = rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    summary: row.summary,
    changedFields: parseJson(row.changed_fields, []),
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    actorUserId: row.actor_user_id || null,
    actorName: row.actor_name || null,
    actorEmail: row.actor_email || null,
    ip: row.ip,
    geo: row.geo,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  }));
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
