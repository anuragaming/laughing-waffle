export default {
  async fetch(request, env, ctx) {
    // 0. Xử lý ngay lập tức CORS Preflight (OPTIONS) để không bị treo khi bấm nút/gọi API
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const baseDomain = 'k12online.vn';
    const url = new URL(request.url);
    const proxyDomain = url.origin;
    
    // 1. Xác định tenant từ cookie
    let targetHost = baseDomain;
    const cookieHeader = request.headers.get('cookie') || '';
    const match = cookieHeader.match(/tenant_host=([^;]+)/);
    if (match) targetHost = match[1];

    const targetDomain = 'https://' + targetHost;
    
    // DANH SÁCH LOẠI TRỪ: Không coi các thư mục hệ thống/tài nguyên là tenantPrefix
    const reservedPrefixes = [
      'api', 'assets', 'static', 'public', 'css', 'js', 'images', 'img', 
      'fonts', 'media', 'upload', 'uploads', 'storage', 'build', 'dist', 
      'vendor', 'plugins', 'themes', 'favicon.ico', 'robots.txt'
    ];
    
    const prefixMatch = url.pathname.match(/^\/([a-zA-Z0-9-]+)(?=\/)/);
    let tenantPrefix = '';
    if (prefixMatch && !reservedPrefixes.includes(prefixMatch[1].toLowerCase())) {
      tenantPrefix = '/' + prefixMatch[1];
    }
    
    // Đường dẫn thực tế gửi đi server gốc
    let targetPath = url.pathname;
    if (tenantPrefix && targetPath.startsWith(tenantPrefix)) {
      targetPath = targetPath.substring(tenantPrefix.length);
    }
    if (!targetPath.startsWith('/')) targetPath = '/' + targetPath;
    
    const targetUrl = targetDomain + targetPath + url.search;

    try {
      // 2. Chuẩn bị Request gửi đi
      const newHeaders = new Headers(request.headers);
      const headersToRemove = [
        'host', 'referer', 'accept-encoding', 'x-forwarded-host',
        'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
        'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'sec-fetch-site',
        'sec-fetch-mode', 'sec-fetch-dest'
      ];
      headersToRemove.forEach(h => newHeaders.delete(h));
      
      newHeaders.set('Host', targetHost);
      newHeaders.set('Origin', targetDomain);
      newHeaders.set('Referer', targetDomain + targetPath);

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
      
      // Xóa các header bảo mật chặn proxy
      const headersToDrop = [
        'content-encoding', 'content-length', 'transfer-encoding', 'connection',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security', 'report-to', 'nel'
      ];
      headersToDrop.forEach(h => responseHeaders.delete(h));

      // Cấu hình CORS chuẩn (Hỗ trợ gửi kèm Cookie/Session khi bấm nút)
      const reqOrigin = request.headers.get('Origin');
      responseHeaders.set('Access-Control-Allow-Origin', reqOrigin || '*');
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');

      // 3. XỬ LÝ COOKIE (Cho phép JS đọc và gửi cookie mượt mà)
      const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      responseHeaders.delete('set-cookie'); // Xóa bộ cũ để ghi lại bộ đã dọn sạch
      const cookiesToSet = [];

      if (rawCookies.length > 0) {
        for (const cookie of rawCookies) {
          let cleanCookie = cookie
            .replace(/Domain=[^;]+;?\s*/ig, '')
            .replace(/SameSite=[^;]+;?\s*/ig, ''); // Tránh lỗi chặn cookie chéo trang
          
          if (!cleanCookie.toLowerCase().includes('path=')) {
            cleanCookie += '; Path=/';
          } else {
            // Ép mọi Path của cookie về gốc '/' để không bị mất phiên khi đổi URL
            cleanCookie = cleanCookie.replace(/Path=[^;]+/i, 'Path=/');
          }
          cookiesToSet.push(cleanCookie.trim());
        }
      }

      // 4. XỬ LÝ REDIRECT
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let locUrl;
          try { locUrl = new URL(location, targetDomain); } catch (e) { locUrl = null; }

          if (locUrl && locUrl.hostname.includes(baseDomain)) {
            let newPath = locUrl.pathname + locUrl.search;
            
            if (tenantPrefix && !newPath.startsWith(tenantPrefix)) {
              newPath = tenantPrefix + newPath;
            }

            if (locUrl.hostname !== targetHost) {
              // Không để HttpOnly để client script có thể đồng bộ nếu cần
              cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; Max-Age=86400`);
            }
            
            cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
            responseHeaders.set('Location', proxyDomain + newPath);
            
            return new Response(null, { status: response.status, headers: responseHeaders });
          }
        }
      }

      // 5. XỬ LÝ NỘI DUNG (Phân loại rõ HTML với JS/JSON/CSS)
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      const isText = isHtml || 
                     contentType.includes('javascript') || 
                     contentType.includes('text/css') || 
                     contentType.includes('application/json');

      if (isText) {
        let text = await response.text();
        let foundTenant = targetHost;

        // A. Thay thế URL tuyệt đối của k12online sang proxyDomain (Áp dụng cho cả HTML, JS, JSON, CSS)
        const regexSub = new RegExp(`https?://([a-zA-Z0-9-]+)\\.${baseDomain.replace(/\./g, '\\.')}`, 'g');
        text = text.replace(regexSub, (match, subdomain) => {
          foundTenant = subdomain + '.' + baseDomain;
          return proxyDomain;
        });

        const regexRoot = new RegExp(`https?://${baseDomain.replace(/\./g, '\\.')}`, 'g');
        text = text.replace(regexRoot, proxyDomain);

        if (foundTenant && foundTenant !== targetHost) {
          cookiesToSet.push(`tenant_host=${foundTenant}; Path=/; Max-Age=86400`);
        }

        // B. CHỈ CAN THIỆP DOM & INJECT SCRIPT NẾU LÀ FILE HTML! (Fix triệt để lỗi đơ/lag JS)
        if (isHtml) {
          if (tenantPrefix) {
            text = text.replace(/(href|src|action|data-src|data-href)=(["'])(\/[^"']*)/gi, (match, attr, quote, path) => {
              if (path.startsWith(tenantPrefix) || path.startsWith('//')) return match;
              // Kiểm tra nếu là thư mục tài nguyên tĩnh thì không gắn tenantPrefix
              const firstSeg = path.split('/')[1]?.toLowerCase();
              if (reservedPrefixes.includes(firstSeg)) return match;
              return `${attr}=${quote}${tenantPrefix}${path}`;
            });
          }

          // Script tiêm vào HTML: Bọc lại Fetch & XHR để các nút bấm gọi đúng địa chỉ Proxy
          const spoofScript = `<script>
          (function() {
            try {
              const realHost = '${targetHost}';
              const baseDomain = '${baseDomain}';
              const proxyOrigin = window.location.origin;

              if (navigator.serviceWorker) {
                navigator.serviceWorker.register = function() { return Promise.resolve(); };
              }

              // Hàm chuyển đổi URL gọi ngầm của K12Online về Proxy
              function rewriteUrl(url) {
                if (typeof url !== 'string') return url;
                if (url.includes(baseDomain)) {
                  return url.replace(/https?:\\/\\/[a-zA-Z0-9.-]*k12online\\.vn/g, proxyOrigin);
                }
                return url;
              }

              // 1. Bọc lại hàm fetch() để nút bấm hoạt động
              const originalFetch = window.fetch;
              window.fetch = function(input, init) {
                if (typeof input === 'string') {
                  input = rewriteUrl(input);
                } else if (input instanceof Request) {
                  input = new Request(rewriteUrl(input.url), input);
                }
                return originalFetch.call(this, input, init);
              };

              // 2. Bọc lại XMLHttpRequest (Ajax) cho các nút bấm đời cũ
              const originalOpen = XMLHttpRequest.prototype.open;
              XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                return originalOpen.call(this, method, rewriteUrl(url), ...rest);
              };

            } catch(e) { console.warn('Proxy helper error:', e); }
          })();
          <\/script>`;

          // Chỉ chèn vào <head> hoặc <body> của HTML, tuyệt đối không dùng nhánh else nối bừa bãi
          if (text.includes('<head>')) {
            text = text.replace('<head>', '<head>' + spoofScript);
          } else if (text.includes('<body>')) {
            text = text.replace('<body>', '<body>' + spoofScript);
          }

          // Xóa Meta Refresh gây chuyển trang mất kiểm soát
          text = text.replace(/<meta\s+[^>]*http-equiv=["']refresh["'][^>]*>/gi, '');
        }

        cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
        return new Response(text, { status: response.status, headers: responseHeaders });
      }

      // 6. TRẢ FILE NHỊ PHÂN
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
