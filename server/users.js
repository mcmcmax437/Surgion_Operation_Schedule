import crypto from "crypto";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";

const scrypt = promisify(crypto.scrypt);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export function normalizeEmail(email = "") {
  return String(email || "").trim().toLowerCase();
}

export function isValidEmail(email = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${salt}$${Buffer.from(derived).toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const raw = String(stored || "");
  const parts = raw.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hashHex] = parts;
  if (!salt || !hashHex) return false;
  const derived = await scrypt(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  const left = Buffer.from(derived);
  const right = Buffer.from(hashHex, "hex");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role === "admin" ? "admin" : "doctor",
    status: row.status || "active",
  };
}

export function adminUserDetails(row) {
  if (!row) return null;
  return {
    ...publicUser(row),
    hasPassword: Boolean(row.password_hash),
    googleLinked: Boolean(row.google_sub),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export async function listUsers(pool) {
  const [rows] = await pool.query(
    `SELECT * FROM users ORDER BY created_at ASC, email ASC`,
  );
  return rows.map(adminUserDetails);
}

export async function updateUser(pool, id, {
  name,
  email,
  role,
  status,
  passwordHash = undefined,
}) {
  const existing = await findUserById(pool, id);
  if (!existing) return null;

  const nextName = name != null ? String(name || "").trim() : existing.name;
  const nextEmail = email != null ? normalizeEmail(email) : existing.email;
  const nextRole = role != null
    ? (role === "admin" ? "admin" : "doctor")
    : existing.role;
  const nextStatus = status != null
    ? (status === "disabled" ? "disabled" : "active")
    : (existing.status || "active");

  await pool.query(
    `UPDATE users
     SET name = :name,
         email = :email,
         role = :role,
         status = :status,
         password_hash = COALESCE(:password_hash, password_hash),
         updated_at = :updated_at
     WHERE id = :id`,
    {
      id,
      name: nextName,
      email: nextEmail,
      role: nextRole,
      status: nextStatus,
      password_hash: passwordHash === undefined ? null : passwordHash,
      updated_at: new Date(),
    },
  );
  return findUserById(pool, id);
}

export async function deleteUser(pool, id) {
  await pool.query(`DELETE FROM sessions WHERE user_id = :id`, { id });
  const [result] = await pool.query(`DELETE FROM users WHERE id = :id`, { id });
  return Number(result?.affectedRows || 0) > 0;
}

export async function revokeUserSessions(pool, userId) {
  if (!userId) return;
  await pool.query(`DELETE FROM sessions WHERE user_id = :id`, { id: userId });
}

export async function findUserByEmail(pool, email) {
  const [rows] = await pool.query(
    `SELECT * FROM users WHERE email = :email LIMIT 1`,
    { email: normalizeEmail(email) },
  );
  return rows[0] || null;
}

export async function findUserById(pool, id) {
  if (!id) return null;
  const [rows] = await pool.query(
    `SELECT * FROM users WHERE id = :id LIMIT 1`,
    { id },
  );
  return rows[0] || null;
}

export async function findUserByGoogleSub(pool, googleSub) {
  if (!googleSub) return null;
  const [rows] = await pool.query(
    `SELECT * FROM users WHERE google_sub = :google_sub LIMIT 1`,
    { google_sub: String(googleSub) },
  );
  return rows[0] || null;
}

export async function createUser(pool, {
  email,
  name,
  passwordHash = null,
  googleSub = null,
  role = "doctor",
  status = "active",
}) {
  const now = new Date();
  const id = uuidv4();
  await pool.query(
    `INSERT INTO users
      (id, email, name, password_hash, google_sub, role, status, created_at, updated_at)
     VALUES
      (:id, :email, :name, :password_hash, :google_sub, :role, :status, :created_at, :updated_at)`,
    {
      id,
      email: normalizeEmail(email),
      name: String(name || "").trim(),
      password_hash: passwordHash,
      google_sub: googleSub || null,
      role: role === "admin" ? "admin" : "doctor",
      status: status === "disabled" ? "disabled" : "active",
      created_at: now,
      updated_at: now,
    },
  );
  return findUserById(pool, id);
}

export async function linkGoogleSub(pool, userId, googleSub) {
  await pool.query(
    `UPDATE users
     SET google_sub = :google_sub, updated_at = :updated_at
     WHERE id = :id`,
    { id: userId, google_sub: String(googleSub), updated_at: new Date() },
  );
}

export async function countActiveAdmins(pool) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'`,
  );
  return Number(rows[0]?.count || 0);
}

export async function ensureAdminUser(pool) {
  const email = normalizeEmail(process.env.ADMIN_EMAIL || "");
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!email || !password) return null;

  const existing = await findUserByEmail(pool, email);
  if (existing) {
    if (existing.role !== "admin" || existing.status !== "active") {
      await pool.query(
        `UPDATE users SET role = 'admin', status = 'active', updated_at = :updated_at WHERE id = :id`,
        { id: existing.id, updated_at: new Date() },
      );
      return findUserById(pool, existing.id);
    }
    return existing;
  }

  const passwordHash = await hashPassword(password);
  const name = String(process.env.ADMIN_NAME || "Адміністратор").trim() || "Адміністратор";
  return createUser(pool, {
    email,
    name,
    passwordHash,
    role: "admin",
    status: "active",
  });
}
