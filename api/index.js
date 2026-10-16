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
    const proxyDomain = url.origin; // Domain trung gian của bạn
    
    // Domain gốc mặc định (chỉ dùng làm fallback nếu không phát hiện được domain xoay)
    const defaultTargetHost = 'k12online.vn'; 
    const defaultTargetDomain = 'https://' + defaultTargetHost;
    
    // Cố gắng lấy target từ header tùy chỉnh nếu bạn có cơ chế chuyển mạch domain động
    const targetDomain = request.headers.get('x-proxy-target') || defaultTargetDomain;
    const targetUrl = targetDomain + url.pathname + url.search;

    try {
      // 2. Xử lý Headers gửi đi
      const newHeaders = new Headers(request.headers);
      const headersToRemove = [
        'host', 'referer', 'accept-encoding', 'x-forwarded-host',
        'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
        'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'sec-fetch-site'
      ];
      headersToRemove.forEach(h => newHeaders.delete(h));
      
      // Lấy host từ targetDomain để giả mạo chính xác
      const targetHost = new URL(targetDomain).host;
      newHeaders.set('Host', targetHost);
      newHeaders.set('Origin', targetDomain);
      newHeaders.set('Referer', targetDomain + '/');

      const fetchInit = {
        method: request.method,
        headers: newHeaders,
        redirect: 'manual' // QUAN TRỌNG: Giữ quyền kiểm soát mọi redirect
      };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        fetchInit.body = await request.clone().arrayBuffer();
      }

      // 3. Fetch dữ liệu
      const response = await fetch(targetUrl, fetchInit);
      const responseHeaders = new Headers(response.headers);
      
      // 4. Xóa headers chống nhúng và bảo mật gây lỗi
      const headersToDrop = [
        'content-encoding', 'content-length', 'transfer-encoding', 'connection',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security', 'report-to',
        'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy'
      ];
      headersToDrop.forEach(h => responseHeaders.delete(h));

      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');

      // 5. Xử lý Cookie (Giữ session, ép về Path=/)
      const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      responseHeaders.delete('set-cookie');
      for (const cookie of rawCookies) {
        let cleanCookie = cookie
          .replace(/Domain=[^;]+;?\s*/ig, '') // Xóa domain gốc
          .replace(/SameSite=[^;]+;?\s*/ig, '; SameSite=Lax'); // Tránh bị chặn cross-site
        if (!cleanCookie.toLowerCase().includes('path=')) {
          cleanCookie += '; Path=/';
        }
        responseHeaders.append('Set-Cookie', cleanCookie.trim());
      }

      // 6. XỬ LÝ REDIRECT: Bẻ lái MỌI redirect về lại proxyDomain
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let locUrl;
          try { 
            // Parse URL mới, kể cả nó là domain lạ
            locUrl = new URL(location, targetDomain); 
          } catch (e) { 
            locUrl = null; 
          }

          if (locUrl) {
            // Ép đường dẫn mới chạy trên proxyDomain của bạn
            const redirectedPath = locUrl.pathname + locUrl.search;
            responseHeaders.set('Location', proxyDomain + redirectedPath);
            return new Response(null, { status: response.status, headers: responseHeaders });
          }
        }
      }

      // 7. Xử lý nội dung HTML/JS/CSS
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      const isJsOrCss = contentType.includes('javascript') || contentType.includes('css');

      if (isHtml || isJsOrCss) {
        let text = await response.text();

        // ==========================================
        // A. UNIVERSAL DOMAIN REPLACER (Thay thế MỌI domain)
        // ==========================================
        // Regex này tìm bất kỳ chuỗi nào bắt đầu bằng http://, https:// hoặc // và có chứa dấu chấm (domain)
        // Sau đó thay thế toàn bộ phần domain đó bằng proxyDomain của bạn
        const universalDomainRegex = /(https?:)?\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?=[\/\?\"\'\s\)]|$)/g;
        
        // Chỉ thay thế nếu nó KHÔNG PHẢI là proxyDomain hiện tại (tránh thay thế lặp vô tận)
        text = text.replace(universalDomainRegex, (match) => {
          if (match.includes(proxyDomain.replace('https://', '').replace('http://', ''))) {
            return match; 
          }
          return proxyDomain;
        });

        // ==========================================
        // B. INJECTED CAGE SCRIPT (Lồng kính JavaScript)
        // ==========================================
        const cageScript = `<script>
        (function() {
          const PROXY_ORIGIN = '${proxyDomain}';
          
          // 1. Chặn Anti-Return / Visibility Detector
          const overrideProp = (obj, prop, value) => {
            try {
              Object.defineProperty(obj, prop, {
                get: () => value,
                set: () => {},
                configurable: true
              });
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

          // 2. VÔ HIỆU HÓA navigator.sendBeacon (Chống gửi log ngầm)
          if (navigator.sendBeacon) {
            navigator.sendBeacon = function(url, data) { return true; };
          }

          // 3. BẼ LÁI MỌI FETCH REQUEST (Chặn JS gọi ra domain lạ)
          const originalFetch = window.fetch;
          window.fetch = function(input, init) {
            let targetUrl = typeof input === 'string' ? input : input.url;
            if (targetUrl.startsWith('http') && !targetUrl.startsWith(PROXY_ORIGIN)) {
              try {
                const parsed = new URL(targetUrl);
                targetUrl = PROXY_ORIGIN + parsed.pathname + parsed.search;
              } catch(e) {}
            }
            
            if (typeof input === 'string') {
              return originalFetch.call(this, targetUrl, init);
            } else {
              const newRequest = new Request(targetUrl, input);
              return originalFetch.call(this, newRequest, init);
            }
          };

          // 4. BẼ LÁI MỌI XMLHTTPREQUEST (AJAX)
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

          // 5. CHẶN WINDOW.LOCATION REDIRECT (Chặn JS cố tình đổi trang)
          const originalAssign = window.location.assign;
          window.location.assign = function(url) {
            try {
              const parsed = new URL(url, window.location.origin);
              if (parsed.origin !== PROXY_ORIGIN) {
                parsed = new URL(parsed.pathname + parsed.search, PROXY_ORIGIN);
              }
              return originalAssign.call(window.location, parsed.toString());
            } catch(e) { return originalAssign.call(window.location, url); }
          };
          
          const originalReplace = window.location.replace;
          window.location.replace = function(url) {
            try {
              const parsed = new URL(url, window.location.origin);
              if (parsed.origin !== PROXY_ORIGIN) {
                parsed = new URL(parsed.pathname + parsed.search, PROXY_ORIGIN);
              }
              return originalReplace.call(window.location, parsed.toString());
            } catch(e) { return originalReplace.call(window.location, url); }
          };

          // Xóa các handler inline
          window.onblur = window.onfocus = window.onpagehide = window.onpageshow = window.onvisibilitychange = null;
          document.onvisibilitychange = null;
        })();
        <\/script>`;

        // Inject vào đầu trang
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
