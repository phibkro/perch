import { DurableObject } from "cloudflare:workers";

export class Probe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.instance = crypto.randomUUID();
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counts (name TEXT PRIMARY KEY, value INTEGER NOT NULL)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY)");
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/add") {
      const key = url.searchParams.get("key");
      if (!key) return new Response("key required", { status: 400 });
      await this.ctx.storage.transaction(async (txn) => {
        const existing = txn.sql.exec("SELECT id FROM operations WHERE id = ?", key).toArray();
        if (!existing.length) {
          txn.sql.exec("INSERT INTO operations(id) VALUES (?)", key);
          txn.sql.exec("INSERT INTO counts(name, value) VALUES ('writes', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1");
        }
      });
      await this.ctx.storage.sync();
    }
    if (request.method === "POST" && url.pathname === "/schedule") {
      await this.ctx.storage.setAlarm(Date.now() + Number(url.searchParams.get("after") ?? "5000"));
    }
    return Response.json({
      instance: this.instance,
      name: this.ctx.id.name,
      counts: this.ctx.storage.sql.exec("SELECT * FROM counts ORDER BY name").toArray(),
      operations: this.ctx.storage.sql.exec("SELECT * FROM operations ORDER BY id").toArray(),
      alarm: await this.ctx.storage.getAlarm()
    });
  }

  async alarm() {
    this.ctx.storage.sql.exec("INSERT INTO counts(name, value) VALUES ('alarms', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1");
    await this.ctx.storage.sync();
    console.log("PROBE_ALARM_COMMITTED", this.instance);
  }
}

export default {
  fetch(request, env) {
    return env.PROBE.getByName("sqlite-alarm-smoke").fetch(request);
  }
};
