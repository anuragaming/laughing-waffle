const BASE_DOMAIN = 'k12online.vn';
const BASE_RE = BASE_DOMAIN.replace(/\./g, '\\.');
const TENANT_COOKIE = 'tenant_host';

// Chỉ cho phép proxy tới k12online.vn và subdomain của nó (chống bị lợi dụng làm open proxy)
const isAllowedHost = (h) => h === BASE_DOMAIN || h.endsWith('.' + BASE_DOMAIN);

const tenantCookie = (host) =>
  `${TENANT_COOKIE}=${host}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;

// Chỉ inject vào HTML. KHÔNG inject vào JS/JSON/CSS (lỗi cũ gây vỡ toàn bộ JS)
const SPOOF_SCRIPT = `<script>(function(){try{
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = function(){ return Promise.resolve(); };
  }
}catch(e){}})();</script>`;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const proxyOrigin = url.origin;

    // Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': request.headers.get('access-control-request-headers') || '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // 1. Xác định tenant từ cookie (chỉ tin host hợp lệ)
    const cookieHeader = request.headers.get('cookie') || '';
    const m = cookieHeader.match(/(?:^|;\s*)tenant_host=([^;]+)/);
    let targetHost = BASE_DOMAIN;
    if (m && isAllowedHost(m[1].trim())) targetHost = m[1].trim();

    const targetDomain = 'https://' + targetHost;
    // Giữ nguyên path, KHÔNG cắt prefix nữa (regex cũ cắt nhầm /api, /static, /assets...)
    const targetUrl = targetDomain + url.pathname + url.search;

    try {
      // 2. Chuẩn bị request gửi đi
      const newHeaders = new Headers(request.headers);
      [
        'host', 'referer', 'accept-encoding', 'x-forwarded-host',
        'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
        'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'sec-fetch-site'
      ].forEach((h) => newHeaders.delete(h));

      // Không gửi cookie nội bộ của proxy lên server gốc
      const cleanedCookie = cookieHeader
        .split(';')
        .map((s) => s.trim())
        .filter((c) => c && !c.startsWith(TENANT_COOKIE + '='))
        .join('; ');
      if (cleanedCookie) newHeaders.set('cookie', cleanedCookie);
      else newHeaders.delete('cookie');

      newHeaders.set('origin', targetDomain);
      newHeaders.set('referer', targetDomain + '/');

      const fetchInit = { method: request.method, headers: newHeaders, redirect: 'manual' };
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        fetchInit.body = await request.arrayBuffer();
      }

      const response = await fetch(targetUrl, fetchInit);
      const responseHeaders = new Headers(response.headers);

      [
        'content-encoding', 'content-length', 'transfer-encoding', 'connection',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security', 'report-to', 'set-cookie'
      ].forEach((h) => responseHeaders.delete(h));

      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');

      // 3. Cookie: bỏ Domain gốc để trình duyệt nhận trên domain proxy
      const cookiesToSet = [];
      const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      for (const cookie of rawCookies) {
        let c = cookie.replace(/;\s*Domain=[^;]*/ig, '');
        if (!/;\s*path=/i.test(c)) c += '; Path=/';
        cookiesToSet.push(c.trim());
      }
      const flushCookies = () => cookiesToSet.forEach((c) => responseHeaders.append('Set-Cookie', c));

      // 4. Redirect
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let locUrl = null;
          try { locUrl = new URL(location, targetDomain); } catch (e) { /* ignore */ }

          if (locUrl && isAllowedHost(locUrl.hostname)) {
            const newPath = locUrl.pathname + locUrl.search + locUrl.hash;

            // Chặn loop: redirect về chính nó
            if (locUrl.hostname === targetHost && newPath === url.pathname + url.search) {
              flushCookies();
              return new Response(null, { status: 204, headers: responseHeaders });
            }

            // Tenant chỉ đổi khi server gốc chủ động redirect sang host khác
            if (locUrl.hostname !== targetHost) cookiesToSet.push(tenantCookie(locUrl.hostname));

            flushCookies();
            responseHeaders.set('Location', proxyOrigin + newPath);
            return new Response(null, { status: response.status, headers: responseHeaders });
          }
        }
      }

      // 5. Xử lý nội dung text
      const ct = (response.headers.get('content-type') || '').toLowerCase();
      const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
      const isRewritable =
        isHtml || ct.includes('text/css') || ct.includes('javascript') || ct.includes('json');

      if (isRewritable) {
        let text = await response.text();

        // URL tuyệt đối: https://xxx.k12online.vn -> domain proxy
        text = text.replace(
          new RegExp(`https?://(?:[a-zA-Z0-9-]+\\.)*${BASE_RE}`, 'g'),
          () => proxyOrigin
        );
        // URL bị escape trong JSON: https:\/\/xxx.k12online.vn
        const escapedProxy = proxyOrigin.replace(/\//g, '\\/');
        text = text.replace(
          new RegExp(`https?:\\\\/\\\\/(?:[a-zA-Z0-9-]+\\.)*${BASE_RE}`, 'g'),
          () => escapedProxy
        );
        // Protocol-relative: //xxx.k12online.vn
        text = text.replace(
          new RegExp(`(["'(=])//(?:[a-zA-Z0-9-]+\\.)*${BASE_RE}`, 'g'),
          (_, p1) => p1 + proxyOrigin
        );

        if (isHtml) {
          if (/<head[^>]*>/i.test(text)) {
            text = text.replace(/<head[^>]*>/i, (tag) => tag + SPOOF_SCRIPT);
          } else if (/<body[^>]*>/i.test(text)) {
            text = text.replace(/<body[^>]*>/i, (tag) => tag + SPOOF_SCRIPT);
          } else {
            text = SPOOF_SCRIPT + text;
          }
          // Xóa meta refresh
          text = text.replace(/<meta\s+[^>]*http-equiv=["']refresh["'][^>]*>/gi, '');
        }

        flushCookies();
        return new Response(text, { status: response.status, headers: responseHeaders });
      }

      // 6. Còn lại (ảnh, font, pdf, event-stream...): stream thẳng, không buffer
      flushCookies();
      return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error', details: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
