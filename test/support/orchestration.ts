/** Integration-only access to fixtures and worker implementation details.
 * Not a runtime package export and never included in release artifacts.
 */
import * as fs from "node:fs";
import { createParentTask, parentTaskEnvironment } from "../../packages/orchestration/parent-task.ts";
import { createWorkerArtifacts, writeWorkerRequest, type WorkerArtifactPaths, type WorkerRequestFile } from "../../packages/orchestration/worker-frame.ts";

export { forkFixture } from "../../packages/orchestration/test/fork-fixture.ts";
export {
  default as workerFrame,
  createWorkerArtifacts,
  parseWorkerResult,
  readWorkerStatus,
  writeWorkerRequest,
} from "../../packages/orchestration/worker-frame.ts";

/**
 * Leases a worker request to this test process before its session starts, as a parent
 * does. Call release() only after the session is disposed: a vanished lease stops the worker.
 */
export function leaseWorkerRequest(request: Omit<WorkerRequestFile, "resultPath" | "statusPath">): { paths: WorkerArtifactPaths; prompt: string; release(): void } {
  const paths = createWorkerArtifacts();
  writeWorkerRequest(paths, { ...request, resultPath: paths.resultPath, statusPath: paths.statusPath });
  const environment = parentTaskEnvironment(createParentTask(paths.artifactDir, request.id));
  const before = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  return {
    paths,
    prompt: fs.readFileSync(paths.promptPath, "utf8"),
    release() {
      for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      fs.rmSync(paths.artifactDir, { recursive: true, force: true });
    },
  };
}

export { switchEnvironment } from "../../packages/orchestration/switch-destinations.ts";
