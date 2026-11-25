"use strict";

const https = require("https");
const zlib = require("zlib");

const TIMEOUT = 20000;

const METHODS = new Set([
  "GET", "HEAD", "POST",
  "PUT", "PATCH", "DELETE", "OPTIONS"
]);

const REWRITABLE = /^(text\/html|text\/css|application\/javascript|text\/javascript|application\/x-javascript|application\/json|text\/xml|application\/xml)/i;

// Tắt bằng env ANTI_VISIBILITY=0 nếu cần
const ANTI_VISIBILITY_ON = process.env.ANTI_VISIBILITY !== "0";

const ANTI_VISIBILITY = `<script>(function(){try{
var d=document;
function def(o,k,v){try{Object.defineProperty(o,k,{get:function(){return v},configurable:true})}catch(e){}}
def(d,'hidden',false);
def(d,'webkitHidden',false);
def(d,'mozHidden',false);
def(d,'msHidden',false);
def(d,'visibilityState','visible');
def(d,'webkitVisibilityState','visible');
d.hasFocus=function(){return true};
var block=['visibilitychange','webkitvisibilitychange','blur','pagehide','freeze','resume'];
function stop(e){
  if(e.target===window||e.target===d||e.target===d.documentElement){
    e.stopImmediatePropagation();
  }
}
block.forEach(function(t){
  window.addEventListener(t,stop,true);
  d.addEventListener(t,stop,true);
});
['onblur','onvisibilitychange','onpagehide'].forEach(function(p){
  [window,d].forEach(function(o){
    try{Object.defineProperty(o,p,{get:function(){return null},set:function(){},configurable:true})}catch(e){}
  });
});
}catch(e){}})();</script>`;

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
  if (target.protocol !== "https:") throw new Error("HTTPS required");

  return target;
}

function getProxyOrigin(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

function resolveURL(req, base) {
  const incoming = new URL(req.url, "https://internal.invalid");

  let pathname = incoming.pathname;

  if (pathname === "/api") {
    pathname = "/";
  } else if (pathname.startsWith("/api/")) {
    pathname = pathname.slice(4);
  }

  const destination = new URL(base.origin);
  destination.pathname = base.pathname.replace(/\/$/, "") + pathname;
  destination.search = incoming.search;

  return destination;
}

function buildHeaders(req, destination, proxyOrigin, base) {
  const headers = {};

  const allowed = [
    "accept",
    "accept-language",
    "content-type",
    "content-length",
    "authorization",
    "cookie",
    "user-agent",
    "if-none-match",
    "if-modified-since",
    "range"
  ];

  for (const key of allowed) {
    if (req.headers[key]) headers[key] = req.headers[key];
  }

  if (req.headers.origin) {
    headers.origin = base.origin;
  }
  if (req.headers.referer) {
    headers.referer = req.headers.referer.replace(proxyOrigin, base.origin);
  }

  headers["accept-encoding"] = "gzip, deflate, identity";
  headers.host = destination.host;

  return headers;
}

function rewriteText(text, base, proxyOrigin) {
  const host = base.host.replace(/\./g, "\\.");
  const re = new RegExp(`(https?:)?(\\\\?/\\\\?/)${host}`, "gi");
  const p = new URL(proxyOrigin);

  return text.replace(re, (match, proto, slashes) => {
    return `${proto ? p.protocol : ""}${slashes}${p.host}`;
  });
}

function injectScript(html) {
  const re = /<head[^>]*>/i;

  if (re.test(html)) {
    return html.replace(re, (m) => m + ANTI_VISIBILITY);
  }

  return ANTI_VISIBILITY + html;
}

function rewriteLocation(location, destination, base, proxyOrigin) {
  try {
    const abs = new URL(location, destination);

    if (abs.host === base.host) {
      let path = abs.pathname;
      const basePath = base.pathname.replace(/\/$/, "");
      if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length) || "/";
      return proxyOrigin + path + abs.search + abs.hash;
    }

    return abs.toString();
  } catch {
    return location;
  }
}

function rewriteCookie(cookie) {
  return cookie
    .replace(/;\s*domain=[^;]*/gi, "")
    .replace(/;\s*samesite=[^;]*/gi, "; SameSite=Lax");
}

function decodeBody(buffer, encoding) {
  return new Promise((resolve, reject) => {
    if (encoding === "gzip") return zlib.gunzip(buffer, (e, r) => (e ? reject(e) : resolve(r)));
    if (encoding === "deflate") return zlib.inflate(buffer, (e, r) => (e ? reject(e) : resolve(r)));
    resolve(buffer);
  });
}

function proxy(req, res, base) {
  return new Promise((resolve) => {
    const destination = resolveURL(req, base);
    const proxyOrigin = getProxyOrigin(req);

    const upstream = https.request({
      hostname: destination.hostname,
      port: destination.port || 443,
      path: destination.pathname + destination.search,
      method: req.method,
      headers: buildHeaders(req, destination, proxyOrigin, base),
      timeout: TIMEOUT
    }, (response) => {
      const status = response.statusCode || 502;
      const contentType = String(response.headers["content-type"] || "");
      const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
      const isHTML = /^text\/html/i.test(contentType);
      const shouldRewrite =
        REWRITABLE.test(contentType) &&
        status !== 204 && status !== 304 &&
        req.method !== "HEAD";

      const excluded = new Set([
        "connection",
        "transfer-encoding",
        "keep-alive",
        "content-security-policy",
        "content-security-policy-report-only",
        "strict-transport-security",
        "x-frame-options"
      ]);

      if (shouldRewrite) {
        excluded.add("content-length");
        excluded.add("content-encoding");
        excluded.add("etag");
      }

      res.statusCode = status;

      for (const [key, value] of Object.entries(response.headers)) {
        const k = key.toLowerCase();
        if (value === undefined || excluded.has(k)) continue;

        if (k === "location") {
          res.setHeader(key, rewriteLocation(String(value), destination, base, proxyOrigin));
        } else if (k === "set-cookie") {
          const list = Array.isArray(value) ? value : [value];
          res.setHeader("Set-Cookie", list.map(rewriteCookie));
        } else {
          res.setHeader(key, value);
        }
      }

      if (!shouldRewrite) {
        response.pipe(res);
        response.on("end", resolve);
        response.on("error", (error) => {
          console.error("Response error:", error.message);
          res.destroy(error);
          resolve();
        });
        res.on("close", resolve);
        return;
      }

      const chunks = [];
      response.on("data", (c) => chunks.push(c));

      response.on("end", async () => {
        try {
          const raw = await decodeBody(Buffer.concat(chunks), encoding);
          let body = raw.toString("utf8");

          body = rewriteText(body, base, proxyOrigin);

          if (isHTML && ANTI_VISIBILITY_ON) {
            body = injectScript(body);
          }

          const out = Buffer.from(body, "utf8");
          res.setHeader("Content-Length", out.length);
          res.end(out);
        } catch (error) {
          console.error("Rewrite error:", error.message);
          if (!res.headersSent) sendJSON(res, 502, { error: "REWRITE_FAILED" });
          else res.destroy(error);
        }
        resolve();
      });

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
      return sendJSON(res, 405, { error: "Method not allowed" });
    }

    const pathname = new URL(req.url, "https://internal.invalid").pathname;

    if (pathname === "/health") {
      return sendJSON(res, 200, {
        status: "ok",
        service: "laughing-waffle",
        version: "3.2.0",
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
      sendJSON(res, 500, { error: "Internal Server Error" });
    } else {
      res.destroy(error);
    }
  }
};
