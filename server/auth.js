import crypto from "crypto";

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || "";
}

export function normalizeIp(ip = "") {
  return String(ip).trim().replace(/^::ffff:/i, "");
}

export function isPrivateIp(ip = "") {
  const value = normalizeIp(ip);
  if (!value) return true;
  if (value === "::1" || value === "localhost") return true;
  if (value.includes(":")) {
    const lower = value.toLowerCase();
    return lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd");
  }
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

const geoCache = new Map();
const GEO_OK_MS = 7 * 24 * 60 * 60 * 1000;
const GEO_FAIL_MS = 10 * 60 * 1000;

function formatGeoLabel(data) {
  const city = data.city || data.region || "";
  const country = data.country || "";
  const parts = [...new Set([city, country].filter(Boolean))];
  return parts.join(", ") || null;
}

export async function lookupGeo(ip) {
  const value = normalizeIp(ip);
  if (!value) return null;

  const cached = geoCache.get(value);
  if (cached && cached.expires > Date.now()) return cached.label;

  if (isPrivateIp(value)) {
    const label = "Локальна мережа";
    geoCache.set(value, { label, expires: Date.now() + GEO_OK_MS });
    return label;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(value)}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    const data = await response.json();
    const label = data?.success === false ? null : formatGeoLabel(data || {});
    geoCache.set(value, {
      label,
      expires: Date.now() + (label ? GEO_OK_MS : GEO_FAIL_MS),
    });
    return label;
  } catch {
    geoCache.set(value, { label: null, expires: Date.now() + GEO_FAIL_MS });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function attachGeo(rows) {
  const ips = [...new Set(rows.map((row) => normalizeIp(row.ip)).filter(Boolean))];
  await Promise.all(ips.map((ip) => lookupGeo(ip)));
  return rows.map((row) => ({
    ...row,
    geo: row.geo || (geoCache.get(normalizeIp(row.ip))?.label ?? null),
  }));
}

export function logsAllowedIps() {
  const fromEnv = String(process.env.LOGS_ALLOWED_IPS || "212.75.114.136")
    .split(",")
    .map((item) => normalizeIp(item))
    .filter(Boolean);
  return fromEnv.length ? fromEnv : ["212.75.114.136"];
}

export function canViewLogs(ip) {
  return logsAllowedIps().includes(normalizeIp(ip));
}

export function userAgent(req) {
  return String(req.headers["user-agent"] || "").slice(0, 512);
}

export function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

export async function logAccess(pool, { event, ip, userAgent: ua, details = null }) {
  const geo = await lookupGeo(ip);
  await pool.query(
    `INSERT INTO access_logs (event, ip, geo, user_agent, details, created_at)
     VALUES (:event, :ip, :geo, :user_agent, :details, :created_at)`,
    {
      event,
      ip,
      geo,
      user_agent: ua,
      details: details ? JSON.stringify(details) : null,
      created_at: new Date(),
    },
  );
}

export function diffFields(before, after, fields) {
  const changed = [];
  for (const field of fields) {
    const left = JSON.stringify(before?.[field] ?? null);
    const right = JSON.stringify(after?.[field] ?? null);
    if (left !== right) changed.push(field);
  }
  return changed;
}

export async function logChange(pool, {
  entityType,
  entityId,
  action,
  summary,
  changedFields = null,
  before = null,
  after = null,
  ip,
  userAgent: ua,
}) {
  const geo = await lookupGeo(ip);
  await pool.query(
    `INSERT INTO change_logs
      (entity_type, entity_id, action, summary, changed_fields, before_json, after_json, ip, geo, user_agent, created_at)
     VALUES
      (:entity_type, :entity_id, :action, :summary, :changed_fields, :before_json, :after_json, :ip, :geo, :user_agent, :created_at)`,
    {
      entity_type: entityType,
      entity_id: entityId,
      action,
      summary,
      changed_fields: changedFields ? JSON.stringify(changedFields) : null,
      before_json: before ? JSON.stringify(before) : null,
      after_json: after ? JSON.stringify(after) : null,
      ip,
      geo,
      user_agent: ua,
      created_at: new Date(),
    },
  );
}

export function requestToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7);
  if (req.method === "GET" && /^\/api\/attachments\//.test(req.path || req.originalUrl || "")) {
    const queryToken = req.query?.access_token || req.query?.token;
    if (queryToken) return String(queryToken);
  }
  return "";
}

export function requireAuth(pool) {
  return async (req, res, next) => {
    const token = requestToken(req);
    if (!token) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const [rows] = await pool.query(
      `SELECT token, expires_at FROM sessions WHERE token = :token LIMIT 1`,
      { token },
    );
    if (!rows.length || new Date(rows[0].expires_at) < new Date()) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const sessionDays = Number(process.env.SESSION_DAYS || 365);
    const now = new Date();
    const expires = new Date(now.getTime() + sessionDays * 24 * 60 * 60 * 1000);
    await pool.query(
      `UPDATE sessions SET last_seen_at = :now, expires_at = :expires WHERE token = :token`,
      { now, expires, token },
    );

    req.sessionToken = token;
    req.clientIp = clientIp(req);
    req.clientUa = userAgent(req);
    next();
  };
}
