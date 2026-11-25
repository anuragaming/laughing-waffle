
"use strict";

const https = require("https");
const http = require("http");

const TARGET_ORIGIN = process.env.TARGET_ORIGIN;
const APP_ORIGIN = process.env.APP_ORIGIN || "";
const TIMEOUT = 20000;

const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS"
]);

function sendJSON(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function validateTarget() {
  if (!TARGET_ORIGIN) {
    throw new Error("TARGET_ORIGIN is missing");
  }

  const target = new URL(TARGET_ORIGIN);

  if (!["https:", "http:"].includes(target.protocol)) {
    throw new Error("Invalid target protocol");
  }

  // Production should use HTTPS.
  if (
    process.env.NODE_ENV === "production" &&
    target.protocol !== "https:"
  ) {
    throw new Error("HTTPS required");
  }

  return target;
}

function checkOrigin(req) {
  const origin = req.headers.origin;

  // Direct navigation does not always include Origin.
  if (!origin) return true;

  if (!APP_ORIGIN) return false;

  try {
    return new URL(origin).origin === new URL(APP_ORIGIN).origin;
  } catch {
    return false;
  }
}

function getPath(req, target) {
  const incoming = new URL(
    req.url,
    "https://internal.invalid"
  );

  const prefix = "/api";

  let pathname = incoming.pathname;

  if (pathname === prefix) {
    pathname = "/";
  } else if (pathname.startsWith(prefix + "/")) {
    pathname = pathname.slice(prefix.length);
  }

  const result = new URL(target.origin);

  result.pathname =
    target.pathname.replace(/\/$/, "") + pathname;

  result.search = incoming.search;

  return result;
}

function cleanRequestHeaders(headers, target) {
  const result = { ...headers };

  const blocked = [
    "host",
    "connection",
    "transfer-encoding",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "x-forwarded-host",
    "x-real-ip"
  ];

  for (const name of blocked) {
    delete result[name];
  }

  result.host = target.host;

  return result;
}

function cleanResponseHeaders(headers) {
  const result = { ...headers };

  const blocked = [
    "connection",
    "transfer-encoding",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "upgrade",
    "trailer"
  ];

  for (const name of blocked) {
    delete result[name];
  }

  return result;
}

function handleHealth(req, res) {
  sendJSON(res, 200, {
    status: "ok",
    service: "laughing-waffle",
    runtime: "nodejs",
    timestamp: new Date().toISOString(),
    targetConfigured: Boolean(TARGET_ORIGIN)
  });
}

function proxyRequest(req, res, target) {
  return new Promise((resolve) => {
    const destination = getPath(req, target);

    const transport =
      destination.protocol === "https:"
        ? https
        : http;

    const options = {
      protocol: destination.protocol,
      hostname: destination.hostname,
      port: destination.port || undefined,
      path: destination.pathname + destination.search,
      method: req.method,
      headers: cleanRequestHeaders(req.headers, destination),
      timeout: TIMEOUT
    };

    const upstream = transport.request(
      options,
      (response) => {
        if (res.headersSent) {
          response.destroy();
          return resolve();
        }

        res.statusCode = response.statusCode || 502;

        const headers = cleanResponseHeaders(
          response.headers
        );

        for (const [key, value] of Object.entries(headers)) {
          if (value !== undefined) {
            res.setHeader(key, value);
          }
        }

        // Do not rewrite authentication redirects.
        // External authentication must be configured
        // by the upstream application itself.

        response.on("error", (error) => {
          console.error("Upstream response error:", error.message);

          if (!res.headersSent) {
            sendJSON(res, 502, {
              error: "Upstream response failed"
            });
          } else {
            res.destroy(error);
          }
        });

        response.pipe(res);

        response.on("end", resolve);
        res.on("close", resolve);
      }
    );

    upstream.on("timeout", () => {
      upstream.destroy(
        new Error("UPSTREAM_TIMEOUT")
      );
    });

    upstream.on("error", (error) => {
      console.error("Upstream request error:", {
        message: error.message,
        target: destination.origin
      });

      if (!res.headersSent) {
        sendJSON(
          res,
          error.message === "UPSTREAM_TIMEOUT"
            ? 504
            : 502,
          {
            error:
              error.message === "UPSTREAM_TIMEOUT"
                ? "Gateway timeout"
                : "Upstream unavailable"
          }
        );
      } else {
        res.destroy(error);
      }

      resolve();
    });

    if (req.method === "GET" || req.method === "HEAD") {
      upstream.end();
    } else {
      req.pipe(upstream);
    }

    res.on("close", () => {
      if (!upstream.destroyed) {
        upstream.destroy();
      }
    });
  });
}

module.exports = async function handler(req, res) {
  try {
    const pathname = new URL(
      req.url,
      "https://internal.invalid"
    ).pathname;

    // Health check
    if (pathname === "/health") {
      return handleHealth(req, res);
    }

    // Method validation
    if (!ALLOWED_METHODS.has(req.method)) {
      return sendJSON(res, 405, {
        error: "Method not allowed"
      });
    }

    // CORS / origin validation
    if (!checkOrigin(req)) {
      return sendJSON(res, 403, {
        error: "Origin not allowed"
      });
    }

    // Preflight
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }

    // Target validation
    const target = validateTarget();

    // Proxy
    await proxyRequest(req, res, target);

  } catch (error) {
    console.error("Function error:", error);

    if (!res.headersSent) {
      sendJSON(res, 500, {
        error: "Internal Server Error",
        message:
          process.env.NODE_ENV === "production"
            ? "Check Vercel Function Logs"
            : error.message
      });
    } else {
      res.destroy(error);
    }
  }
};
