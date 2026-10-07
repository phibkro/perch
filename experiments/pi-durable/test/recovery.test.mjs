import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const fixture = new URL("./worker.mjs", import.meta.url);

function start(directory, scenario, phase) {
  const child = fork(fixture, [directory, scenario, phase], {
    // Provider credentials and user settings never enter the test process.
    env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`Fixture timeout: ${errors}`)); }, 15000);
    child.once("message", (message) => { clearTimeout(timeout); resolve(message); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Fixture exited before result (${code ?? signal}): ${errors}`));
    });
  });
  return { child, result };
}

async function jsonLines(path) {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

for (const scenario of ["safe", "unsafe", "model"]) {
  test(`real SQLite restart: ${scenario} interruption, deduplicated input, queued follow-up`, { timeout: 35000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `perch-durable-${scenario}-`));
    const children = [];
    try {
      const first = start(directory, scenario, "crash");
      children.push(first.child);
      const checkpoint = await first.result;
      assert.equal(checkpoint.kind, "crash-ready");
      assert.equal(checkpoint.queuedStatus, "queued");
      const firstExit = once(first.child, "exit");
      first.child.kill("SIGKILL");
      assert.deepEqual(await firstExit, [null, "SIGKILL"]);

      const second = start(directory, scenario, "resume");
      children.push(second.child);
      const secondExit = once(second.child, "exit");
      const result = await second.result;
      assert.equal(result.kind, "completed");
      assert.deepEqual(await secondExit, [0, null]);
      assert.equal(result.conversationId, checkpoint.conversationId);
      assert.equal(result.submissionId, checkpoint.submissionId);
      assert.equal(result.queuedId, checkpoint.queuedId);
      assert.equal(result.settled.status, "done");
      assert.equal(result.queuedSettled.status, "done");
      assert.equal(result.recoveredBeforeScheduling.inbox.length, 1);
      const messages = result.entries.flatMap((entry) => entry.model ?? []);
      assert.equal(messages.filter((message) => message.role === "user").length, 2,
        "retrying the operation IDs must not append duplicate user messages");
      const requests = await jsonLines(join(directory, "model-requests.jsonl"));
      assert.ok(requests.some((request) => request.phase === "crash"));
      assert.ok(requests.some((request) => request.phase === "resume"));
      assert.ok(requests[0].sessionId);
      assert.equal(new Set(requests.map((request) => request.sessionId)).size, 1,
        "provider-facing session identity survives reopen");

      if (scenario === "safe") {
        const attempts = await jsonLines(join(directory, "tool-attempts.jsonl"));
        assert.equal(attempts.length, 2, "safe interrupted tool runs again");
        assert.equal(attempts[0].artifactId, attempts[1].artifactId, "durable memo survives the kill");
        assert.equal(result.artifact, "# Durable artifact\n\nThis exact file survives the interrupted operation.\n");
        assert.equal(messages.filter((message) => message.role === "toolResult").length, 1);
      } else if (scenario === "unsafe") {
        assert.equal((await jsonLines(join(directory, "tool-attempts.jsonl"))).length, 1);
        assert.equal((await jsonLines(join(directory, "external-effects.jsonl"))).length, 1);
        const tool = messages.find((message) => message.role === "toolResult");
        assert.equal(tool?.isError, true);
        assert.match(JSON.stringify(tool), /interrupted.*may have partially run/);
      } else {
        assert.match(JSON.stringify(result.recoveredBeforeScheduling.generation), /partial answer/);
        assert.ok(messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"
          && JSON.stringify(message.content).includes("partial answer")), "stored partial becomes an aborted transcript entry");
        assert.ok(messages.some((message) => message.role === "assistant"
          && JSON.stringify(message.content).includes("interrupted model request was restarted")));
      }
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
