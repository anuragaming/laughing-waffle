
const TARGET_ORIGIN = process.env.TARGET_ORIGIN;
const REQUEST_TIMEOUT = 20000;

const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS"
]);

const REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "content-length",
  "authorization",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "range"
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, If-None-Match",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(origin)
    }
  });
}

function getAllowedOrigin(request) {
  const origin = request.headers.get("Origin");

  if (!origin) return null;

  try {
    const parsed = new URL(origin);

    if (parsed.protocol !== "https:") return null;

    return parsed.origin;
  } catch {
    return null;
  }
}

function createTargetUrl(request) {
  const incoming = new URL(request.url);
  const target = new URL(TARGET_ORIGIN);

  target.pathname =
    incoming.pathname === "/api"
      ? "/"
      : incoming.pathname.replace(/^\/api(?=\/)/, "");

  target.search = incoming.search;

  return target;
}

function createRequestHeaders(request, target) {
  const headers = new Headers();

  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  headers.set("Host", target.host);

  return headers;
}

function createResponseHeaders(upstream, origin) {
  const headers = new Headers();

  const allowed = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
    "expires",
    "vary"
  ];

  for (const name of allowed) {
    const value = upstream.headers.get(name);

    if (value) {
      headers.set(name, value);
    }
  }

  Object.assign(
    Object.fromEntries(headers.entries()),
    corsHeaders(origin)
  );

  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }

  headers.set("X-Content-Type-Options", "nosniff");

  return headers;
}

export default async function handler(request) {
  const origin = getAllowedOrigin(request);

  if (request.method === "OPTIONS") {
    if (!origin) {
      return new Response(null, { status: 403 });
    }

    return new Response(null, {
      status: 204,
      headers: corsHeaders(origin)
    });
  }

  if (!TARGET_ORIGIN) {
    return jsonResponse({
      error: "TARGET_ORIGIN is not configured"
    }, 500, origin || "null");
  }

  if (!origin) {
    return jsonResponse({
      error: "Origin not allowed"
    }, 403, "null");
  }

  if (!ALLOWED_METHODS.has(request.method)) {
    return jsonResponse({
      error: "Method not allowed"
    }, 405, origin);
  }

  let target;

  try {
    target = createTargetUrl(request);

    if (target.protocol !== "https:") {
      throw new Error("HTTPS required");
    }
  } catch {
    return jsonResponse({
      error: "Invalid target configuration"
    }, 500, origin);
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT
  );

  try {
    const headers = createRequestHeaders(request, target);

    const init = {
      method: request.method,
      headers,
      redirect: "manual",
      signal: controller.signal
    };

    if (
      request.method !== "GET" &&
      request.method !== "HEAD"
    ) {
      init.body = request.body;
      init.duplex = "half";
    }

    const upstream = await fetch(target, init);

    const responseHeaders = createResponseHeaders(
      upstream,
      origin
    );

    // Do not rewrite external authentication redirects.
    if (
      upstream.status >= 300 &&
      upstream.status < 400
    ) {
      return new Response(null, {
        status: upstream.status,
        headers: responseHeaders
      });
    }

    // Stream the response instead of buffering it in memory.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders
    });

  } catch (error) {
    const isTimeout = error.name === "AbortError";

    console.error("Proxy error:", {
      message: error.message,
      target: target.origin,
      timeout: isTimeout
    });

    return jsonResponse({
      error: isTimeout
        ? "Upstream timeout"
        : "Upstream connection failed"
    }, isTimeout ? 504 : 502, origin);

  } finally {
    clearTimeout(timeout);
  }
}
