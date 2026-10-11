export default {
  async fetch(request, env, ctx) {
    const baseDomain = 'k12online.vn';
    const url = new URL(request.url);
    const proxyDomain = url.origin;
    
    // 1. Kiểm tra Cookie để xác định tenant
    let targetHost = baseDomain;
    const cookieHeader = request.headers.get('cookie') || '';
    const match = cookieHeader.match(/tenant_host=([^;]+)/);
    if (match) targetHost = match[1];

    const targetDomain = 'https://' + targetHost;
    const targetUrl = targetDomain + url.pathname + url.search;

    const prefixMatch = url.pathname.match(/^\/([a-zA-Z0-9-]+)(?=\/)/);
    const tenantPrefix = prefixMatch ? '/' + prefixMatch[1] : '';

    try {
      // Chuẩn bị Request mới gửi đi (Giấu vết proxy)
      const newHeaders = new Headers(request.headers);
      const headersToRemove = [
        'host', 'referer', 'accept-encoding', 'x-forwarded-host',
        'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
        'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'sec-fetch-site', 'sec-fetch-mode'
      ];
      headersToRemove.forEach(h => newHeaders.delete(h));
      
      // Giả mạo origin để server gốc chấp nhận
      newHeaders.set('origin', targetDomain);
      newHeaders.set('referer', targetDomain + '/');

      const fetchInit = {
        method: request.method,
        headers: newHeaders,
        redirect: 'manual' // Bắt buộc để tự xử lý redirect
      };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        fetchInit.body = await request.clone().arrayBuffer();
      }

      const response = await fetch(targetUrl, fetchInit);
      const responseHeaders = new Headers(response.headers);
      
      const headersToDrop = [
        'content-encoding', 'content-length', 'transfer-encoding', 'connection',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security', 'report-to'
      ];
      headersToDrop.forEach(h => responseHeaders.delete(h));

      // Thêm CORS
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

      // Mảng chứa cookie để set, sẽ dùng append để tránh lỗi syntax
      const cookiesToSet = [];

      // Xử lý cookie từ response gốc
      const setCookieHeaders = response.headers.get('set-cookie');
      if (setCookieHeaders) {
        // Tách từng cookie riêng biệt (Cloudflare có thể gộp hoặc tách)
        const cookies = setCookieHeaders.split(/,(?=\s*[a-zA-Z0-9_-]+=)/); 
        cookies.forEach(cookie => {
          let cleanCookie = cookie
            .replace(/Domain=[^;]+;?\s*/ig, '') // Xóa domain gốc
            .replace(/domain=[^;]+;?\s*/ig, '');
          
          // Đảm bảo có Path=/
          if (!cleanCookie.toLowerCase().includes('path=')) {
            cleanCookie += '; Path=/';
          }
          cookiesToSet.push(cleanCookie.trim());
        });
      }

      // 2. XỬ LÝ CHUYỂN HƯỚNG (Nâng cao: Chống vòng lặp & Relative Path)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let locUrl;
          try { 
            // Xử lý cả absolute và relative URL
            locUrl = new URL(location, targetDomain); 
          } catch (e) { 
            locUrl = null; 
          }

          if (locUrl && locUrl.hostname.includes(baseDomain)) {
            let newPath = locUrl.pathname + locUrl.search;
            
            // Gắn tenantPrefix nếu thiếu
            if (tenantPrefix && !newPath.startsWith(tenantPrefix)) {
              if (/^\/(page|LMS|module|api|assets|login|auth)/i.test(locUrl.pathname)) {
                newPath = tenantPrefix + newPath;
              }
            }

            // Phát hiện vòng lặp: Nếu redirect quay lại chính đường dẫn hiện tại
            const currentPath = url.pathname + url.search;
            if (locUrl.hostname === targetHost && newPath === currentPath) {
               // Trả về 200 OK trống hoặc thông báo để dừng vòng lặp, tránh crash trình duyệt
               return new Response('<html><body><script>window.location.reload();</script></body></html>', {
                 status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }
               });
            }

            // Cập nhật cookie tenant_host nếu đổi host
            if (locUrl.hostname !== targetHost) {
              cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=86400`);
            }
            
            // Set cookie đúng cách (dùng append)
            cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
            
            // Rewrite Location header về proxy domain
            responseHeaders.set('Location', proxyDomain + newPath);
            return new Response(null, { status: response.status, headers: responseHeaders });
          }
          
          // Nếu location trỏ ra ngoài hoàn toàn, vẫn cố gắng giữ lại trong proxy nếu có thể
          const externalNewPath = locUrl ? (locUrl.pathname + locUrl.search) : location;
          responseHeaders.set('Location', proxyDomain + externalNewPath);
          return new Response(null, { status: response.status, headers: responseHeaders });
        }
      }

      // 3. XỬ LÝ TEXT (HTML, JSON, JS) - ANTI ANTI ANTI DETECTOR
      const contentType = response.headers.get('content-type') || '';
      const isTextContent = contentType.includes('text/') || 
                            contentType.includes('application/json') || 
                            contentType.includes('javascript') ||
                            contentType.includes('application/xhtml');

      if (isTextContent) {
        let text = await response.text();
        let foundTenant = targetHost; // Fallback về targetHost hiện tại

        // A. Thay thế URL tuyệt đối trong HTML/JS
        const regexSub = new RegExp(`https?://([a-zA-Z0-9-]+)\\.${baseDomain.replace(/\./g, '\\.')}`, 'g');
        text = text.replace(regexSub, (match, subdomain) => {
          foundTenant = subdomain + '.' + baseDomain;
          return proxyDomain;
        });

        const regexRoot = new RegExp(`https?://${baseDomain.replace(/\./g, '\\.')}`, 'g');
        text = text.replace(regexRoot, proxyDomain);

        // B. Cập nhật cookie nếu phát hiện tenant mới trong body
        if (foundTenant && foundTenant !== targetHost) {
          cookiesToSet.push(`tenant_host=${foundTenant}; Path=/; HttpOnly; Max-Age=86400`);
        }

        // C. Chèn Script "Anti Anti Anti" vào đầu <head> hoặc <body>
        // Script này đánh lừa web gốc rằng nó đang chạy trên domain thật, 
        // nhưng chặn mọi nỗ lực redirect window.location ra ngoài.
        const spoofScript = `<script>
        (function() {
          try {
            const realHost = '${targetHost}';
            const proxyHost = window.location.hostname;
            
            // 1. Vô hiệu hóa Service Worker (chặn hijack điều hướng)
            if (navigator.serviceWorker) {
              navigator.serviceWorker.register = function() { return Promise.resolve(); };
            }

            // 2. Spoof window.location để vượt qua check "hostname !== k12online.vn"
            const locationProxy = new Proxy(window.location, {
              get: function(target, prop) {
                if (prop === 'hostname' || prop === 'host') return realHost;
                if (prop === 'origin') return 'https://' + realHost;
                if (prop === 'href') return 'https://' + realHost + window.location.pathname + window.location.search;
                return Reflect.get(...arguments);
              },
              set: function(target, prop, value) {
                if (prop === 'href' || prop === 'location') {
                  if (typeof value === 'string') {
                    // Chặn redirect về domain gốc, ép nó quay về proxy
                    if (value.includes('${baseDomain}')) {
                      value = value.replace('https://' + realHost, '${proxyDomain}');
                      value = value.replace('http://' + realHost, '${proxyDomain}');
                      value = value.replace(realHost, proxyHost);
                    }
                  }
                }
                return Reflect.set(...arguments);
              }
            });
            
            // 3. Override assign và replace
            window.location.assign = function(url) { window.location.href = url; };
            window.location.replace = function(url) { window.location.href = url; };
            
          } catch(e) { console.warn('Spoof script error', e); }
        })();
        <\/script>`;

        if (text.includes('<head>')) {
          text = text.replace('<head>', '<head>' + spoofScript);
        } else if (text.includes('<body>')) {
          text = text.replace('<body>', '<body>' + spoofScript);
        } else {
          text = spoofScript + text;
        }

        // D. Xóa Meta Refresh (chặn auto-redirect bằng HTML)
        text = text.replace(/<meta\s+http-equiv=["']refresh["'][^>]*>/gi, '');
        text = text.replace(/<meta\s+[^>]*http-equiv=["']refresh["'][^>]*>/gi, '');

        // E. Xử lý relative path cho HTML (giữ nguyên logic cũ của bạn nhưng an toàn hơn)
        if (contentType.includes('text/html') && tenantPrefix) {
          const relativePathRegex = /(href|action|src)=(["'])(\/(?:page|LMS|module|api|assets|login|auth)[^"']*)/gi;
          text = text.replace(relativePathRegex, (match, attr, quote, path) => {
            if (path.startsWith(tenantPrefix)) return match;
            return `${attr}=${quote}${tenantPrefix}${path}`;
          });
        }

        // Set cookie trước khi trả về
        cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
        
        return new Response(text, { status: response.status, headers: responseHeaders });
      }

      // 4. TRẢ FILE NHỊ PHÂN (Streaming)
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
