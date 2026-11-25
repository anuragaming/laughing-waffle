
"use strict";

const https = require("https");
const http = require("http");

const TIMEOUT = 20000;
const MAX_REDIRECTS = 0;

const METHODS = new Set([
  "GET", "HEAD", "POST", "PUT",
  "PATCH", "DELETE", "OPTIONS"
]);

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function getTarget() {
  const value = process.env.TARGET_ORIGIN;

  if (!value) throw new Error("TARGET_ORIGIN missing");

  const url = new URL(value);

  if (url.protocol !== "https:") {
    throw new Error("HTTPS required");
  }

  return url;
}

function getPath(req, base) {
  const incoming = new URL(req.url, "https://internal.invalid");
  const path = incoming.pathname.replace(/^\/api(?=\/|$)/, "") || "/";

  const target = new URL(base.origin);

  target.pathname =
    base.pathname.replace(/\/$/, "") + path;

  target.search = incoming.search;

  return target;
}

function requestHeaders(req, target) {
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

  headers.host = target.host;

  return headers;
}

function proxy(req, res, base) {
  return new Promise((resolve) => {
    const target = getPath(req, base);

    const transport = target.protocol === "https:"
      ? https
      : http;

    const upstream = transport.request({
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: req.method,
      headers: requestHeaders(req, target),
      timeout: TIMEOUT
    }, (response) => {
      res.statusCode = response.statusCode || 502;

      const excluded = new Set([
        "connection",
        "transfer-encoding",
        "keep-alive"
      ]);

      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined && !excluded.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      }

      res.setHeader("X-Content-Type-Options", "nosniff");

      response.on("error", (error) => {
        console.error("Response error:", error.message);
        res.destroy(error);
        resolve();
      });

      response.pipe(res);
      response.on("end", resolve);
      res.on("close", resolve);
    });

    upstream.setTimeout(TIMEOUT, () => {
      upstream.destroy(new Error("UPSTREAM_TIMEOUT"));
    });

    upstream.on("error", (error) => {
      console.error("Upstream error:", error.message);

      if (!res.headersSent) {
        json(
          res,
          error.message === "UPSTREAM_TIMEOUT" ? 504 : 502,
          {
            error: error.message === "UPSTREAM_TIMEOUT"
              ? "Gateway timeout"
              : "Upstream unavailable"
          }
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
      return json(res, 405, {
        error: "Method not allowed"
      });
    }

    const pathname = new URL(
      req.url,
      "https://internal.invalid"
    ).pathname;

    if (pathname === "/health") {
      return json(res, 200, {
        status: "ok",
        service: "laughing-waffle",
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
      json(res, 500, {
        error: "Internal Server Error"
      });
    } else {
      res.destroy(error);
    }
  }
};
