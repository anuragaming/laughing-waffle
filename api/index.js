"use strict";

const https = require("https");
const zlib = require("zlib");

const TIMEOUT = 20000;

const METHODS = new Set([
  "GET", "HEAD", "POST",
  "PUT", "PATCH", "DELETE", "OPTIONS"
]);

// ---------------------------------------------------------------
// Anti-VISIBILITY: injected at the very top of <head> in HTML pages.
// Makes the page always believe the tab is visible and focused.
// ---------------------------------------------------------------
const ANTI_VISIBILITY_SCRIPT = `<script data-anti-visibility>
(function () {
  "use strict";
  try {
    function define(obj, key, getter) {
      try {
        Object.defineProperty(obj, key, { get: getter, configurable: true });
      } catch (e) {}
    }

    var proto = Document.prototype;

    // Fake visibility state
    define(proto, "hidden", function () { return false; });
    define(proto, "visibilityState", function () { return "visible"; });
    define(proto, "webkitHidden", function () { return false; });
    define(proto, "webkitVisibilityState", function () { return "visible"; });
    define(proto, "mozHidden", function () { return false; });
    define(proto, "msHidden", function () { return false; });

    // Fake focus
    try {
      proto.hasFocus = function () { return true; };
    } catch (e) {}

    // Swallow visibility / focus-loss events before any page listener sees them
    var events = [
      "visibilitychange",
      "webkitvisibilitychange",
      "mozvisibilitychange",
      "msvisibilitychange",
      "blur"
    ];

    function stop(e) {
      // Only block window/document level blur, never element blur (forms, inputs)
      if (e.type === "blur" && e.target !== window && e.target !== document) return;
      e.stopImmediatePropagation();
    }

    events.forEach(function (name) {
      window.addEventListener(name, stop, true);
      document.addEventListener(name, stop, true);
    });

    // Block on* handler assignments
    try {
      Object.defineProperty(proto, "onvisibilitychange", {
        get: function () { return null; },
        set: function () {},
        configurable: true
      });
    } catch (e) {}

    try {
      Object.defineProperty(window, "onblur", {
        get: function () { return null; },
        set: function () {},
        configurable: true
      });
    } catch (e) {}
  } catch (e) {}
})();
</script>`;

function sendJSON(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
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

  return target;
}

function getPath(req, base) {
  const incoming = new URL(req.url, "https://internal.invalid");

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

  return destination;
}

function buildHeaders(req, destination) {
  const headers = {};
  const allowed = [
    "accept",
    "accept-language",
    "content-type",
    "content-length",
    "user-agent",
    "if-none-match",
    "if-modified-since",
    "range"
  ];

  for (const key of allowed) {
    if (req.headers[key] !== undefined) {
      headers[key] = req.headers[key];
    }
  }

  headers.host = destination.host;
  headers["accept-encoding"] = "gzip, deflate, br, identity";

  return headers;
}

function decompress(buffer, encoding) {
  return new Promise((resolve, reject) => {
    const methods = {
      gzip: zlib.gunzip,
      "x-gzip": zlib.gunzip,
      deflate: zlib.inflate,
      br: zlib.brotliDecompress
    };

    const method = methods[encoding];

    if (!method) {
      if (!encoding || encoding === "identity") {
        return resolve(buffer);
      }

      return reject(new Error("UNSUPPORTED_CONTENT_ENCODING"));
    }

    method(buffer, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
  });
}

// Is this response an HTML document we can safely inject into?
function isInjectableHtml(contentType) {
  const type = String(contentType || "").toLowerCase();

  if (!type.includes("text/html")) return false;

  const charset = /charset\s*=\s*"?([^;"\s]+)/.exec(type);

  if (charset && !/^utf-?8$/.test(charset[1])) return false;

  return true;
}

// Insert the script as early as possible: right after <head>,
// else after <html>, else at the very beginning.
function injectAntiVisibility(html) {
  if (html.includes("data-anti-visibility")) return html;

  const head = /<head(\s[^>]*)?>/i.exec(html);

  if (head) {
    const index = head.index + head[0].length;
    return html.slice(0, index) + ANTI_VISIBILITY_SCRIPT + html.slice(index);
  }

  const root = /<html(\s[^>]*)?>/i.exec(html);

  if (root) {
    const index = root.index + root[0].length;
    return html.slice(0, index) + ANTI_VISIBILITY_SCRIPT + html.slice(index);
  }

  return ANTI_VISIBILITY_SCRIPT + html;
}

function proxy(req, res, base) {
  return new Promise((resolve) => {
    const destination = getPath(req, base);

    const upstream = https.request({
      hostname: destination.hostname,
      port: destination.port || 443,
      path: destination.pathname + destination.search,
      method: req.method,
      headers: buildHeaders(req, destination),
      timeout: TIMEOUT
    }, (response) => {
      const status = response.statusCode || 502;

      res.statusCode = status;

      // Forward normal response headers.
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;

        const lower = key.toLowerCase();

        if ([
          "connection",
          "transfer-encoding",
          "keep-alive"
        ].includes(lower)) {
          continue;
        }

        // Redirects are passed through unchanged.
        res.setHeader(key, value);
      }

      if (
        req.method === "HEAD" ||
        status === 204 ||
        status === 304
      ) {
        response.resume();
        response.on("end", resolve);
        return;
      }

      const encoding = String(
        response.headers["content-encoding"] || ""
      ).toLowerCase();

      const chunks = [];

      response.on("data", chunk => chunks.push(chunk));

      response.on("end", async () => {
        try {
          const raw = Buffer.concat(chunks);
          let body = await decompress(raw, encoding);

          // Only HTML documents get the Anti-Visibility script.
          // Scripts, JSON, auth flows and redirects stay untouched.
          if (
            status >= 200 &&
            status < 300 &&
            status !== 206 &&
            isInjectableHtml(response.headers["content-type"])
          ) {
            body = Buffer.from(
              injectAntiVisibility(body.toString("utf8")),
              "utf8"
            );

            // An upstream CSP would block the inline script.
            res.removeHeader("content-security-policy");
            res.removeHeader("content-security-policy-report-only");

            // Body changed, so validators from upstream no longer match.
            res.removeHeader("etag");
            res.removeHeader("content-md5");
          }

          res.removeHeader("content-encoding");
          res.removeHeader("content-length");

          res.setHeader("Content-Length", body.length);
          res.end(body);
        } catch (error) {
          console.error("Body processing error:", error.message);

          if (!res.headersSent) {
            sendJSON(res, 502, {
              error: "UPSTREAM_BODY_ERROR"
            });
          } else {
            res.destroy(error);
          }
        }

        resolve();
      });

      response.on("error", error => {
        console.error("Upstream response error:", error.message);
        res.destroy(error);
        resolve();
      });

      res.on("close", resolve);
    });

    upstream.setTimeout(TIMEOUT, () => {
      upstream.destroy(new Error("UPSTREAM_TIMEOUT"));
    });

    upstream.on("error", error => {
      console.error("Upstream error:", error.message);

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
    if (!METHODS.has(req.method)) {
      return sendJSON(res, 405, {
        error: "METHOD_NOT_ALLOWED"
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
        version: "4.1.0",
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
        error: "INTERNAL_SERVER_ERROR"
      });
    } else {
      res.destroy(error);
    }
  }
};
