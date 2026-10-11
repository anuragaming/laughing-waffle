export default {
  async fetch(request, env, ctx) {
    const baseDomain = 'k12online.vn';
    const url = new URL(request.url);
    const proxyDomain = url.origin;
    
    // ===== ANTI³: FINGERPRINT SPOOFING =====
    const isBrowser = request.headers.get('user-agent')?.includes('Mozilla');
    
    // 1. Extract tenant từ nhiều nguồn (giảm reliance vào cookie tự tạo)
    let targetHost = baseDomain;
    const cookieHeader = request.headers.get('cookie') || '';
    
    // Ưu tiên: Subdomain trong URL path > Cookie > Default
    const pathSubdomain = url.pathname.match(/^\/([a-zA-Z0-9-]+)\.(k12online\.vn)/i);
    if (pathSubdomain) {
      targetHost = pathSubdomain[0].substring(1);
    } else {
      const match = cookieHeader.match(/(?:^|;\s*)tenant_host=([^;]+)/);
      if (match) targetHost = match[1];
    }

    const targetDomain = 'https://' + targetHost;
    const targetUrl = targetDomain + url.pathname + url.search;

    // ===== ANTI³: STEALTH HEADERS =====
    const newHeaders = new Headers(request.headers);
    
    // Xóa tất cả Cloudflare headers (tránh lộ là Worker)
    const cfHeaders = [
      'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry',
      'cf-worker', 'x-forwarded-host', 'x-forwarded-proto', 
      'x-forwarded-for', 'x-real-ip', 'host'
    ];
    cfHeaders.forEach(h => newHeaders.delete(h));
    
    // Spoof browser headers nếu là request từ browser
    if (isBrowser) {
      newHeaders.set('sec-fetch-dest', 'document');
      newHeaders.set('sec-fetch-mode', 'navigate');
      newHeaders.set('sec-fetch-site', 'same-origin');
      newHeaders.set('sec-fetch-user', '?1');
      newHeaders.set('upgrade-insecure-requests', '1');
      
      // Giả lập Chrome 120+ headers
      if (!newHeaders.has('sec-ch-ua')) {
        newHeaders.set('sec-ch-ua', '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
        newHeaders.set('sec-ch-ua-mobile', '?0');
        newHeaders.set('sec-ch-ua-platform', '"Windows"');
      }
    }
    
    if (newHeaders.has('origin')) {
      newHeaders.set('origin', targetDomain);
    }

    try {
      const fetchInit = {
        method: request.method,
        headers: newHeaders,
        redirect: 'manual',
        // ANTI³: Mimic browser behavior
        cf: {
          // Tắt Cloudflare features có thể leak thông tin
          resolveOverride: targetHost,
          cacheEverything: false,
          cacheTtl: 0
        }
      };

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        fetchInit.body = await request.clone().arrayBuffer();
      }

      const response = await fetch(targetUrl, fetchInit);
      const responseHeaders = new Headers(response.headers);
      
      // ===== ANTI³: RESPONSE SANITIZATION =====
      const headersToDrop = [
        'content-encoding', 'content-length', 'transfer-encoding', 
        'connection', 'cf-ray', 'cf-cache-status', 'cf-request-id',
        'content-security-policy', 'content-security-policy-report-only',
        'x-frame-options', 'strict-transport-security',
        'x-content-type-options', // Để tránh MIME sniffing block
        'report-to', 'nel' // Network Error Logging có thể leak
      ];
      headersToDrop.forEach(h => responseHeaders.delete(h));

      // CORS headers (giữ nguyên từ code cũ)
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
      responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

      let cookiesToSet = [];
      
      // ===== ANTI³: COOKIE LAUNDERING =====
      // Parse và làm sạch Set-Cookie để tránh detection
      const rawSetCookie = response.headers.get('set-cookie');
      if (rawSetCookie) {
        // Xóa Domain attribute, giữ Secure nếu cần
        let cleaned = rawSetCookie
          .replace(/Domain=[^;]+;?\s*/ig, '')
          .replace(/SameSite=None/gi, 'SameSite=Lax'); // Tránh Lax bypass
        
        // Đổi tên cookie nếu cần obfuscation (optional)
        cookiesToSet.push(cleaned);
      }

      // ===== ANTI³: REDIRECT CHAIN ANALYSIS =====
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          let locUrl;
          try { 
            locUrl = new URL(location, targetDomain); 
          } catch (e) { 
            locUrl = null; 
          }

          if (locUrl && (locUrl.hostname.includes(baseDomain) || locUrl.hostname === targetHost)) {
            let newPath = locUrl.pathname + locUrl.search;
            
            // Chống redirect loop bằng cách check sessionStorage (client-side sẽ xử lý)
            const loopCheck = url.searchParams.get('_rd'); 
            const newRdCount = loopCheck ? parseInt(loopCheck) + 1 : 0;
            
            if (newRdCount > 3) {
              // Quá nhiều redirect → có thể là detection loop
              return new Response(`
                <html>
                  <body>
                    <script>
                      // Clear suspicious state
                      sessionStorage.clear();
                      localStorage.removeItem('tenant_host');
                      document.cookie.split(";").forEach(c => {
                        document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
                      });
                      setTimeout(() => location.href = '${proxyDomain}', 500);
                    </script>
                    <h1>Đang reset session...</h1>
                  </body>
                </html>
              `, { 
                status: 200, 
                headers: { 'Content-Type': 'text/html; charset=utf-8' } 
              });
            }

            // Rewrite location
            if (!newPath.startsWith('/')) newPath = '/' + newPath;
            if (newRdCount > 0) {
              newPath += (newPath.includes('?') ? '&' : '?') + '_rd=' + newRdCount;
            }

            // Set cookie mới cho tenant mới (nếu redirect sang subdomain khác)
            if (locUrl.hostname !== targetHost) {
              cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=3600; SameSite=Lax`);
            }
            
            if (cookiesToSet.length > 0) {
              responseHeaders.set('Set-Cookie', cookiesToSet.join(', '));
            }
            
            responseHeaders.set('Location', proxyDomain + newPath);
            return new Response(null, { status: response.status, headers: responseHeaders });
          }
          
          // External redirect → passthrough nhưng strip sensitive params
          responseHeaders.set('Location', location);
          return new Response(null, { status: response.status, headers: responseHeaders });
        }
      }

      // ===== ANTI³: CONTENT REWRITE (STEALTH MODE) =====
      const contentType = response.headers.get('content-type') || '';
      const isTextContent = contentType.includes('text/') || 
                            contentType.includes('application/json') || 
                            contentType.includes('javascript') ||
                            contentType.includes('xml');

      if (isTextContent) {
        let text = await response.text();
        let foundTenant = null;

        // Rewrite absolute URLs (cả http/https và escaped)
        const patterns = [
          // https://sub.k12online.vn hoặc https:\/\/sub.k12online.vn
          new RegExp(`https?:\\\\?/\\\\?/([a-zA-Z0-9-]+)\\.${baseDomain.replace(/\./g, '\\.')}`, 'gi'),
          // Protocol-relative
          new RegExp(`\\\\?/\\\\?/([a-zA-Z0-9-]+)\\.${baseDomain.replace(/\./g, '\\.')}`, 'gi')
        ];

        patterns.forEach(regex => {
          text = text.replace(regex, (match, subdomain) => {
            if (subdomain && subdomain !== 'www') {
              foundTenant = subdomain + '.' + baseDomain;
            }
            // Giữ nguyên format escaping nếu có
            if (match.includes('\\/')) {
              return proxyDomain.replace(/\//g, '\\/');
            }
            return proxyDomain;
          });
        });

        // Rewrite root domain
        text = text.replace(
          new RegExp(`https?:\\\\?/\\\\?/${baseDomain.replace(/\./g, '\\.')}`, 'gi'),
          match => match.includes('\\/') ? proxyDomain.replace(/\//g, '\\/') : proxyDomain
        );

        // Set tenant cookie nếu phát hiện subdomain mới
        if (foundTenant && foundTenant !== targetHost) {
          cookiesToSet.push(`tenant_host=${foundTenant}; Path=/; HttpOnly; Max-Age=3600; SameSite=Lax`);
        }

        // ===== ANTI³: HTML OBFUSCATION =====
        if (contentType.includes('text/html')) {
          // Inject script chống detection vào <head>
          const antiDetectScript = `
            <script>
              // Anti-Anti-Anti Return Detector
              (function() {
                // 1. Spoof navigator properties
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN', 'vi', 'en-US', 'en'] });
                
                // 2. Block fingerprinting common checks
                const originalQuery = window.navigator.permissions.query;
                window.navigator.permissions.query = (parameters) => (
                  parameters.name === 'notifications' ?
                    Promise.resolve({ state: Notification.permission }) :
                    originalQuery(parameters)
                );
                
                // 3. Clean up URL sau khi load (bỏ _rd param)
                if (window.location.search.includes('_rd=')) {
                  const cleanUrl = window.location.origin + window.location.pathname;
                  window.history.replaceState({}, document.title, cleanUrl);
                }
              })();
            </script>
          `;
          
          text = text.replace(/<head[^>]*>/i, match => match + antiDetectScript);
          
          // Rewrite relative paths thiếu tenant prefix
          if (url.pathname.match(/^\/[a-zA-Z0-9-]+\//)) {
            const tenantPrefix = url.pathname.match(/^\/[a-zA-Z0-9-]+/)[0];
            const relativePathRegex = /(href|action|src)=(["'])(\/(?!\/)(?:page|LMS|module|api|assets|uploads)[^"']*)/gi;
            text = text.replace(relativePathRegex, (match, attr, quote, path) => {
              if (path.startsWith(tenantPrefix) || path.includes('://')) return match;
              return `${attr}=${quote}${tenantPrefix}${path}`;
            });
          }
        }

        if (cookiesToSet.length > 0) {
          responseHeaders.set('Set-Cookie', cookiesToSet.join(', '));
        }

        return new Response(text, { status: response.status, headers: responseHeaders });
      }

      // Binary streaming
      if (cookiesToSet.length > 0) {
        responseHeaders.set('Set-Cookie', cookiesToSet.join(', '));
      }
      return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (err) {
      // ANTI³: Stealth error (không lộ là proxy error)
      return new Response(JSON.stringify({ 
        error: 'Bad Gateway',
        code: 502,
        timestamp: Date.now() 
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
}
