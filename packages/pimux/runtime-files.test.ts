import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createClaimTestEnvironment } from "./ownership.ts";
import { appendDiagnostic, pruneCompleted, runtimePaths } from "./runtime-files.ts";
import { writePrivateJson } from "./private-files.ts";

test("completed receipt retention also bounds linked operations/logs without deleting active or uncertain evidence", (t) => {
  const isolated = createClaimTestEnvironment();
  t.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
  const records = Array.from({ length: 4 }, (_, index) => {
    const files = runtimePaths(`done-${index}`, `operation-${index}`, isolated.env);
    writePrivateJson(files.operation, { muxId: `done-${index}`, operationId: `operation-${index}`, state: "committed" });
    appendDiagnostic(files.log, "completed diagnostic");
    writePrivateJson(files.receipt, { muxId: `done-${index}`, operationId: `operation-${index}`, state: "stopped" });
    fs.utimesSync(files.receipt, index + 1, index + 1);
    return files;
  });
  const uncertain = runtimePaths("uncertain", "provisional", isolated.env);
  writePrivateJson(uncertain.operation, { muxId: "uncertain", operationId: "provisional", state: "provisional" });
  appendDiagnostic(uncertain.log, "uncertain operation evidence");
  pruneCompleted(path.dirname(records[0]!.receipt), 2);
  for (const [index, files] of records.entries()) {
    for (const file of [files.receipt, files.operation, files.log]) assert.equal(fs.existsSync(file), index >= 2);
  }
  assert.equal(fs.existsSync(uncertain.operation), true);
  assert.equal(fs.existsSync(uncertain.log), true);
});

test("receipts of workers whose task evidence is not complete outlive retention", (t) => {
  const isolated = createClaimTestEnvironment();
  t.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
  const states = ["pending", "failed", "complete", null, "newest"];
  const records = states.map((state, index) => {
    const files = runtimePaths(`worker-${index}`, `operation-${index}`, isolated.env);
    writePrivateJson(files.receipt, { muxId: `worker-${index}`, operationId: `operation-${index}`, state: "stopped" });
    fs.utimesSync(files.receipt, index + 1, index + 1);
    if (state === "pending" || state === "failed" || state === "complete") {
      const tasks = path.join(files.directory, "task-receipts");
      fs.mkdirSync(tasks, { recursive: true, mode: 0o700 });
      writePrivateJson(path.join(tasks, `worker-${index}.json`), { muxId: `worker-${index}`, state });
    }
    return files;
  });
  pruneCompleted(path.dirname(records[0]!.receipt), 1);
  assert.deepEqual(records.map((files) => fs.existsSync(files.receipt)), [true, true, false, false, true]);
});
