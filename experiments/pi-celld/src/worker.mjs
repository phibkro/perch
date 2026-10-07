import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { PiHarness } from "agents/harness/pi";
import { Harness } from "@earendil-works/pi-durable";
import { createFixture, MODEL } from "./fixture.mjs";

const SCENARIOS = new Set(["safe", "unsafe", "model", "idle"]);
const SCENARIO_KEY = "probe:scenario";
const OPERATIONS_KEY = "probe:operations";

function submissionBody(value) {
  if (!value || typeof value.text !== "string" || value.text.length > 32768
      || typeof value.operationId !== "string" || !value.operationId || value.operationId.length > 128
      || (value.scenario !== undefined && !SCENARIOS.has(value.scenario))) {
    throw new Error("Expected {text, operationId, scenario?: safe|unsafe|model|idle}");
  }
  return value;
}

// Test-only composition root. The official PiHarness storage adapter and
// Lifecycle alarm implementation are used without monkey-patching either.
export class ProbeSession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.bootId = crypto.randomUUID();
    this.sessionName = ctx.id.name ?? ctx.id.toString();
    this.scenario = undefined;
    this.activatedBy = undefined;
    this.monitors = new Set();
    this.lifecycle = new Lifecycle(this);
    this.harness = new PiHarness({
      defaults: { model: MODEL },
      harness: async ({ storage, context }) => {
        this.scenario = await ctx.storage.get(SCENARIO_KEY);
        if (!SCENARIOS.has(this.scenario)) throw new Error("The probe scenario must be configured before Pi opens");
        const fixture = createFixture(this);
        const pi = await Harness.open(storage, {
          ...fixture,
          settings: { retry: { enabled: false } },
          onReport: (error) => console.error("Pi report", error),
        }, context);
        await this.event("boot", { activatedBy: this.activatedBy });
        return pi;
      },
    });
    this.lifecycle.use(this.harness);
  }

  async control(path, payload) {
    const base = new URL(this.env.PROBE_CONTROL_URL);
    if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
      throw new Error("PROBE_CONTROL_URL must point to the local HTTP test observer");
    }
    const response = await fetch(new URL(path, base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, sessionName: this.sessionName, bootId: this.bootId, scenario: this.scenario }),
    });
    if (!response.ok) throw new Error(`Observer ${path} returned ${response.status}`);
    return response.json();
  }

  event(type, payload = {}) {
    return this.control("/events", { type, ...payload });
  }

  monitor(operationId) {
    if (this.monitors.has(operationId)) return;
    this.monitors.add(operationId);
    const work = this.harness.wait(operationId)
      .then((result) => this.event("settled", { operationId, result }))
      .catch((error) => {
        console.error("Probe result observer failed", error);
        return this.event("monitor-error", { operationId, error: String(error) }).catch(() => {});
      });
    this.ctx.waitUntil(work);
  }

  async onStart() {
    const operations = await this.ctx.storage.get(OPERATIONS_KEY) ?? [];
    for (const operationId of operations) this.monitor(operationId);
    await this.event("ready", { activatedBy: this.activatedBy });
  }

  async fetch(request) {
    this.activatedBy ??= "fetch";
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/submit")) {
      let body;
      try { body = submissionBody(await request.clone().json()); }
      catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
      // First-submit configuration precedes Lifecycle's eager Pi startup. Once
      // persisted, a scenario cannot change its tool replay policy on restart.
      const conflict = await this.ctx.blockConcurrencyWhile(async () => {
        const current = await this.ctx.storage.get(SCENARIO_KEY);
        const requested = body.scenario ?? current ?? "safe";
        if (current !== undefined && current !== requested) return true;
        if (current === undefined) await this.ctx.storage.put(SCENARIO_KEY, requested);
        this.scenario = requested;
        return false;
      });
      if (conflict) return Response.json({ error: "This cell already has another scenario" }, { status: 409 });
    } else if (await this.ctx.storage.get(SCENARIO_KEY) === undefined) {
      return Response.json({ sessionName: this.sessionName, bootId: this.bootId,
        scenario: null, snapshot: null, pending: [] });
    }
    return this.lifecycle.fetch(request);
  }

  async alarm() {
    this.activatedBy ??= "alarm";
    return this.lifecycle.alarm();
  }

  async onAlarm() {
    await this.event("alarm", { alarmAt: await this.ctx.storage.getAlarm() });
  }

  async onRequest(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname.endsWith("/submit")) {
      const body = submissionBody(await request.json());
      const operations = await this.ctx.storage.get(OPERATIONS_KEY) ?? [];
      if (!operations.includes(body.operationId)) {
        await this.ctx.storage.put(OPERATIONS_KEY, [...operations, body.operationId]);
      }
      const receipt = await this.harness.submit(body.text, { operationId: body.operationId });
      this.monitor(receipt.operationId);
      return Response.json(receipt);
    }
    if (request.method === "GET" && url.pathname.endsWith("/snapshot")) {
      const events = await this.harness.session().events();
      const snapshot = events.snapshot;
      await events.stop();
      return Response.json({
        sessionName: this.sessionName, bootId: this.bootId, scenario: this.scenario,
        snapshot, pending: await this.harness.pending(),
        alarmAt: await this.ctx.storage.getAlarm(),
      });
    }
    if (request.method === "GET" && url.pathname.endsWith("/result")) {
      const operationId = url.searchParams.get("operationId");
      if (!operationId) return Response.json({ error: "operationId is required" }, { status: 400 });
      return Response.json(await this.harness.wait(operationId));
    }
    return Response.json({ error: "Unknown probe route" }, { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, synthetic: true, harness: "PiHarness",
        agents: "0.26.0", piDurable: "1.0.4" });
    }
    const match = /^\/sessions\/([A-Za-z0-9_-]{1,96})\/(submit|snapshot|result)$/.exec(url.pathname);
    if (!match) return Response.json({ error: "Unknown probe route" }, { status: 404 });
    const id = env.PROBE_SESSIONS.idFromName(match[1]);
    return env.PROBE_SESSIONS.get(id).fetch(request);
  },
};
