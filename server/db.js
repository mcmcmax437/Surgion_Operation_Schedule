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

export async function migrate(pool) {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const statements = schema
    .split(/;\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const statement of statements) {
    await pool.query(statement);
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
  return {
    id: row.id,
    date: row.date || "",
    time: row.time ? String(row.time).slice(0, 5) : "",
    patient: row.patient,
    birthDate: row.birth_date || "",
    bloodGroup: row.blood_group || "",
    diagnosis: row.diagnosis || "",
    procedure: row.procedure || "",
    teamMembers: parseJson(row.team_members, []),
    anesthesiologists: parseJson(row.anesthesiologists, []),
    status: row.status,
    notes: row.notes || "",
    isExample: Boolean(row.is_example),
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
