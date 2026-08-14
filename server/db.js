import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      `ALTER TABLE operations ADD COLUMN queue_no INT NOT NULL DEFAULT 1 AFTER time`,
    );
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

  const [groups] = await pool.query(
    `SELECT date, department, COUNT(*) AS c, SUM(queue_no = 1) AS ones
     FROM operations
     WHERE date IS NOT NULL
     GROUP BY date, department
     HAVING c > 1 AND ones = c`,
  );
  for (const group of groups) {
    const [rows] = await pool.query(
      `SELECT id FROM operations
       WHERE date = :date AND department = :department
       ORDER BY created_at ASC, id ASC`,
      { date: group.date, department: group.department },
    );
    for (const [index, row] of rows.entries()) {
      await pool.query(`UPDATE operations SET queue_no = :queue_no WHERE id = :id`, {
        queue_no: index + 1,
        id: row.id,
      });
    }
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
    queueNo: Number(row.queue_no || 1),
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
      name: file.original_name,
      type: file.mime_type,
      size: Number(file.size_bytes),
    })),
  };
}
