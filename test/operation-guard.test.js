import assert from "node:assert/strict";
import test from "node:test";
import {
  isDuplicateDraftError,
  mergeDuplicateOperation,
  normalizeDraftId,
  planOperationWrite,
} from "../server/operation-guard.js";
import { createSaveGate } from "../save-gate.js";

const DRAFT = "6f1c2a90-7b14-4d2e-8a11-0c5e9b7a1234";

test("a second save of the same form updates the first operation", () => {
  const first = planOperationWrite(DRAFT, "");
  assert.equal(first.action, "insert");

  const second = planOperationWrite(DRAFT, "OP-0090");
  assert.deepEqual(second, { action: "update", draftId: DRAFT, operationId: "OP-0090" });
});

test("a later save without a date does not clear the date already stored", () => {
  const merged = mergeDuplicateOperation(
    { id: "OP-0090", date: "2026-10-27", patientAge: 65 },
    { date: "", patientAge: 64, patient: "Бобровнік В.К." },
  );
  assert.equal(merged.date, "2026-10-27");
  assert.equal(merged.patientAge, 64);
});

test("a later save with a date replaces the stored date", () => {
  const merged = mergeDuplicateOperation(
    { date: "2026-10-27" },
    { date: "2026-10-28" },
  );
  assert.equal(merged.date, "2026-10-28");
});

test("two different forms still create two operations", () => {
  const other = "11111111-2222-4333-8444-555555555555";
  assert.equal(planOperationWrite(other, "").action, "insert");
  assert.equal(planOperationWrite("", "OP-0090").action, "insert");
  assert.equal(normalizeDraftId("not-a-uuid"), "");
});

test("a duplicate draft key from a parallel insert is recognized", () => {
  assert.equal(isDuplicateDraftError({
    code: "ER_DUP_ENTRY",
    message: "Duplicate entry for key 'uq_operations_draft_id'",
  }), true);
  assert.equal(isDuplicateDraftError({ code: "ER_DUP_ENTRY", message: "PRIMARY" }), false);
  assert.equal(isDuplicateDraftError(new Error("nope")), false);
});

test("the save button ignores a second press while the first request is still running", () => {
  const gate = createSaveGate();
  assert.equal(gate.tryBegin(), true);
  assert.equal(gate.tryBegin(), false);
  assert.equal(gate.pending, true);
  gate.end();
  assert.equal(gate.pending, false);
  assert.equal(gate.tryBegin(), true);
});
