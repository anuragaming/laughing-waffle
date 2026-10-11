import { Readable } from 'node:stream';

export const config = {
  api: { bodyParser: false }
};

const BASE_DOMAIN = 'k12online.vn';
const HEADER_TIMEOUT_MS = 20000; // chờ upstream trả header tối đa 20s, quá là báo lỗi luôn chứ ko treo

// Header ko được forward lên upstream
const DROP_REQ_HEADERS = new Set([
  'host', 'referer', 'accept-encoding', 'content-length', 'connection',
  'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'expect', 'proxy-connection'
]);

// Header ko được trả về cho client
const DROP_RES_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'set-cookie'
]);

export default async function handler(req, res) {
  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
  const proxyDomain = 'https://' + proxyHost;

  // ---------- /__ping : test tốc độ Vercel -> k12online.vn ----------
  if (req.url.startsWith('/__ping')) {
    const t0 = Date.now();
    try {
      const r = await fetch('https://' + BASE_DOMAIN + '/', {
        redirect: 'manual',
        signal: AbortSignal.timeout(15000)
      });
      return res.status(200).json({
        ok: true, upstreamStatus: r.status, ms: Date.now() - t0,
        vercelRegion: process.env.VERCEL_REGION || 'unknown'
      });
    } catch (e) {
      return res.status(200).json({
        ok: false, error: String(e && (e.cause?.code || e.name || e.message)),
        ms: Date.now() - t0, vercelRegion: process.env.VERCEL_REGION || 'unknown'
      });
    }
  }

  // 1. Kiểm tra Cookie
  let targetHost = BASE_DOMAIN;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/tenant_host=([^;]+)/);
  if (match) targetHost = match[1];

  const targetDomain = 'https://' + targetHost;
  const targetUrl = targetDomain + req.url;

  const prefixMatch = req.url.match(/^\/([a-zA-Z0-9-]+)(?=\/)/);
  const tenantPrefix = prefixMatch ? prefixMatch[0] : '';

  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEADER_TIMEOUT_MS);

  try {
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      if (buffers.length) body = Buffer.concat(buffers);
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (DROP_REQ_HEADERS.has(key)) continue;
      if (key.startsWith('x-vercel') || key.startsWith('x-forwarded') || key === 'x-real-ip') continue;
      headers[key] = v;
    }
    // ko gửi cookie nội bộ tenant_host lên upstream
    if (headers.cookie) {
      headers.cookie = headers.cookie.split(';').map(s => s.trim())
        .filter(s => !s.startsWith('tenant_host=')).join('; ');
      if (!headers.cookie) delete headers.cookie;
    }
    if (headers.origin) headers.origin = targetDomain;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: ctrl.signal
    });
    clearTimeout(timer); // đã có header rồi, ko cần timeout nữa (để video/file lớn stream thoải mái)

    console.log(`[proxy] ${req.method} ${targetHost}${req.url} -> ${response.status} (${Date.now() - t0}ms)`);

    response.headers.forEach((value, key) => {
      if (!DROP_RES_HEADERS.has(key.toLowerCase())) {
        try { res.setHeader(key, value); } catch (_) {}
      }
    });

    let cookiesToSet = [];
    if (typeof response.headers.getSetCookie === 'function') {
      cookiesToSet = response.headers.getSetCookie().map(c => c.replace(/Domain=[^;]+;?\s*/ig, ''));
    }

    // 2. XỬ LÝ CHUYỂN HƯỚNG
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        let locUrl;
        try { locUrl = new URL(location, targetDomain); } catch (e) { locUrl = null; }

        if (locUrl && locUrl.hostname.includes(BASE_DOMAIN)) {
          let newPath = locUrl.pathname + locUrl.search;

          if (tenantPrefix && !newPath.startsWith(tenantPrefix)) {
            if (/^\/(page|LMS|module|api|assets)\//i.test(locUrl.pathname)) {
              newPath = tenantPrefix + newPath;
            }
          }

          const reqPathname = new URL(req.url, proxyDomain).pathname;
          const locPathname = new URL(newPath, proxyDomain).pathname;

          if (locUrl.hostname === targetHost && reqPathname === locPathname) {
            res.removeHeader('Location');
            res.status(200).send('<html><body><h1>Đã chặn vòng lặp Redirect. Vui lòng tải lại trang (F5).</h1></body></html>');
            return;
          }

          cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=86400`);
          res.setHeader('Set-Cookie', cookiesToSet);
          res.setHeader('Location', proxyDomain + newPath);
          res.statusCode = response.status;
          return res.end();
        }
        res.setHeader('Location', location);
        if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet);
        res.statusCode = response.status;
        return res.end();
      }
    }

    // 3. XỬ LÝ TEXT (HTML, JSON, JS, CSS)
    const contentType = response.headers.get('content-type') || '';
    const isTextContent = contentType.includes('text/') ||
                          contentType.includes('application/json') ||
                          contentType.includes('javascript') ||
                          contentType.includes('application/x-javascript');

    if (isTextContent && req.method !== 'HEAD') {
      let text = await response.text();
      let foundTenant = null;

      const regexSub = new RegExp(`https:\\\\?/\\\\?/([a-zA-Z0-9-]+)\\.${BASE_DOMAIN.replace(/\./g, '\\.')}`, 'g');
      text = text.replace(regexSub, (m, subdomain) => {
        foundTenant = subdomain + '.' + BASE_DOMAIN;
        return m.includes('\\/') ? proxyDomain.replace(/\//g, '\\/') : proxyDomain;
      });

      const regexRoot = new RegExp(`https:\\\\?/\\\\?/${BASE_DOMAIN.replace(/\./g, '\\.')}`, 'g');
      text = text.replace(regexRoot, m => {
        return m.includes('\\/') ? proxyDomain.replace(/\//g, '\\/') : proxyDomain;
      });

      if (foundTenant && foundTenant !== targetHost) {
        cookiesToSet.push(`tenant_host=${foundTenant}; Path=/; HttpOnly; Max-Age=86400`);
      }
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet);

      if (contentType.includes('text/html')) {
        if (tenantPrefix) {
          const relativePathRegex = /(href|action|src)=(["'])(\/(?:page|LMS|module|api|assets)[^"']*)/gi;
          text = text.replace(relativePathRegex, (m, attr, quote, path) => {
            if (path.startsWith(tenantPrefix)) return m;
            return `${attr}=${quote}${tenantPrefix}${path}`;
          });
        }

        text = text.replace(/<script[^>]*src=["'][^"']*(adsbygoogle|popunder|adzone|doubleclick|adsystem)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');

        const injectedScript = `
          <script>
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            const blockVisibility = (e) => { e.stopImmediatePropagation(); e.stopPropagation(); };
            window.addEventListener('visibilitychange', blockVisibility, true);
            document.addEventListener('visibilitychange', blockVisibility, true);

            const originalWindowOpen = window.open;
            window.open = function(url, name, specs) {
                if (typeof url === 'string' && /(ads|popunder|adsystem|track|doubleclick)/i.test(url)) return null;
                return originalWindowOpen.apply(this, arguments);
            };

            const observer = new MutationObserver(mutations => {
              mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                  if (node.tagName === 'SCRIPT' && node.src && /(adsbygoogle|popunder|adzone|adsystem)/i.test(node.src)) {
                      node.type = 'javascript/blocked'; node.remove();
                  }
                });
              });
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
          </script>
        `;
        text = text.replace(/<head[^>]*>/i, m => m + injectedScript);
      }

      res.status(response.status).send(text);
      return;
    }

    // 4. FILE NHỊ PHÂN: pipe thẳng, có backpressure
    if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet);
    res.statusCode = response.status;

    if (!response.body || req.method === 'HEAD') return res.end();

    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.on('error', (e) => {
      console.error('[proxy] stream error:', e && e.message);
      res.destroy(e);
    });
    res.on('close', () => nodeStream.destroy());
    nodeStream.pipe(res);

  } catch (error) {
    clearTimeout(timer);
    const isTimeout = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    console.error(`[proxy] FAIL ${req.method} ${targetHost}${req.url} (${Date.now() - t0}ms):`,
      error && (error.cause?.code || error.name), error && error.message);

    if (res.headersSent) return res.end();
    res.status(isTimeout ? 504 : 502).send(
      `<html><body style="font-family:sans-serif;padding:20px">
        <h3>${isTimeout ? 'Upstream phản hồi quá chậm (timeout)' : 'Proxy ko kết nối được tới upstream'}</h3>
        <p>Target: ${targetHost}</p>
        <p>Lỗi: ${String(error && (error.cause?.code || error.name || error.message))}</p>
        <p>Thử xoá cookie site này rồi tải lại. Test tốc độ: <a href="/__ping">/__ping</a></p>
      </body></html>`
    );
  }
}
