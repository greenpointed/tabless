import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

test("built app refuses missing config; empty mock database is isolated behind auth", async () => {
  const env = { ...process.env };
  for (const key of ["SUPABASE_URL", "SUPABASE_KEY", "APP_USERNAME", "APP_PASSWORD", "RESUME_FILE", "OPENAI_API_KEY"]) delete env[key];
  const missing = spawn(process.execPath, ["dist/index.cjs"], { env });
  let errors = "";
  missing.stderr.on("data", d => { errors += d; });
  const code = await new Promise(resolve => missing.once("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(errors, /SUPABASE_URL and SUPABASE_KEY/);

  let calls = 0;
  const database = createServer((req, res) => {
    assert.match(req.url || "", /^\/rest\/v1\/jobs/);
    calls++;
    res.setHeader("Content-Type", "application/json");
    res.end("[]");
  });
  await new Promise<void>(resolve => database.listen(0, "127.0.0.1", resolve));
  const dbPort = (database.address() as { port: number }).port;
  // Reserve a free app port rather than touch the existing personal app.
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const app = spawn(process.execPath, ["dist/index.cjs"], { env: {
    ...env, NODE_ENV: "production", PORT: String(port),
    SUPABASE_URL: `http://127.0.0.1:${dbPort}`, SUPABASE_KEY: "test-only-database-key",
    APP_USERNAME: "owner", APP_PASSWORD: "test-only-password-123",
  } });
  app.stdout.resume();
  let stderr = "";
  app.stderr.on("data", d => { stderr += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(base); ready = true; break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, stderr);
    assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
    assert.equal(calls, 0, "Unauthenticated callers must not reach database");
    const headers = { authorization: `Basic ${Buffer.from("owner:test-only-password-123").toString("base64")}` };
    const result = await fetch(`${base}/api/jobs`, { headers });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), []);
    assert.equal(calls, 1);
    const page = await fetch(base, { headers });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Job Tracker<\/title>/);
  } finally {
    const exited = new Promise(resolve => app.once("exit", resolve));
    app.kill("SIGTERM");
    await exited;
    database.closeAllConnections();
    await new Promise<void>(resolve => database.close(() => resolve()));
  }
});
