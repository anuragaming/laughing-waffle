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
    const proxyDomain = url.origin; // Domain trung gian của bạn (giữ cố định)
    
    // 2. Cấu hình domain đích (Target)
    const targetHost = 'k12online.vn'; 
    const targetDomain = 'https://' + targetHost;
    const targetUrl = targetDomain + url.pathname + url.search;

    try {
      // 3. Xử lý Headers gửi đi (Giả mạo yêu cầu đến từ trình duyệt bình thường)
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
        redirect: 'manual' // Giữ quyền kiểm soát mọi lệnh redirect
      };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        fetchInit.body = await request.clone().arrayBuffer();
      }

      // 4. Fetch dữ liệu từ target
      const response = await fetch(targetUrl, fetchInit);
      const responseHeaders = new Headers(response.headers);
      
      // 5. Xóa các header gây chặn nhúng (iframe) hoặc gây lỗi giải nén
      const headersToDrop = [
        'content-encoding', 'content-length', 'transfer-encoding', 'connection',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security', 'report-to',
        'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy'
      ];
      headersToDrop.forEach(h => responseHeaders.delete(h));

      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');

      // 6. Xử lý Cookie (Giữ phiên đăng nhập, ép về Path=/ và xóa Domain gốc)
      const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      responseHeaders.delete('set-cookie');
      for (const cookie of rawCookies) {
        let cleanCookie = cookie
          .replace(/Domain=[^;]+;?\s*/ig, '')
          .replace(/SameSite=[^;]+;?\s*/ig, '; SameSite=Lax');
        if (!cleanCookie.toLowerCase().includes('path=')) {
          cleanCookie += '; Path=/';
        }
        responseHeaders.append('Set-Cookie', cleanCookie.trim());
      }

      // 7. Xử lý Redirect (Bẻ lái mọi redirect về lại proxyDomain)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let locUrl;
          try { locUrl = new URL(location, targetDomain); } catch (e) { locUrl = null; }

          if (locUrl) {
            const redirectedPath = locUrl.pathname + locUrl.search;
            responseHeaders.set('Location', proxyDomain + redirectedPath);
            return new Response(null, { status: response.status, headers: responseHeaders });
          }
        }
      }

      // 8. Xử lý nội dung HTML
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');

      if (isHtml) {
        let text = await response.text();

        // Thay thế link tuyệt đối và protocol-relative (//k12online.vn)
        const escapedHost = targetHost.replace(/\./g, '\\.');
        const regexRoot = new RegExp(`https?://${escapedHost}|//${escapedHost}`, 'g');
        text = text.replace(regexRoot, proxyDomain);

        // ==========================================
        // SCRIPT CHỐNG ANTI-RETURN & BẢO VỆ PHIÊN
        // ==========================================
        const antiDetectScript = `<script>
        (function() {
          try {
            // 1. Vô hiệu hóa thuộc tính visibility trên mọi instance của Document
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

            // 2. Chặn MỌI event listener liên quan đến việc phát hiện rời trang
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

            // 3. Vô hiệu hóa navigator.sendBeacon (chống gửi log/analytics ngầm khi thoát)
            if (navigator.sendBeacon) {
              navigator.sendBeacon = function(url, data) {
                return true; // Giả vờ gửi thành công nhưng thực tế không làm gì
              };
            }

            // 4. Chặn window.location.assign/replace cố tình redirect sang domain khác
            const originalAssign = window.location.assign;
            window.location.assign = function(url) {
              try {
                const u = new URL(url, window.location.origin);
                if (u.hostname !== window.location.hostname) u.hostname = window.location.hostname;
                return originalAssign.call(window.location, u.toString());
              } catch(e) { return originalAssign.call(window.location, url); }
            };
            
            const originalReplace = window.location.replace;
            window.location.replace = function(url) {
              try {
                const u = new URL(url, window.location.origin);
                if (u.hostname !== window.location.hostname) u.hostname = window.location.hostname;
                return originalReplace.call(window.location, u.toString());
              } catch(e) { return originalReplace.call(window.location, url); }
            };

            // 5. Xóa sạch các handler inline có sẵn trên window/document
            window.onblur = null;
            window.onfocus = null;
            window.onpagehide = null;
            window.onpageshow = null;
            window.onvisibilitychange = null;
            document.onvisibilitychange = null;
            
          } catch(e) {
            console.warn('Anti-detect bypass error:', e);
          }
        })();
        <\/script>`;

        // Inject script và base tag vào đầu <head>
        if (text.includes('<head>')) {
          text = text.replace('<head>', `<head><base href="${proxyDomain}/">` + antiDetectScript);
        } else if (text.includes('<body>')) {
          text = text.replace('<body>', `<body>` + antiDetectScript);
        }

        // Xóa meta refresh độc hại (tự động chuyển hướng sau X giây)
        text = text.replace(/<meta\s+[^>]*http-equiv=["']refresh["'][^>]*>/gi, '');

        return new Response(text, { status: response.status, headers: responseHeaders });
      }

      // 9. Trả về nội dung không phải HTML (JS, CSS, Image, v.v.) nguyên vẹn
      return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy Gateway Error', details: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
}
