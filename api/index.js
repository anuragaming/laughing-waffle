export default {
  async fetch(request, env, ctx) {
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
    const proxyDomain = url.origin; // Domain trung gian của bạn (giữ cố định ở đây)
    
    // ĐỊNH NGHĨA DOMAIN GỐC (TARGET THỰC TẾ)
    // Bạn có thể linh hoạt đổi targetDomain ở đây mà không làm thay đổi proxyDomain bên ngoài
    let targetHost = 'k12online.vn'; 
    const targetDomain = 'https://' + targetHost;
    
    const targetUrl = targetDomain + url.pathname + url.search;

    try {
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
        redirect: 'manual' // Bắt giữ mọi lệnh redirect của web gốc để giữ người dùng ở lại domain trung gian
      };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        fetchInit.body = await request.clone().arrayBuffer();
      }

      const response = await fetch(targetUrl, fetchInit);
      const responseHeaders = new Headers(response.headers);
      
      // Xóa các header gây chặn khung hình hoặc chống nhúng
      const headersToDrop = [
        'content-encoding', 'content-length', 'transfer-encoding', 'connection',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security', 'report-to'
      ];
      headersToDrop.forEach(h => responseHeaders.delete(h));

      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');

      // Xử lý cookie để giữ phiên đăng nhập không bị đá văng
      const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      responseHeaders.delete('set-cookie');
      const cookiesToSet = [];
      for (const cookie of rawCookies) {
        let cleanCookie = cookie
          .replace(/Domain=[^;]+;?\s*/ig, '')
          .replace(/SameSite=[^;]+;?\s*/ig, '; SameSite=Lax');
        if (!cleanCookie.toLowerCase().includes('path=')) {
          cleanCookie += '; Path=/';
        }
        cookiesToSet.push(cleanCookie.trim());
      }

      // Xử lý Redirect (Nếu web gốc cố tình redirect sang domain khác, ta bẻ lái nó về domain trung gian)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let locUrl;
          try { locUrl = new URL(location, targetDomain); } catch (e) { locUrl = null; }

          if (locUrl) {
            // Thay vì để nó bay sang domain mới, ép nó ở lại proxyDomain của bạn
            const redirectedPath = locUrl.pathname + locUrl.search;
            responseHeaders.set('Location', proxyDomain + redirectedPath);
            return new Response(null, { status: response.status, headers: responseHeaders });
          }
        }
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');

      if (isHtml) {
        let text = await response.text();

        // Thay thế toàn bộ link tuyệt đối từ web gốc thành domain trung gian
        const regexRoot = new RegExp(`https?://${targetHost.replace(/\./g, '\\.')}`, 'g');
        text = text.replace(regexRoot, proxyDomain);

        // ==========================================
        // SCRIPT CHỐNG ANTI-RETURN & BẢO VỆ PHIÊN
        // ==========================================
        const antiDetectScript = `<script>
        (function() {
          try {
            // 1. Vô hiệu hóa Anti-Return / Visibility Detector (Chống phát hiện thoát tab/trình duyệt)
            Object.defineProperty(document, 'hidden', { value: false, writable: false });
            Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: false });
            Object.defineProperty(document, 'webkitHidden', { value: false, writable: false });
            Object.defineProperty(document, 'webkitVisibilityState', { value: 'visible', writable: false });

            // Chặn các sự kiện blur, visibilitychange, mouseleave, pagehide khiến web biết bạn rời đi
            const blockEvents = ['visibilitychange', 'webkitvisibilitychange', 'blur', 'mouseleave', 'pagehide'];
            blockEvents.forEach(evt => {
              window.addEventListener(evt, function(e) {
                e.stopImmediatePropagation();
              }, true);
              document.addEventListener(evt, function(e) {
                e.stopImmediatePropagation();
              }, true);
            });

            // Ghi đè phương thức gửi tín hiệu ngầm (Beacon/Fetch tracking thoát trang)
            if (navigator.sendBeacon) {
              const origBeacon = navigator.sendBeacon;
              navigator.sendBeacon = function(url, data) {
                // Có thể chặn hoặc lọc các URL báo cáo thoát trang tại đây nếu muốn
                if (url && (url.includes('track') || url.includes('analytics') || url.includes('log'))) {
                  return true; // Báo cáo giả là thành công nhưng không gửi đi
                }
                return origBeacon.call(this, url, data);
              };
            }

            // 2. Ép Fetch & XHR luôn bám trụ vào Proxy Domain
            const proxyOrigin = '${proxyDomain}';
            const originalFetch = window.fetch;
            window.fetch = function(input, init) {
              if (typeof input === 'string' && input.startsWith('http')) {
                // Nếu gọi API ra ngoài, điều hướng về proxy nếu cần
                input = input.replace(/https?:\\/\\/[a-zA-Z0-9.-]+/, proxyOrigin);
              }
              return originalFetch.call(this, input, init);
            };

          } catch(e) { console.warn('Anti-detection bypass error:', e); }
        })();
        <\/script>`;

        if (text.includes('<head>')) {
          text = text.replace('<head>', '<head>' + antiDetectScript);
        } else if (text.includes('<body>')) {
          text = text.replace('<body>', '<body>' + antiDetectScript);
        }

        // Xóa sạch thẻ Meta Refresh tự chuyển trang độc hại
        text = text.replace(/<meta\s+[^>]*http-equiv=["']refresh["'][^>]*>/gi, '');

        cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
        return new Response(text, { status: response.status, headers: responseHeaders });
      }

      cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
      return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy Gateway Error', details: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
}
