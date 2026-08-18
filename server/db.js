import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME_BY_EXT = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".3gp": "video/3gpp",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

export function decodeOriginalName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "file";
  if (/[А-Яа-яІіЇїЄєҐґЁё]/.test(raw)) return raw;
  try {
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    if (decoded.includes("\uFFFD")) return raw;
    if (/[А-Яа-яІіЇїЄєҐґЁё]/.test(decoded)) return decoded;
  } catch {
    // keep original
  }
  return raw;
}

export function guessMime(name, fallback = "application/octet-stream") {
  const ext = path.extname(decodeOriginalName(name)).toLowerCase();
  const fromName = MIME_BY_EXT[ext];
  const type = String(fallback || "").toLowerCase();
  if (fromName && (!type || type === "application/octet-stream" || type === "binary/octet-stream")) {
    return fromName;
  }
  if (type.startsWith("video/") || type.startsWith("image/")) return type;
  return fromName || fallback || "application/octet-stream";
}

export function createPool() {
  return mysql.createPool({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "surgion_schedule",
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true,
    dateStrings: true,
  });
}

async function columnExists(pool, table, column) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = :table
       AND COLUMN_NAME = :column`,
    { table, column },
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function indexExists(pool, table, indexName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = :table
       AND INDEX_NAME = :indexName`,
    { table, indexName },
  );
  return Number(rows[0]?.count || 0) > 0;
}

export async function migrate(pool) {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const statements = schema
    .split(/;\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await pool.query(statement);
  }

  if (!(await columnExists(pool, "operations", "archived_at"))) {
    await pool.query(
      `ALTER TABLE operations ADD COLUMN archived_at DATETIME(3) NULL AFTER is_example`,
    );
  }
  if (!(await indexExists(pool, "operations", "idx_operations_archived_at"))) {
    await pool.query(
      `ALTER TABLE operations ADD INDEX idx_operations_archived_at (archived_at)`,
    );
  }
  if (!(await indexExists(pool, "operations", "idx_operations_date"))) {
    await pool.query(`ALTER TABLE operations ADD INDEX idx_operations_date (date)`);
  }
  if (!(await columnExists(pool, "operations", "department"))) {
    await pool.query(
      `ALTER TABLE operations ADD COLUMN department VARCHAR(16) NOT NULL DEFAULT 'dept1' AFTER time`,
    );
  }
  if (!(await columnExists(pool, "operations", "queue_no"))) {
    await pool.query(
      `ALTER TABLE operations ADD COLUMN queue_no INT NULL AFTER time`,
    );
  } else {
    await pool.query(`ALTER TABLE operations MODIFY COLUMN queue_no INT NULL`);
  }
  if (!(await columnExists(pool, "operations", "patient_age"))) {
    await pool.query(
      `ALTER TABLE operations ADD COLUMN patient_age INT NULL AFTER birth_date`,
    );
  }
  if (!(await columnExists(pool, "operations", "infections"))) {
    await pool.query(
      `ALTER TABLE operations ADD COLUMN infections JSON NULL AFTER anesthesiologists`,
    );
  }
  if (!(await indexExists(pool, "operations", "idx_operations_dept_date"))) {
    await pool.query(
      `ALTER TABLE operations ADD INDEX idx_operations_dept_date (department, date, queue_no)`,
    );
  }
  if (!(await columnExists(pool, "access_logs", "geo"))) {
    await pool.query(`ALTER TABLE access_logs ADD COLUMN geo VARCHAR(255) NULL AFTER ip`);
  }
  if (!(await columnExists(pool, "change_logs", "geo"))) {
    await pool.query(`ALTER TABLE change_logs ADD COLUMN geo VARCHAR(255) NULL AFTER ip`);
  }
}

export async function seedStaff(pool) {
  const [rows] = await pool.query("SELECT COUNT(*) AS count FROM staff");
  if (rows[0].count > 0) return;

  const now = new Date();
  const team = [
    "Ковальчук Олександр Петрович",
    "Мельник Ірина Вікторівна",
    "Бондаренко Андрій Сергійович",
    "Шевченко Наталія Олегівна",
    "Ткаченко Дмитро Ігорович",
  ];
  const anesthesiologists = [
    "Петренко Олена Володимирівна",
    "Савчук Роман Олександрович",
    "Лисенко Марія Ігорівна",
  ];

  for (const [index, name] of team.entries()) {
    await pool.query(
      `INSERT INTO staff (type, name, sort_order, created_at, updated_at)
       VALUES ('team', :name, :sort_order, :created_at, :updated_at)`,
      { name, sort_order: index, created_at: now, updated_at: now },
    );
  }
  for (const [index, name] of anesthesiologists.entries()) {
    await pool.query(
      `INSERT INTO staff (type, name, sort_order, created_at, updated_at)
       VALUES ('anesthesiologists', :name, :sort_order, :created_at, :updated_at)`,
      { name, sort_order: index, created_at: now, updated_at: now },
    );
  }
}

export function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function mapOperation(row, attachments = []) {
  const infections = parseJson(row.infections, []);
  return {
    id: row.id,
    date: row.date || "",
    time: row.time ? String(row.time).slice(0, 5) : "",
    queueNo: row.queue_no == null || row.queue_no === "" ? null : Number(row.queue_no),
    department: row.department === "dept2" ? "dept2" : "dept1",
    patient: row.patient,
    birthDate: row.birth_date || "",
    patientAge: row.patient_age == null || row.patient_age === "" ? "" : Number(row.patient_age),
    bloodGroup: row.blood_group || "",
    diagnosis: row.diagnosis || "",
    procedure: row.procedure || "",
    teamMembers: parseJson(row.team_members, []),
    anesthesiologists: parseJson(row.anesthesiologists, []),
    infections: Array.isArray(infections) ? infections : [],
    status: row.status,
    notes: row.notes || "",
    isExample: Boolean(row.is_example),
    archivedAt: row.archived_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments: attachments.map((file) => ({
      id: file.id,
      name: decodeOriginalName(file.original_name),
      type: guessMime(file.original_name, file.mime_type),
      size: Number(file.size_bytes),
    })),
  };
}
