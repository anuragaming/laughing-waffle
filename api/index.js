export default {
  async fetch(request, env, ctx) {
    // 1. Xử lý CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Credentials': 'true'
        }
      });
    }

    const url = new URL(request.url);
    const proxyDomain = url.origin; // Domain trung gian của bạn (Ví dụ: https://your-proxy.com)
    
    // CẤU HÌNH TARGET: Bạn có thể đổi thành bất kỳ domain nào họ xoay sang
    // Hiện tại đang đặt là subdomain cụ thể mà bạn đã cung cấp
    const targetHost = 'quangngai.k12online.vn'; 
    const targetDomain = 'https://' + targetHost;
    
    // Xây dựng URL đích để fetch
    const targetUrl = targetDomain + url.pathname + url.search;

    try {
      // 2. Xử lý Headers gửi đi (Giả mạo trình duyệt)
      const newHeaders = new Headers(request.headers);
      const headersToRemove = [
        'host', 'referer', 'accept-encoding', 'x-forwarded-host',
        'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
        'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'sec-fetch-site'
      ];
      headersToRemove.forEach(h => newHeaders.delete(h));
      
      newHeaders.set('Host', targetHost);
      newHeaders.set('Origin', targetDomain);
      newHeaders.set('Referer', targetDomain + '/');

      const fetchInit = {
        method: request.method,
        headers: newHeaders,
        redirect: 'manual' // CỰC KỲ QUAN TRỌNG: Không cho phép fetch tự động redirect, để Worker tự xử lý
      };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        fetchInit.body = await request.clone().arrayBuffer();
      }

      // 3. Fetch dữ liệu từ target
      const response = await fetch(targetUrl, fetchInit);
      const responseHeaders = new Headers(response.headers);
      
      // 4. Xóa các header bảo mật/chống nhúng
      const headersToDrop = [
        'content-encoding', 'content-length', 'transfer-encoding', 'connection',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security', 'report-to',
        'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy'
      ];
      headersToDrop.forEach(h => responseHeaders.delete(h));

      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');

      // 5. Xử lý Cookie (Giữ session, xóa domain gốc để trình duyệt chấp nhận trên proxy)
      const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      responseHeaders.delete('set-cookie');
      for (const cookie of rawCookies) {
        let cleanCookie = cookie
          .replace(/Domain=[^;]+;?\s*/ig, '') // Xóa domain gốc
          .replace(/SameSite=[^;]+;?\s*/ig, '; SameSite=Lax'); 
        if (!cleanCookie.toLowerCase().includes('path=')) {
          cleanCookie += '; Path=/';
        }
        responseHeaders.append('Set-Cookie', cleanCookie.trim());
      }

      // ============================================================
      // 6. BẼ LÁI REDIRECT (CHỐT CHẶN CHÍNH): 
      // Nếu server gốc trả về 301/302/307/308 với Location là domain thật,
      // ta sẽ cắt bỏ domain thật đó và thay bằng proxyDomain.
      // ============================================================
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let newLoc = location;
          
          // Nếu là absolute URL (http://... hoặc https://...), thay thế toàn bộ phần domain bằng proxyDomain
          newLoc = newLoc.replace(/^https?:\/\/[^\/]+/i, proxyDomain);
          
          // Nếu là protocol-relative URL (//quangngai.k12online.vn/...), thay bằng proxyDomain
          newLoc = newLoc.replace(/^\/\/[^\/]+/i, proxyDomain);
          
          // Nếu là relative URL (/page/home), giữ nguyên, trình duyệt sẽ tự ghép vào proxyDomain
          
          responseHeaders.set('Location', newLoc);
          return new Response(null, { status: response.status, headers: responseHeaders });
        }
      }

      // 7. Xử lý nội dung HTML/JS/CSS
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      const isJsOrCss = contentType.includes('javascript') || contentType.includes('css');

      if (isHtml || isJsOrCss) {
        let text = await response.text();

        // ============================================================
        // A. THAY THẾ DOMAIN TRONG SOURCE CODE
        // Thay thế mọi biến thể của k12online.vn (có hoặc không có subdomain)
        // ============================================================
        const targetRegex = /https?:\/\/(?:[a-zA-Z0-9-]+\.)?k12online\.vn/gi;
        const protocolRelativeRegex = /\/\/(?:[a-zA-Z0-9-]+\.)?k12online\.vn/gi;
        
        text = text.replace(targetRegex, proxyDomain);
        text = text.replace(protocolRelativeRegex, proxyDomain);

        // ============================================================
        // B. INJECTED CAGE SCRIPT (LỒNG KÍNH JS)
        // Chạy NGAY LẬP TỨC để giả mạo window.location trước khi site JS kịp kiểm tra
        // ============================================================
        const cageScript = `<script>
        (function() {
          const PROXY_ORIGIN = '${proxyDomain}';
          const PROXY_HOSTNAME = new URL(PROXY_ORIGIN).hostname;

          // 1. GIẢ MẠO WINDOW.LOCATION (Chặn JS kiểm tra hostname để redirect)
          Object.defineProperty(window.location, 'hostname', { get: () => PROXY_HOSTNAME, configurable: true });
          Object.defineProperty(window.location, 'host', { get: () => new URL(PROXY_ORIGIN).host, configurable: true });
          Object.defineProperty(window.location, 'origin', { get: () => PROXY_ORIGIN, configurable: true });
          Object.defineProperty(window.location, 'href', { 
            get: () => PROXY_ORIGIN + window.location.pathname + window.location.search, 
            configurable: true 
          });

          // 2. CHẶN ANTI-RETURN / VISIBILITY DETECTOR
          const overrideProp = (obj, prop, value) => {
            try {
              Object.defineProperty(obj, prop, { get: () => value, set: () => {}, configurable: true });
            } catch(e) {}
          };
          overrideProp(Document.prototype, 'hidden', false);
          overrideProp(Document.prototype, 'visibilityState', 'visible');
          overrideProp(Document.prototype, 'webkitHidden', false);
          overrideProp(Document.prototype, 'webkitVisibilityState', 'visible');
          overrideProp(document, 'hidden', false);
          overrideProp(document, 'visibilityState', 'visible');

          // Chặn event listener
          const originalAddEventListener = EventTarget.prototype.addEventListener;
          EventTarget.prototype.addEventListener = function(type, listener, options) {
            const detectEvents = ['visibilitychange', 'webkitvisibilitychange', 'blur', 'focus', 'mouseleave', 'mouseenter', 'pagehide', 'pageshow', 'beforeunload', 'unload'];
            if (detectEvents.includes(type)) {
              const wrappedListener = function(e) {
                e.preventDefault();
                e.stopImmediatePropagation();
                e.stopPropagation();
                return false;
              };
              return originalAddEventListener.call(this, type, wrappedListener, options);
            }
            return originalAddEventListener.call(this, type, listener, options);
          };

          // 3. VÔ HIỆU HÓA navigator.sendBeacon
          if (navigator.sendBeacon) {
            navigator.sendBeacon = function(url, data) { return true; };
          }

          // 4. BẼ LÁI FETCH & XHR (Nếu JS cố gọi API sang domain thật)
          const originalFetch = window.fetch;
          window.fetch = function(input, init) {
            let targetUrl = typeof input === 'string' ? input : input.url;
            if (typeof targetUrl === 'string' && targetUrl.startsWith('http') && !targetUrl.startsWith(PROXY_ORIGIN)) {
              try {
                const parsed = new URL(targetUrl);
                targetUrl = PROXY_ORIGIN + parsed.pathname + parsed.search;
              } catch(e) {}
            }
            return originalFetch.call(this, typeof input === 'string' ? targetUrl : new Request(targetUrl, input), init);
          };

          const originalXHROpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
            if (typeof url === 'string' && url.startsWith('http') && !url.startsWith(PROXY_ORIGIN)) {
              try {
                const parsed = new URL(url);
                url = PROXY_ORIGIN + parsed.pathname + parsed.search;
              } catch(e) {}
            }
            return originalXHROpen.call(this, method, url, async, user, password);
          };

          // 5. CHẶN WINDOW.LOCATION ASSIGN/REPLACE
          const originalAssign = window.location.assign;
          window.location.assign = function(url) {
            try {
              const parsed = new URL(url, window.location.origin);
              return originalAssign.call(window.location, PROXY_ORIGIN + parsed.pathname + parsed.search);
            } catch(e) { return originalAssign.call(window.location, url); }
          };
          
          const originalReplace = window.location.replace;
          window.location.replace = function(url) {
            try {
              const parsed = new URL(url, window.location.origin);
              return originalReplace.call(window.location, PROXY_ORIGIN + parsed.pathname + parsed.search);
            } catch(e) { return originalReplace.call(window.location, url); }
          };

          // Xóa handler inline
          window.onblur = window.onfocus = window.onpagehide = window.onpageshow = window.onvisibilitychange = null;
          document.onvisibilitychange = null;
        })();
        <\/script>`;

        // Inject vào vị trí sớm nhất có thể
        if (text.includes('<head>')) {
          text = text.replace('<head>', `<head><base href="${proxyDomain}/">` + cageScript);
        } else if (text.includes('<body>')) {
          text = text.replace('<body>', `<body>` + cageScript);
        } else {
          text = cageScript + text;
        }

        // Xóa meta refresh
        text = text.replace(/<meta\s+[^>]*http-equiv=["']refresh["'][^>]*>/gi, '');

        return new Response(text, { status: response.status, headers: responseHeaders });
      }

      // 8. Trả về các tài nguyên khác (ảnh, font, v.v.)
      return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy Gateway Error', details: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
}
