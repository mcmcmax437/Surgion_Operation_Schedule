import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
const workflow = fs.readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");

test("the operation form uses one in-flight save and a stable draft id", () => {
  assert.match(app, /beginOperationSave\(\)/);
  assert.match(app, /endOperationSave\(\)/);
  assert.match(app, /data\.draftId = formDraftId/);
  assert.match(server, /planOperationWrite\(/);
  assert.match(server, /mergeDuplicateOperation\(/);
});

test("deploy runs only after the test job", () => {
  assert.match(workflow, /npm test/);
  assert.match(workflow, /needs:\s*test/);
});
