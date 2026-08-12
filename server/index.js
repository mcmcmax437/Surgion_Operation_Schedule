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
  migrate,
  seedStaff,
  mapOperation,
  parseJson,
} from "./db.js";
import {
  clientIp,
  userAgent,
  newToken,
  logAccess,
  logChange,
  diffFields,
  requireAuth,
  canViewLogs,
} from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const uploadsDir = path.join(rootDir, "uploads");
const PORT = Number(process.env.PORT || 3001);
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 7);

if (!ACCESS_PASSWORD) {
  console.error("ACCESS_PASSWORD is required in .env");
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
      const ext = path.extname(file.originalname || "").slice(0, 20);
      cb(null, `${uuidv4()}${ext}`);
    },
  }),
  limits: { fileSize: 512 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    const name = String(file.originalname || "").toLowerCase();
    const videoExt = /\.(mp4|mov|m4v|webm|avi|mkv|3gp|mpeg|mpg)$/i.test(name);
    const imageExt = /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(name);
    if (mime.startsWith("image/") || mime.startsWith("video/") || videoExt || imageExt) {
      cb(null, true);
      return;
    }
    cb(new Error("Only image and video files are allowed"));
  },
});

app.set("trust proxy", true);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

function bodyToOperation(body) {
  const teamMembers = Array.isArray(body.teamMembers)
    ? body.teamMembers
    : parseJson(body.teamMembers, []);
  const anesthesiologists = Array.isArray(body.anesthesiologists)
    ? body.anesthesiologists
    : parseJson(body.anesthesiologists, []);

  return {
    date: body.date || null,
    time: body.time || null,
    patient: String(body.patient || "").trim(),
    birthDate: body.birthDate || null,
    bloodGroup: body.bloodGroup || null,
    diagnosis: String(body.diagnosis || "").trim(),
    procedure: String(body.procedure || "").trim(),
    teamMembers,
    anesthesiologists,
    status: body.status || "Заплановано",
    notes: String(body.notes || "").trim(),
  };
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/session", auth, async (req, res) => {
  res.json({
    ip: req.clientIp,
    canViewLogs: canViewLogs(req.clientIp),
  });
});

app.post("/api/login", async (req, res) => {
  const ip = clientIp(req);
  const ua = userAgent(req);
  const password = String(req.body?.password || "");

  if (password !== ACCESS_PASSWORD) {
    await logAccess(pool, {
      event: "login_fail",
      ip,
      userAgent: ua,
    });
    return res.status(401).json({ error: "Invalid password" });
  }

  const token = newToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO sessions (token, ip, user_agent, created_at, last_seen_at, expires_at)
     VALUES (:token, :ip, :user_agent, :created_at, :last_seen_at, :expires_at)`,
    {
      token,
      ip,
      user_agent: ua,
      created_at: now,
      last_seen_at: now,
      expires_at: expires,
    },
  );

  await logAccess(pool, {
    event: "login_success",
    ip,
    userAgent: ua,
    details: { expiresAt: expires.toISOString() },
  });

  res.json({ token, expiresAt: expires.toISOString() });
});

app.post("/api/logout", auth, async (req, res) => {
  await pool.query(`DELETE FROM sessions WHERE token = :token`, {
    token: req.sessionToken,
  });
  await logAccess(pool, {
    event: "logout",
    ip: req.clientIp,
    userAgent: req.clientUa,
  });
  res.json({ ok: true });
});

app.get("/api/operations", auth, async (_req, res) => {
  const [rows] = await pool.query(`SELECT * FROM operations ORDER BY date IS NULL, date ASC, time ASC`);
  const result = [];
  for (const row of rows) {
    const attachments = await loadAttachments(pool, row.id);
    result.push(mapOperation(row, attachments));
  }
  res.json(result);
});

app.post("/api/operations", auth, upload.array("files", 12), async (req, res) => {
  const data = bodyToOperation(req.body);
  if (!data.date || !data.patient || !data.procedure) {
    return res.status(400).json({ error: "date, patient and procedure are required" });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const id = await nextOperationId(connection);
    const now = new Date();

    await connection.query(
      `INSERT INTO operations
        (id, date, time, patient, birth_date, blood_group, diagnosis, \`procedure\`,
         team_members, anesthesiologists, status, notes, is_example, created_at, updated_at)
       VALUES
        (:id, :date, :time, :patient, :birth_date, :blood_group, :diagnosis, :procedure,
         :team_members, :anesthesiologists, :status, :notes, 0, :created_at, :updated_at)`,
      {
        id,
        date: data.date,
        time: data.time || null,
        patient: data.patient,
        birth_date: data.birthDate || null,
        blood_group: data.bloodGroup || null,
        diagnosis: data.diagnosis || null,
        procedure: data.procedure,
        team_members: JSON.stringify(data.teamMembers),
        anesthesiologists: JSON.stringify(data.anesthesiologists),
        status: data.status,
        notes: data.notes || null,
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
          original_name: file.originalname,
          mime_type: file.mimetype,
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
    });

    res.status(201).json(created);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
});

app.put("/api/operations/:id", auth, upload.array("files", 12), async (req, res) => {
  const data = bodyToOperation(req.body);
  if (!data.date || !data.patient || !data.procedure) {
    return res.status(400).json({ error: "date, patient and procedure are required" });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const before = await loadOperation(connection, req.params.id);
    if (!before) {
      await connection.rollback();
      return res.status(404).json({ error: "Not found" });
    }

    const now = new Date();
    await connection.query(
      `UPDATE operations SET
        date = :date,
        time = :time,
        patient = :patient,
        birth_date = :birth_date,
        blood_group = :blood_group,
        diagnosis = :diagnosis,
        \`procedure\` = :procedure,
        team_members = :team_members,
        anesthesiologists = :anesthesiologists,
        status = :status,
        notes = :notes,
        updated_at = :updated_at
       WHERE id = :id`,
      {
        id: req.params.id,
        date: data.date,
        time: data.time || null,
        patient: data.patient,
        birth_date: data.birthDate || null,
        blood_group: data.bloodGroup || null,
        diagnosis: data.diagnosis || null,
        procedure: data.procedure,
        team_members: JSON.stringify(data.teamMembers),
        anesthesiologists: JSON.stringify(data.anesthesiologists),
        status: data.status,
        notes: data.notes || null,
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
          original_name: file.originalname,
          mime_type: file.mimetype,
          size_bytes: file.size,
          storage_path: file.filename,
          created_at: now,
        },
      );
    }

    const after = await loadOperation(connection, req.params.id);
    await connection.commit();

    const fields = [
      "date", "time", "patient", "birthDate", "bloodGroup", "diagnosis",
      "procedure", "teamMembers", "anesthesiologists", "status", "notes", "attachments",
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
  const before = await loadOperation(pool, req.params.id);
  if (!before) return res.status(404).json({ error: "Not found" });

  const [files] = await pool.query(
    `SELECT storage_path FROM attachments WHERE operation_id = :id`,
    { id: req.params.id },
  );

  await pool.query(`DELETE FROM operations WHERE id = :id`, { id: req.params.id });

  for (const file of files) {
    const full = path.join(uploadsDir, file.storage_path);
    fs.promises.unlink(full).catch(() => {});
  }

  await logChange(pool, {
    entityType: "operation",
    entityId: req.params.id,
    action: "delete",
    summary: `Видалено операцію ${req.params.id} (${before.patient})`,
    before,
    ip: req.clientIp,
    userAgent: req.clientUa,
  });

  res.json({ ok: true });
});

app.get("/api/attachments/:id", auth, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM attachments WHERE id = :id LIMIT 1`,
    { id: req.params.id },
  );
  if (!rows.length) return res.status(404).json({ error: "Not found" });

  const file = rows[0];
  const full = path.join(uploadsDir, file.storage_path);
  if (!fs.existsSync(full)) return res.status(404).json({ error: "File missing" });

  res.setHeader("Content-Type", file.mime_type);
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(file.original_name)}`,
  );
  fs.createReadStream(full).pipe(res);
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
  });

  res.json(after);
});

function requireLogsAccess(req, res, next) {
  if (!canViewLogs(req.clientIp)) {
    return res.status(403).json({ error: "Logs are available only for allowed IP" });
  }
  next();
}

app.get("/api/logs/changes", auth, requireLogsAccess, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const [rows] = await pool.query(
    `SELECT id, entity_type, entity_id, action, summary, changed_fields, before_json, after_json, ip, user_agent, created_at
     FROM change_logs
     ORDER BY created_at DESC
     LIMIT ${limit}`,
  );
  res.json(rows.map((row) => ({
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    summary: row.summary,
    changedFields: parseJson(row.changed_fields, []),
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  })));
});

app.get("/api/logs/access", auth, requireLogsAccess, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const [rows] = await pool.query(
    `SELECT id, event, ip, user_agent, details, created_at
     FROM access_logs
     ORDER BY created_at DESC
     LIMIT ${limit}`,
  );
  res.json(rows.map((row) => ({
    id: row.id,
    event: row.event,
    ip: row.ip,
    userAgent: row.user_agent,
    details: parseJson(row.details, null),
    createdAt: row.created_at,
  })));
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

await migrate(pool);
await seedStaff(pool);

app.listen(PORT, () => {
  console.log(`API listening on http://127.0.0.1:${PORT}`);
});
