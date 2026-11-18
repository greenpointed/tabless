import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { ownerAuth } from "../server/auth";

test("authentication fails closed with missing or weak configuration", () => {
  assert.throws(() => ownerAuth(undefined, undefined));
  assert.throws(() => ownerAuth("owner", "short"));
});

test("all routes require credentials and cross-site writes are denied", async () => {
  const app = express();
  app.use(ownerAuth("owner", "test-only-password-123"));
  app.get("/api/jobs", (_req, res) => res.json([]));
  app.post("/api/jobs", (_req, res) => res.json({ ok: true }));
  app.get("/", (_req, res) => res.send("App"));
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const authorization = `Basic ${Buffer.from("owner:test-only-password-123").toString("base64")}`;
  try {
    assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(`${base}/api/jobs`, { headers: { authorization: "Basic invalid" } })).status, 401);
    const good = await fetch(`${base}/api/jobs`, { headers: { authorization } });
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), []);
    assert.equal(good.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/api/jobs`, {
      method: "POST", headers: { authorization, origin: "https://untrusted.example" },
    })).status, 403);
    assert.equal((await fetch(`${base}/api/jobs`, {
      method: "POST", headers: { authorization, origin: base },
    })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  }
});
