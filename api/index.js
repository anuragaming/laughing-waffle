export default {
  async fetch(request, env, ctx) {
    const baseDomain = 'k12online.vn';
    const url = new URL(request.url);
    const proxyDomain = url.origin;
    
    // 1. Xác định tenant từ cookie hoặc URL
    let targetHost = baseDomain;
    const cookieHeader = request.headers.get('cookie') || '';
    const match = cookieHeader.match(/tenant_host=([^;]+)/);
    if (match) targetHost = match[1];

    const targetDomain = 'https://' + targetHost;
    
    // Tách tenantPrefix từ URL (ví dụ: /tenant1/api/... -> tenantPrefix = /tenant1)
    const prefixMatch = url.pathname.match(/^\/([a-zA-Z0-9-]+)(?=\/)/);
    const tenantPrefix = prefixMatch ? '/' + prefixMatch[1] : '';
    
    // Đường dẫn thực tế gửi đi server gốc (bỏ tenantPrefix)
    let targetPath = url.pathname;
    if (tenantPrefix && targetPath.startsWith(tenantPrefix)) {
      targetPath = targetPath.substring(tenantPrefix.length);
    }
    // Đảm bảo path luôn bắt đầu bằng /
    if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;
    
    const targetUrl = targetDomain + targetPath + url.search;

    try {
      // 2. Chuẩn bị Request gửi đi (Giấu vết proxy)
      const newHeaders = new Headers(request.headers);
      const headersToRemove = [
        'host', 'referer', 'accept-encoding', 'x-forwarded-host',
        'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
        'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'sec-fetch-site'
      ];
      headersToRemove.forEach(h => newHeaders.delete(h));
      
      newHeaders.set('origin', targetDomain);
      newHeaders.set('referer', targetDomain + '/');

      const fetchInit = {
        method: request.method,
        headers: newHeaders,
        redirect: 'manual'
      };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        fetchInit.body = await request.clone().arrayBuffer();
      }

      const response = await fetch(targetUrl, fetchInit);
      const responseHeaders = new Headers(response.headers);
      
      // Xóa các header gây rối
      const headersToDrop = [
        'content-encoding', 'content-length', 'transfer-encoding', 'connection',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security', 'report-to'
      ];
      headersToDrop.forEach(h => responseHeaders.delete(h));

      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

      // 3. XỬ LÝ COOKIE CHUẨN (Dùng getSetCookie để không bị lỗi nhiều cookie)
      const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      const cookiesToSet = [];

      if (rawCookies.length > 0) {
        for (const cookie of rawCookies) {
          // Xóa Domain gốc để trình duyệt chấp nhận cookie trên proxy domain
          let cleanCookie = cookie
            .replace(/Domain=[^;]+;?\s*/ig, '')
            .replace(/domain=[^;]+;?\s*/ig, '');
          
          // Đảm bảo có Path=/
          if (!cleanCookie.toLowerCase().includes('path=')) {
            cleanCookie += '; Path=/';
          }
          cookiesToSet.push(cleanCookie.trim());
        }
      }

      // 4. XỬ LÝ REDIRECT (Chống loop)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let locUrl;
          try { locUrl = new URL(location, targetDomain); } catch (e) { locUrl = null; }

          if (locUrl && locUrl.hostname.includes(baseDomain)) {
            let newPath = locUrl.pathname + locUrl.search;
            
            // Gắn lại tenantPrefix nếu server gốc trả về path không có prefix
            if (tenantPrefix && !newPath.startsWith(tenantPrefix)) {
              newPath = tenantPrefix + newPath;
            }

            // Chặn vòng lặp: nếu redirect về chính nó
            const currentPath = url.pathname + url.search;
            if (locUrl.hostname === targetHost && newPath === currentPath) {
               return new Response(null, { status: 204 }); // 204 No Content để dừng loop
            }

            if (locUrl.hostname !== targetHost) {
              cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=86400`);
            }
            
            // Set cookie an toàn
            cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
            responseHeaders.set('Location', proxyDomain + newPath);
            
            return new Response(null, { status: response.status, headers: responseHeaders });
          }
        }
      }

      // 5. XỬ LÝ TEXT (HTML, JS, CSS, JSON) - FIX VỠ GIAO DIỆN
      const contentType = response.headers.get('content-type') || '';
      const isTextContent = contentType.includes('text/') || 
                            contentType.includes('application/json') || 
                            contentType.includes('javascript') ||
                            contentType.includes('application/xhtml');

      if (isTextContent) {
        let text = await response.text();
        let foundTenant = targetHost;

        // A. Thay thế URL tuyệt đối
        const regexSub = new RegExp(`https?://([a-zA-Z0-9-]+)\\.${baseDomain.replace(/\./g, '\\.')}`, 'g');
        text = text.replace(regexSub, (match, subdomain) => {
          foundTenant = subdomain + '.' + baseDomain;
          return proxyDomain;
        });

        const regexRoot = new RegExp(`https?://${baseDomain.replace(/\./g, '\\.')}`, 'g');
        text = text.replace(regexRoot, proxyDomain);

        if (foundTenant && foundTenant !== targetHost) {
          cookiesToSet.push(`tenant_host=${foundTenant}; Path=/; HttpOnly; Max-Age=86400`);
        }

        // B. Thay thế URL tương đối gốc (Root-relative: bắt đầu bằng /)
        // Bắt cả src, href, action, và cả url() trong CSS
        if (tenantPrefix) {
          // HTML attributes
          text = text.replace(/(href|src|action|data-src|data-href)=(["'])(\/[^"']*)/gi, (match, attr, quote, path) => {
            if (path.startsWith(tenantPrefix)) return match;
            // Bỏ qua các link external hoặc protocol-relative
            if (path.startsWith('//') || path.includes('://')) return match;
            return `${attr}=${quote}${tenantPrefix}${path}`;
          });

          // CSS url()
          text = text.replace(/url\(\s*(['"]?)(\/[^'")]+)\1\s*\)/gi, (match, quote, path) => {
            if (path.startsWith(tenantPrefix)) return match;
            return `url(${quote}${tenantPrefix}${path}${quote})`;
          });
        }

        // C. Inject Script chống redirect & sửa History API (Quan trọng cho SPA)
        const spoofScript = `<script>
        (function() {
          try {
            const realHost = '${targetHost}';
            const proxyHost = window.location.hostname;
            const prefix = '${tenantPrefix}';

            // 1. Vô hiệu hóa Service Worker
            if (navigator.serviceWorker) {
              navigator.serviceWorker.register = function() { return Promise.resolve(); };
            }

            // 2. Spoof window.location
            const locationProxy = new Proxy(window.location, {
              get: function(target, prop) {
                if (prop === 'hostname' || prop === 'host') return realHost;
                if (prop === 'origin') return 'https://' + realHost;
                if (prop === 'href') return 'https://' + realHost + window.location.pathname + window.location.search;
                return Reflect.get(...arguments);
              },
              set: function(target, prop, value) {
                if (prop === 'href' || prop === 'location') {
                  if (typeof value === 'string' && value.includes('${baseDomain}')) {
                    value = value.replace('https://' + realHost, '${proxyDomain}');
                    value = value.replace('http://' + realHost, '${proxyDomain}');
                    value = value.replace(realHost, proxyHost);
                  }
                }
                return Reflect.set(...arguments);
              }
            });
            window.location.assign = function(url) { window.location.href = url; };
            window.location.replace = function(url) { window.location.href = url; };

            // 3. Sửa History API để giữ tenantPrefix khi trang web tự đổi URL
            const originalPushState = history.pushState;
            history.pushState = function(state, title, url) {
              if (url && typeof url === 'string' && url.startsWith('/') && !url.startsWith(prefix)) {
                url = prefix + url;
              }
              return originalPushState.call(history, state, title, url);
            };
            
            const originalReplaceState = history.replaceState;
            history.replaceState = function(state, title, url) {
              if (url && typeof url === 'string' && url.startsWith('/') && !url.startsWith(prefix)) {
                url = prefix + url;
              }
              return originalReplaceState.call(history, state, title, url);
            };

          } catch(e) { console.warn('Proxy script error', e); }
        })();
        <\/script>`;

        if (text.includes('<head>')) {
          text = text.replace('<head>', '<head>' + spoofScript);
        } else if (text.includes('<body>')) {
          text = text.replace('<body>', '<body>' + spoofScript);
        } else {
          text = spoofScript + text;
        }

        // Xóa Meta Refresh
        text = text.replace(/<meta\s+[^>]*http-equiv=["']refresh["'][^>]*>/gi, '');

        // Set cookie
        cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
        
        return new Response(text, { status: response.status, headers: responseHeaders });
      }

      // 6. TRẢ FILE NHỊ PHÂN (Ảnh, Font, PDF...)
      cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
      return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error', details: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
}
