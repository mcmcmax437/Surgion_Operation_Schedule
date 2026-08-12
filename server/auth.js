import crypto from "crypto";

export function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || "";
}

export function userAgent(req) {
  return String(req.headers["user-agent"] || "").slice(0, 512);
}

export function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

export async function logAccess(pool, { event, ip, userAgent: ua, details = null }) {
  await pool.query(
    `INSERT INTO access_logs (event, ip, user_agent, details, created_at)
     VALUES (:event, :ip, :user_agent, :details, :created_at)`,
    {
      event,
      ip,
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
  await pool.query(
    `INSERT INTO change_logs
      (entity_type, entity_id, action, summary, changed_fields, before_json, after_json, ip, user_agent, created_at)
     VALUES
      (:entity_type, :entity_id, :action, :summary, :changed_fields, :before_json, :after_json, :ip, :user_agent, :created_at)`,
    {
      entity_type: entityType,
      entity_id: entityId,
      action,
      summary,
      changed_fields: changedFields ? JSON.stringify(changedFields) : null,
      before_json: before ? JSON.stringify(before) : null,
      after_json: after ? JSON.stringify(after) : null,
      ip,
      user_agent: ua,
      created_at: new Date(),
    },
  );
}

export function requireAuth(pool) {
  return async (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
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

    await pool.query(
      `UPDATE sessions SET last_seen_at = :now WHERE token = :token`,
      { now: new Date(), token },
    );

    req.sessionToken = token;
    req.clientIp = clientIp(req);
    req.clientUa = userAgent(req);
    next();
  };
}
