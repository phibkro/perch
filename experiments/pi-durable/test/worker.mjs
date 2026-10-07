import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createRegistry, defineTool, Harness, watchEvents } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

// This executable is a crash-test fixture. It has no production model or network path.
globalThis.fetch = async () => { throw new Error("Network is disabled in the durable experiment"); };

const [directory, scenario, phase] = process.argv.slice(2);
if (!directory || !["safe", "unsafe", "model"].includes(scenario) || !["crash", "resume"].includes(phase)) {
  throw new Error("Expected temporary directory, safe/unsafe/model scenario, and crash/resume phase");
}
const context = BACKGROUND_CONTEXT;
const requestsFile = join(directory, "model-requests.jsonl");
const artifactFile = join(directory, "artifact.md");
const body = "# Durable artifact\n\nThis exact file survives the interrupted operation.\n";
const model = {
  id: "synthetic", name: "Synthetic local model", api: "perch-synthetic", provider: "perch-synthetic",
  baseUrl: "https://invalid.example", reasoning: false, input: ["text"], contextWindow: 32000,
  maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let reportToolStarted;
const toolStarted = new Promise((resolve) => { reportToolStarted = resolve; });

function assistant(content, stopReason = "stop") {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage, stopReason, timestamp: Date.now() };
}

function syntheticStream(_model, transcript, options) {
  const stream = new AssistantMessageEventStream();
  void (async () => {
    await appendFile(requestsFile, JSON.stringify({ phase, sessionId: options?.sessionId }) + "\n");
    const user = transcript.messages.findLast((message) => message.role === "user");
    const toolResult = transcript.messages.findLast((message) => message.role === "toolResult");
    if (user?.content === "Queued follow-up") {
      const message = assistant([{ type: "text", text: "The queued follow-up was answered." }]);
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return;
    }
    if (scenario === "model" && phase === "crash") {
      const partial = assistant([{ type: "text", text: "A partial answer committed before the crash." }]);
      stream.push({ type: "start", partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: partial.content[0].text, partial });
      return; // The parent kills the process only after this is visible in a committed snapshot.
    }
    if (scenario !== "model" && !toolResult) {
      const message = assistant([{ type: "toolCall", id: "artifact-call", name: "produce_artifact", arguments: {} }], "toolUse");
      stream.push({ type: "done", reason: "toolUse", message });
      stream.end(message);
      return;
    }
    const text = scenario === "model" ? "The interrupted model request was restarted."
      : toolResult?.isError ? "The earlier tool may have run; no automatic second effect was attempted."
      : "The artifact is ready.";
    const message = assistant([{ type: "text", text }]);
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  })().catch((error) => {
    const failed = { ...assistant([], "error"), errorMessage: String(error) };
    stream.push({ type: "error", reason: "error", error: failed });
    stream.end(failed);
  });
  return stream;
}

const models = createModels();
models.setProvider(createProvider({
  id: model.provider, models: [model],
  auth: { apiKey: { name: "No network or key", resolve: async () => ({ auth: {} }) } },
  api: { stream: syntheticStream, streamSimple: syntheticStream },
}));
const registry = createRegistry();
registry.install({ name: "local-crash-fixture", tools: [defineTool({
  name: "produce_artifact", description: "Write a synthetic test artifact", parameters: Type.Object({}),
  replay: scenario === "safe" ? "safe" : "unsafe",
  async execute(_args, api, toolContext) {
    // A durable memo demonstrates a value created once and retained across execution attempts.
    const artifactId = await api.memo("artifact-id", randomUUID(), toolContext);
    await appendFile(join(directory, "tool-attempts.jsonl"), JSON.stringify({ artifactId, phase }) + "\n");
    if (scenario === "safe") await writeFile(artifactFile, body);
    else await appendFile(join(directory, "external-effects.jsonl"), JSON.stringify({ artifactId }) + "\n");
    if (phase === "crash") {
      reportToolStarted();
      await new Promise(() => {}); // Simulated crash window: effect happened, result not committed.
    }
    await api.details({ artifactId, filename: "artifact.md", mimeType: "text/markdown" }, toolContext);
    return { content: [{ type: "text", text: "Artifact write completed." }] };
  },
})] });

const storage = await openNodeSqliteStorage(join(directory, "harness.sqlite"));
const harness = await Harness.open(storage, { models, registry, settings: { retry: { enabled: false } } }, context);
const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
const input = { type: "input", content: "Produce an artifact", requestId: "operation-1" };
const followUp = { type: "input", content: "Queued follow-up", requestId: "operation-2" };

if (phase === "crash") {
  const submission = await conversation.submit(input, context);
  const queued = await conversation.submit(followUp, context);
  if (scenario === "model") {
    // Read-only snapshots reflect committed state; no timing estimate decides when to kill.
    for (;;) {
      const stream = await watchEvents(harness, conversation.id, context);
      const partial = stream.snapshot.generation?.message?.content?.some((part) => part.type === "text" && part.text.includes("partial answer"));
      await stream.stop();
      if (partial) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } else {
    await toolStarted;
  }
  process.send({ kind: "crash-ready", conversationId: conversation.id, submissionId: submission.id,
    queuedId: queued.id, queuedStatus: (await queued.status(context)).status });
  // IPC retains the child until the parent sends SIGKILL.
} else {
  const before = await watchEvents(harness, conversation.id, context);
  const recoveredBeforeScheduling = before.snapshot;
  await before.stop();
  const submission = await conversation.submit(input, context);
  const queued = await conversation.submit(followUp, context);
  const [settled, queuedSettled] = await Promise.all([submission.wait(context), queued.wait(context)]);
  const events = await watchEvents(harness, conversation.id, context);
  const entries = events.snapshot.entries;
  await events.stop();
  await harness.close(context);
  const artifact = scenario === "safe" ? await readFile(artifactFile, "utf8") : undefined;
  process.send({ kind: "completed", conversationId: conversation.id, submissionId: submission.id,
    queuedId: queued.id, settled, queuedSettled, recoveredBeforeScheduling, entries, artifact }, () => process.disconnect());
}
