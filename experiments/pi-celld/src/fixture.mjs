import { Type } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createRegistry, defineTool } from "@earendil-works/pi-durable";

// A controlled test provider, not a production LLM or a user credential path.
export const MODEL = Object.freeze({
  id: "synthetic",
  name: "Synthetic celld recovery model",
  api: "perch-celld-synthetic",
  provider: "perch-celld-synthetic",
  baseUrl: "https://invalid.example",
  reasoning: false,
  input: ["text"],
  contextWindow: 32000,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

export const ARTIFACT = Object.freeze({
  filename: "artifact.md",
  mimeType: "text/markdown",
  content: "# Durable artifact\n\nThis exact file survives the interrupted operation.\n",
});

const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content, stopReason = "stop") {
  return {
    role: "assistant", content, api: MODEL.api, provider: MODEL.provider,
    model: MODEL.id, usage, stopReason, timestamp: Date.now(),
  };
}

function textOf(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.filter((part) => part.type === "text").map((part) => part.text).join("")
    : "";
}

export function createFixture(probe) {
  function syntheticStream(_model, transcript, options) {
    const stream = new AssistantMessageEventStream();
    void (async () => {
      const user = transcript.messages.findLast((message) => message.role === "user");
      const input = textOf(user?.content);
      const toolResult = transcript.messages.findLast((message) => message.role === "toolResult");
      const gate = await probe.control("/model-attempt", {
        type: "model-attempt", input, text: input,
        providerSessionId: options?.sessionId, sessionId: options?.sessionId,
      });

      if (probe.scenario === "model" && input !== "Queued follow-up" && gate.hold) {
        const partial = assistant([{ type: "text", text: "A partial answer committed before the crash." }]);
        stream.push({ type: "start", partial });
        stream.push({ type: "text_delta", contentIndex: 0, delta: partial.content[0].text, partial });
        // Only the external runner decides when the committed snapshot is ready
        // to kill. Leaving this stream open creates the real interruption.
        return;
      }

      if (input !== "Queued follow-up" && ["safe", "unsafe"].includes(probe.scenario) && !toolResult) {
        const message = assistant([{
          type: "toolCall", id: "artifact-call", name: "produce_artifact", arguments: {},
        }], "toolUse");
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end(message);
        return;
      }

      const text = input === "Queued follow-up" ? "The queued follow-up was answered."
        : probe.scenario === "model" ? "The interrupted model request was restarted."
        : probe.scenario === "idle" ? "The synthetic idle request completed."
        : toolResult?.isError ? "The earlier tool may have run; no automatic second effect was attempted."
        : "The artifact is ready.";
      const message = assistant([{ type: "text", text }]);
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      await probe.event("model-completed", { input, text, attempt: gate.attempt });
    })().catch((error) => {
      const failed = { ...assistant([], "error"), errorMessage: String(error) };
      stream.push({ type: "error", reason: "error", error: failed });
      stream.end(failed);
      console.error("Synthetic provider failed", error);
    });
    return stream;
  }

  const models = createModels();
  models.setProvider(createProvider({
    id: MODEL.provider,
    models: [MODEL],
    auth: { apiKey: { name: "Synthetic provider: no key", resolve: async () => ({ auth: {} }) } },
    api: { stream: syntheticStream, streamSimple: syntheticStream },
  }));

  const registry = createRegistry();
  registry.install({
    name: "perch-celld-recovery-fixture",
    tools: [defineTool({
      name: "produce_artifact",
      description: "Ask the loopback test observer to write a synthetic artifact",
      parameters: Type.Object({}),
      replay: probe.scenario === "safe" ? "safe" : "unsafe",
      async execute(_args, api, context) {
        const artifactId = await api.memo("artifact-id", crypto.randomUUID(), context);
        const gate = await probe.control("/tool-attempt", {
          type: "tool-attempt", artifactId, ...ARTIFACT,
        });
        if (gate.hold) {
          // The external observer already performed the effect. The process is
          // killed before this invocation can commit its result to Pi.
          await new Promise(() => {});
        }
        await api.details({ artifactId, filename: ARTIFACT.filename, mimeType: ARTIFACT.mimeType }, context);
        return { content: [{ type: "text", text: "Artifact write completed." }] };
      },
    })],
  });
  return { models, registry };
}
