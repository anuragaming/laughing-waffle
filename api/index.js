
"use strict";

const https = require("https");

const TIMEOUT = 20000;

const METHODS = new Set([
  "GET", "HEAD", "POST",
  "PUT", "PATCH", "DELETE", "OPTIONS"
]);

function sendJSON(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function getTarget() {
  const value = process.env.TARGET_ORIGIN;

  if (!value) throw new Error("TARGET_ORIGIN missing");

  const target = new URL(value);

  if (target.protocol !== "https:") {
    throw new Error("HTTPS required");
  }

  return target;
}

function resolveURL(req, base) {
  const incoming = new URL(
    req.url,
    "https://internal.invalid"
  );

  let pathname = incoming.pathname;

  if (pathname === "/api") {
    pathname = "/";
  } else if (pathname.startsWith("/api/")) {
    pathname = pathname.slice(4);
  }

  const destination = new URL(base.origin);

  destination.pathname =
    base.pathname.replace(/\/$/, "") + pathname;

  destination.search = incoming.search;

  return destination;
}

function buildHeaders(req, destination) {
  const headers = {};

  const allowed = [
    "accept",
    "accept-language",
    "content-type",
    "content-length",
    "authorization",
    "if-none-match",
    "if-modified-since",
    "range"
  ];

  for (const key of allowed) {
    if (req.headers[key]) {
      headers[key] = req.headers[key];
    }
  }

  headers.host = destination.host;

  return headers;
}

function proxy(req, res, base) {
  return new Promise((resolve) => {
    const destination = resolveURL(req, base);

    const upstream = https.request({
      hostname: destination.hostname,
      port: destination.port || 443,
      path: destination.pathname + destination.search,
      method: req.method,
      headers: buildHeaders(req, destination),
      timeout: TIMEOUT
    }, (response) => {
      res.statusCode = response.statusCode || 502;

      const excluded = [
        "connection",
        "transfer-encoding",
        "keep-alive"
      ];

      for (const [key, value] of Object.entries(response.headers)) {
        if (
          value !== undefined &&
          !excluded.includes(key.toLowerCase())
        ) {
          res.setHeader(key, value);
        }
      }

      response.pipe(res);

      response.on("end", resolve);

      response.on("error", (error) => {
        console.error("Response error:", error.message);
        res.destroy(error);
        resolve();
      });

      res.on("close", resolve);
    });

    upstream.setTimeout(TIMEOUT, () => {
      upstream.destroy(new Error("UPSTREAM_TIMEOUT"));
    });

    upstream.on("error", (error) => {
      console.error("Proxy error:", error.message);

      if (!res.headersSent) {
        sendJSON(
          res,
          error.message === "UPSTREAM_TIMEOUT" ? 504 : 502,
          { error: error.message }
        );
      } else {
        res.destroy(error);
      }

      resolve();
    });

    if (["GET", "HEAD"].includes(req.method)) {
      upstream.end();
    } else {
      req.pipe(upstream);
    }

    res.on("close", () => {
      if (!upstream.destroyed) upstream.destroy();
    });
  });
}

module.exports = async function handler(req, res) {
  try {
    if (!METHODS.has(req.method)) {
      return sendJSON(res, 405, {
        error: "Method not allowed"
      });
    }

    const pathname = new URL(
      req.url,
      "https://internal.invalid"
    ).pathname;

    if (pathname === "/health") {
      return sendJSON(res, 200, {
        status: "ok",
        service: "laughing-waffle",
        version: "3.0.0",
        runtime: "nodejs",
        timestamp: new Date().toISOString()
      });
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    const target = getTarget();

    await proxy(req, res, target);

  } catch (error) {
    console.error("Handler error:", error);

    if (!res.headersSent) {
      sendJSON(res, 500, {
        error: "Internal Server Error"
      });
    } else {
      res.destroy(error);
    }
  }
};
