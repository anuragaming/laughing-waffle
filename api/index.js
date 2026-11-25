
"use strict";

const https = require("https");

const TIMEOUT_MS = 20000;
const HTML_LIMIT = 2 * 1024 * 1024;

const METHODS = new Set([
  "GET", "HEAD", "POST",
  "PUT", "PATCH", "DELETE", "OPTIONS"
]);

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

// Giữ nguyên Anti-VISIBILITY hiện tại.
// Không bổ sung cơ chế né giám sát khác.
const ANTI_VISIBILITY_SCRIPT = `<script data-anti-visibility>
(function () {
  "use strict";

  try {
    function define(obj, key, getter) {
      try {
        Object.defineProperty(obj, key, {
          get: getter,
          configurable: true
        });
      } catch (e) {}
    }

    var proto = Document.prototype;

    define(proto, "hidden", function () {
      return false;
    });

    define(proto, "visibilityState", function () {
      return "visible";
    });

    define(proto, "webkitHidden", function () {
      return false;
    });

    define(proto, "webkitVisibilityState", function () {
      return "visible";
    });

    define(proto, "mozHidden", function () {
      return false;
    });

    define(proto, "msHidden", function () {
      return false;
    });

    try {
      proto.hasFocus = function () {
        return true;
      };
    } catch (e) {}

    var events = [
      "visibilitychange",
      "webkitvisibilitychange",
      "mozvisibilitychange",
      "msvisibilitychange",
      "blur"
    ];

    function stop(e) {
      if (
        e.type === "blur" &&
        e.target !== window &&
        e.target !== document
      ) return;

      e.stopImmediatePropagation();
    }

    events.forEach(function (name) {
      window.addEventListener(name, stop, true);
      document.addEventListener(name, stop, true);
    });

    try {
      Object.defineProperty(proto, "onvisibilitychange", {
        get: function () {
          return null;
        },
        set: function () {},
        configurable: true
      });
    } catch (e) {}

    try {
      Object.defineProperty(window, "onblur", {
        get: function () {
          return null;
        },
        set: function () {},
        configurable: true
      });
    } catch (e) {}

  } catch (e) {}
})();
</script>`;

function sendJSON(res, status, data) {
  if (res.headersSent || res.destroyed) return;

  res.statusCode = status;

  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader("Cache-Control", "no-store");

  res.end(JSON.stringify(data));
}

function getTarget() {
  const value = process.env.TARGET_ORIGIN;

  if (!value) {
    throw new Error("TARGET_ORIGIN_MISSING");
  }

  const target = new URL(value);

  if (target.protocol !== "https:") {
    throw new Error("HTTPS_REQUIRED");
  }

  if (target.username || target.password) {
    throw new Error("URL_CREDENTIALS_NOT_ALLOWED");
  }

  if (target.search || target.hash) {
    throw new Error("INVALID_TARGET_ORIGIN");
  }

  return target;
}

function getDestination(req, base) {
  const incoming = new URL(
    req.url || "/",
    "https://proxy.invalid"
  );

  let pathname = incoming.pathname;

  if (pathname === "/api") {
    pathname = "/";
  } else if (pathname.startsWith("/api/")) {
    pathname = pathname.slice(4);
  }

  const destination = new URL(base);

  destination.pathname =
    base.pathname.replace(/\/+$/, "") +
    "/" +
    pathname.replace(/^\/+/, "");

  destination.search = incoming.search;
  destination.hash = "";

  return destination;
}

function requestHeaders(req, destination) {
  const headers = {};

  const allowed = [
    "accept",
    "accept-language",
    "content-type",
    "content-length",
    "user-agent",
    "cookie",
    "authorization",
    "if-none-match",
    "if-modified-since",
    "range",
    "origin"
  ];

  for (const name of allowed) {
    if (req.headers[name] !== undefined) {
      headers[name] = req.headers[name];
    }
  }

  headers.host = destination.host;
  headers["accept-encoding"] = "identity";

  return headers;
}

function isHtml(type) {
  return /^text\/html(?:\s*;|$)/i.test(
    String(type || "")
  );
}

function injectHtml(html) {
  if (html.includes("data-anti-visibility")) {
    return html;
  }

  const head = /<head(?:\s[^>]*)?>/i.exec(html);

  if (head) {
    const at = head.index + head[0].length;

    return (
      html.slice(0, at) +
      ANTI_VISIBILITY_SCRIPT +
      html.slice(at)
    );
  }

  const root = /<html(?:\s[^>]*)?>/i.exec(html);

  if (root) {
    const at = root.index + root[0].length;

    return (
      html.slice(0, at) +
      ANTI_VISIBILITY_SCRIPT +
      html.slice(at)
    );
  }

  return ANTI_VISIBILITY_SCRIPT + html;
}

function rewriteLocation(value, target, req) {
  if (!value) return value;

  try {
    const resolved = new URL(value, target);

    if (resolved.origin !== target.origin) {
      return value;
    }

    const host =
      req.headers["x-forwarded-host"] ||
      req.headers.host;

    if (!host) return value;

    const proto =
      req.headers["x-forwarded-proto"] || "https";

    return (
      proto +
      "://" +
      host +
      resolved.pathname +
      resolved.search +
      resolved.hash
    );

  } catch (_) {
    return value;
  }
}

function rewriteSetCookie(value) {
  const values = Array.isArray(value)
    ? value
    : [value];

  return values.map(cookie =>
    String(cookie).replace(/;\s*domain=[^;]*/ig, "")
  );
}

function applyCors(req, res) {
  const configured = process.env.CORS_ORIGIN;
  const origin = req.headers.origin;

  if (!configured || !origin || origin !== configured) {
    return;
  }

  res.setHeader(
    "Access-Control-Allow-Origin",
    configured
  );

  res.setHeader("Vary", "Origin");

  res.setHeader(
    "Access-Control-Allow-Credentials",
    "true"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );

  res.setHeader("Access-Control-Max-Age", "600");
}

function copyResponseHeaders(
  response,
  res,
  req,
  target,
  bodyWillChange
) {
  for (const [name, value] of Object.entries(
    response.headers
  )) {
    if (value === undefined) continue;

    const lower = name.toLowerCase();

    if (
      HOP_HEADERS.has(lower) ||
      lower === "content-length" ||
      lower === "content-encoding"
    ) {
      continue;
    }

    if (lower === "location") {
      res.setHeader(
        name,
        rewriteLocation(value, target, req)
      );
    } else if (lower === "set-cookie") {
      res.setHeader(
        name,
        rewriteSetCookie(value)
      );
    } else if (
      bodyWillChange &&
      ["etag", "content-md5", "content-range"].includes(lower)
    ) {
      continue;
    } else {
      res.setHeader(name, value);
    }
  }

  if (bodyWillChange) {
    res.removeHeader("content-length");
  }
}

function proxy(req, res, target) {
  return new Promise(resolve => {
    let settled = false;

    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    let destination;

    try {
      destination = getDestination(req, target);
    } catch (_) {
      sendJSON(res, 400, {
        error: "INVALID_REQUEST_URL"
      });

      finish();
      return;
    }

    const upstream = https.request({
      protocol: "https:",
      hostname: destination.hostname,
      port: destination.port || 443,
      path: destination.pathname + destination.search,
      method: req.method,
      headers: requestHeaders(req, destination),
      timeout: TIMEOUT_MS

    }, response => {

      const status = response.statusCode || 502;

      const contentType =
        response.headers["content-type"] || "";

      const charsetMatch =
        /charset\s*=\s*"?([^;"\s]+)/i.exec(contentType);

      const utf8 =
        !charsetMatch ||
        /^utf-?8$/i.test(charsetMatch[1]);

      const canInject =
        status >= 200 &&
        status < 300 &&
        status !== 206 &&
        req.method !== "HEAD" &&
        isHtml(contentType) &&
        utf8;

      res.statusCode = status;

      copyResponseHeaders(
        response,
        res,
        req,
        target,
        canInject
      );

      if (
        req.method === "HEAD" ||
        status === 204 ||
        status === 304
      ) {
        response.resume();
        response.on("end", finish);
        return;
      }

      // Non-HTML: stream directly.
      if (!canInject) {
        response.pipe(res);

        response.on("end", finish);

        response.on("error", error => {
          if (!res.destroyed) {
            res.destroy(error);
          }

          finish();
        });

        return;
      }

      // HTML: bounded buffering for safe content modification.
      const chunks = [];

      let size = 0;
      let overflow = false;

      response.on("data", chunk => {
        size += chunk.length;

        if (size > HTML_LIMIT) {
          overflow = true;
          chunks.length = 0;

          response.destroy(
            new Error("HTML_RESPONSE_TOO_LARGE")
          );

        } else if (!overflow) {
          chunks.push(chunk);
        }
      });

      response.on("end", () => {
        if (overflow) return;

        try {
          const html = Buffer.concat(chunks)
            .toString("utf8");

          const output = Buffer.from(
            injectHtml(html),
            "utf8"
          );

          res.setHeader(
            "Content-Length",
            String(output.length)
          );

          res.end(output);

        } catch (error) {
          console.error(
            "HTML processing error:",
            error.message
          );

          if (!res.headersSent) {
            sendJSON(res, 502, {
              error: "HTML_PROCESSING_FAILED"
            });
          } else {
            res.destroy(error);
          }
        }

        finish();
      });

      response.on("error", error => {
        console.error(
          "Upstream HTML error:",
          error.message
        );

        if (!res.destroyed) {
          if (!res.headersSent) {
            sendJSON(res, 502, {
              error: "UPSTREAM_RESPONSE_ERROR"
            });
          } else {
            res.destroy(error);
          }
        }

        finish();
      });
    });

    upstream.setTimeout(TIMEOUT_MS, () => {
      upstream.destroy(
        new Error("UPSTREAM_TIMEOUT")
      );
    });

    upstream.on("error", error => {
      console.error(
        "Upstream request error:",
        error.message
      );

      if (!res.headersSent) {
        sendJSON(
          res,
          error.message === "UPSTREAM_TIMEOUT"
            ? 504
            : 502,
          {
            error:
              error.message === "UPSTREAM_TIMEOUT"
                ? "UPSTREAM_TIMEOUT"
                : "UPSTREAM_REQUEST_FAILED"
          }
        );

      } else if (!res.destroyed) {
        res.destroy(error);
      }

      finish();
    });

    res.on("close", () => {
      if (
        !res.writableEnded &&
        !upstream.destroyed
      ) {
        upstream.destroy();
      }

      finish();
    });

    req.on("aborted", () => {
      upstream.destroy();
      finish();
    });

    if (
      req.method === "GET" ||
      req.method === "HEAD"
    ) {
      upstream.end();
    } else {
      req.pipe(upstream);
    }
  });
}

module.exports = async function handler(req, res) {
  applyCors(req, res);

  try {
    if (!METHODS.has(req.method)) {
      res.setHeader(
        "Allow",
        "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
      );

      return sendJSON(res, 405, {
        error: "METHOD_NOT_ALLOWED"
      });
    }

    const pathname = new URL(
      req.url || "/",
      "https://proxy.invalid"
    ).pathname;

    if (pathname === "/health") {
      return sendJSON(res, 200, {
        status: "ok",
        service: "laughing-waffle",
        version: "5.0.0",
        runtime: "nodejs",
        timestamp: new Date().toISOString()
      });
    }

    if (req.method === "OPTIONS") {
      if (
        req.headers.origin &&
        process.env.CORS_ORIGIN !== req.headers.origin
      ) {
        return sendJSON(res, 403, {
          error: "CORS_ORIGIN_NOT_ALLOWED"
        });
      }

      res.statusCode = 204;
      return res.end();
    }

    const target = getTarget();

    await proxy(req, res, target);

  } catch (error) {
    console.error(
      "Handler error:",
      error.message
    );

    sendJSON(res, 500, {
      error:
        error.message === "TARGET_ORIGIN_MISSING"
          ? "TARGET_ORIGIN_MISSING"
          : "INTERNAL_SERVER_ERROR"
    });
  }
};
