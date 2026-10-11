export default {
  async fetch(request, env, ctx) {
    const baseDomain = 'k12online.vn';
    const url = new URL(request.url);
    const proxyDomain = url.origin;
    
    // 1. Kiểm tra Cookie
    let targetHost = baseDomain;
    const cookieHeader = request.headers.get('cookie') || '';
    const match = cookieHeader.match(/tenant_host=([^;]+)/);
    if (match) targetHost = match[1];

    const targetDomain = 'https://' + targetHost;
    const targetUrl = targetDomain + url.pathname + url.search;

    const prefixMatch = url.pathname.match(/^\/([a-zA-Z0-9-]+)(?=\/)/);
    const tenantPrefix = prefixMatch ? prefixMatch[0] : '';

    try {
      // Chuẩn bị Request mới gửi đi
      const newHeaders = new Headers(request.headers);
      const headersToRemove = [
        'host', 'referer', 'accept-encoding', 'x-forwarded-host',
        'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip',
        'cf-connecting-ip', 'cf-ray', 'cf-visitor'
      ];
      headersToRemove.forEach(h => newHeaders.delete(h));
      if (newHeaders.has('origin')) newHeaders.set('origin', targetDomain);

      const fetchInit = {
        method: request.method,
        headers: newHeaders,
        redirect: 'manual' // Bắt buộc để chặn vòng lặp chuyển hướng
      };

      // Đọc body nếu là POST/PUT
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        fetchInit.body = await request.clone().arrayBuffer();
      }

      const response = await fetch(targetUrl, fetchInit);
      const responseHeaders = new Headers(response.headers);
      const headersToDrop = [
        'content-encoding', 'content-length', 'transfer-encoding', 'connection',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security'
      ];
      headersToDrop.forEach(h => responseHeaders.delete(h));

      // Thêm CORS (Lấy từ tư duy của index (1).js)
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

      let cookiesToSet = [];
      const setCookieHeaders = response.headers.get('set-cookie');
      if (setCookieHeaders) {
        // Tách cookie nếu có nhiều
        cookiesToSet.push(setCookieHeaders.replace(/Domain=[^;]+;?\s*/ig, ''));
      }

      // 2. XỬ LÝ CHUYỂN HƯỚNG (Ngăn xoay URL liên tục)
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let locUrl;
          try { locUrl = new URL(location, targetDomain); } catch (e) { locUrl = null; }

          if (locUrl && locUrl.hostname.includes(baseDomain)) {
            let newPath = locUrl.pathname + locUrl.search;
            
            if (tenantPrefix && !newPath.startsWith(tenantPrefix)) {
              if (/^\/(page|LMS|module|api|assets)\//i.test(locUrl.pathname)) {
                newPath = tenantPrefix + newPath;
              }
            }

            if (locUrl.hostname === targetHost && url.pathname === new URL(newPath, proxyDomain).pathname) {
               return new Response('<html><body><h1>Đã chặn vòng lặp Redirect. Vui lòng tải lại trang (F5).</h1></body></html>', {
                 status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }
               });
            }

            cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=86400`);
            if (cookiesToSet.length > 0) responseHeaders.set('Set-Cookie', cookiesToSet.join(', '));
            
            responseHeaders.set('Location', proxyDomain + newPath);
            return new Response(null, { status: response.status, headers: responseHeaders });
          }
          responseHeaders.set('Location', location);
          return new Response(null, { status: response.status, headers: responseHeaders });
        }
      }

      // 3. XỬ LÝ TEXT (Chữ, HTML, JSON) ĐỂ GIỮ URL TRUNG GIAN
      const contentType = response.headers.get('content-type') || '';
      const isTextContent = contentType.includes('text/') || 
                            contentType.includes('application/json') || 
                            contentType.includes('javascript');

      if (isTextContent) {
        let text = await response.text();
        let foundTenant = null;

        const regexSub = new RegExp(`https:\\\\?/\\\\?/([a-zA-Z0-9-]+)\\.${baseDomain.replace(/\./g, '\\.')}`, 'g');
        text = text.replace(regexSub, (match, subdomain) => {
          foundTenant = subdomain + '.' + baseDomain;
          return match.includes('\\/') ? proxyDomain.replace(/\//g, '\\/') : proxyDomain;
        });

        const regexRoot = new RegExp(`https:\\\\?/\\\\?/${baseDomain.replace(/\./g, '\\.')}`, 'g');
        text = text.replace(regexRoot, match => {
          return match.includes('\\/') ? proxyDomain.replace(/\//g, '\\/') : proxyDomain;
        });

        if (foundTenant && foundTenant !== targetHost) {
          cookiesToSet.push(`tenant_host=${foundTenant}; Path=/; HttpOnly; Max-Age=86400`);
        }
        if (cookiesToSet.length > 0) responseHeaders.set('Set-Cookie', cookiesToSet.join(', '));

        if (contentType.includes('text/html')) {
          if (tenantPrefix) {
            const relativePathRegex = /(href|action|src)=(["'])(\/(?:page|LMS|module|api|assets)[^"']*)/gi;
            text = text.replace(relativePathRegex, (match, attr, quote, path) => {
              if (path.startsWith(tenantPrefix)) return match;
              return `${attr}=${quote}${tenantPrefix}${path}`;
            });
          }
        }
        return new Response(text, { status: response.status, headers: responseHeaders });
      }

      // 4. TRẢ FILE NHỊ PHÂN THEO LUỒNG (Streaming giống index.1.js)
      if (cookiesToSet.length > 0) responseHeaders.set('Set-Cookie', cookiesToSet.join(', '));
      return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error', details: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}
