const DRAFT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function normalizeDraftId(value) {
  const text = String(value || "").trim().toLowerCase();
  return DRAFT_ID_RE.test(text) ? text : "";
}

export function normalizeOperationDate(value) {
  const match = String(value || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

// A repeated save of the same open form must not create a second row.
// An empty date on the later request must not wipe a date already stored.
export function mergeDuplicateOperation(existing, incoming) {
  const merged = { ...incoming };
  const existingDate = normalizeOperationDate(existing?.date);
  const incomingDate = normalizeOperationDate(incoming?.date);
  merged.date = incomingDate || existingDate || null;
  return merged;
}

export function planOperationWrite(draftId, existingId) {
  const id = normalizeDraftId(draftId);
  if (id && existingId) {
    return { action: "update", draftId: id, operationId: String(existingId) };
  }
  return { action: "insert", draftId: id };
}

export function isDuplicateDraftError(error) {
  if (error?.code !== "ER_DUP_ENTRY") return false;
  return /draft_id|uq_operations_draft_id/i.test(String(error?.message || ""));
}
