import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

function equal(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

// Single-owner installation, not a multi-tenant user account system.
export function ownerAuth(username: string | undefined, password: string | undefined): RequestHandler {
  if (!username || !password || password.length < 16) {
    throw new Error("Set APP_USERNAME and an APP_PASSWORD of at least 16 characters.");
  }
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      const validUser = equal(decoded.slice(0, colon), username);
      const validPass = equal(decoded.slice(colon + 1), password);
      if (colon >= 0 && validUser && validPass) {
        // Browser Basic Auth can be sent automatically: reject cross-site mutations.
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
          const origin = req.get("origin");
          const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get("host")}`;
          if (req.get("sec-fetch-site") === "cross-site" || (origin && origin !== expected)) {
            res.status(403).json({ error: "Cross-origin mutation blocked" });
            return;
          }
        }
        res.setHeader("Cache-Control", "no-store");
        next();
        return;
      }
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Tabless", charset="UTF-8"');
    res.status(401).json({ error: "Authentication required" });
  };
}
