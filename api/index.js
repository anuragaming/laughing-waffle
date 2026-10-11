export const config = {
  api: { 
    bodyParser: false,
    externalResolver: true // Báo cho Vercel biết request này sẽ được xử lý ra bên ngoài
  }
};

export default async function handler(req, res) {
  const baseDomain = 'k12online.vn';
  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
  const proxyDomain = 'https://' + proxyHost;

  // 1. Kiểm tra Cookie xác định Target Host
  let targetHost = baseDomain;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/tenant_host=([^;]+)/);
  if (match) targetHost = match[1];

  const targetDomain = 'https://' + targetHost;
  const targetUrl = targetDomain + req.url;

  const prefixMatch = req.url.match(/^\/([a-zA-Z0-9-]+)(?=\/)/);
  const tenantPrefix = prefixMatch ? prefixMatch[0] : ''; 

  // Tạo bộ đếm giờ (Timeout) để chống treo API. Ngắt sau 8.5 giây (Vercel free max 10s)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8500);

  try {
    const buffers = [];
    for await (const chunk of req) { buffers.push(chunk); }
    const body = buffers.length ? Buffer.concat(buffers) : undefined;

    const headers = { ...req.headers }; 
    
    // Xóa các headers gây nhiễu
    const headersToRemove = [
      'host', 'referer', 'accept-encoding', 'x-forwarded-host', 
      'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip', 
      'x-vercel-id', 'x-vercel-ip-city', 'x-vercel-ip-country', 'x-vercel-forwarded-for'
    ];
    headersToRemove.forEach(h => delete headers[h]);
    
    if (headers.origin) headers.origin = targetDomain; 

    // Thực hiện Fetch với Abort Signal chống treo
    const response = await fetch(targetUrl, { 
      method: req.method, 
      headers: headers, 
      body: body, 
      redirect: 'manual',
      signal: controller.signal 
    }); 
    
    clearTimeout(timeoutId); // Hủy bộ đếm giờ nếu fetch thành công

    const headersToDrop = [
      'content-encoding', 'content-length', 'transfer-encoding', 'connection',
      'content-security-policy', 'content-security-policy-report-only', 
      'x-frame-options', 'strict-transport-security'
    ];
    
    response.headers.forEach((value, key) => { 
      if (!headersToDrop.includes(key.toLowerCase())) { 
        res.setHeader(key, value); 
      } 
    }); 

    let cookiesToSet = []; 
    if (typeof response.headers.getSetCookie === 'function') { 
      cookiesToSet = response.headers.getSetCookie().map(c => c.replace(/Domain=[^;]+;?\s*/ig, '')); 
    } 

    // 2. XỬ LÝ CHUYỂN HƯỚNG (REDIRECT)
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

          const reqPathname = new URL(req.url, proxyDomain).pathname;
          const locPathname = new URL(newPath, proxyDomain).pathname;
          
          if (locUrl.hostname === targetHost && reqPathname === locPathname) {
               res.status(200).send('<html><body><h1>Đã chặn vòng lặp Redirect. Vui lòng tải lại trang (F5).</h1></body></html>');
               return res.end();
          }

          cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=86400`); 
          if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
          
          res.writeHead(response.status, { Location: proxyDomain + newPath }); 
          return res.end(); 
        } 
        res.writeHead(response.status, { Location: location }); 
        return res.end(); 
      } 
    } 

    // 3. PHÂN LOẠI CONTENT TYPE
    const contentType = response.headers.get('content-type') || ''; 
    const isTextContent = contentType.includes('text/') || 
                          contentType.includes('application/json') || 
                          contentType.includes('javascript') ||
                          contentType.includes('application/x-javascript');

    if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 

    if (isTextContent) { 
      let text = await response.text(); 
      
      // Chỉ can thiệp thay thế chuỗi (Replace) nếu là HTML hoặc JSON để tránh lỗi hỏng file JS/CSS
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
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
          res.setHeader('Set-Cookie', [...cookiesToSet, `tenant_host=${foundTenant}; Path=/; HttpOnly; Max-Age=86400`]); 
        } 
      }

      // Xử lý riêng cho giao diện HTML
      if (contentType.includes('text/html')) {
        if (tenantPrefix) {
          const relativePathRegex = /(href|action|src)=(["'])(\/(?:page|LMS|module|api|assets)[^"']*)/gi;
          text = text.replace(relativePathRegex, (match, attr, quote, path) => {
            if (path.startsWith(tenantPrefix)) return match;
            return `${attr}=${quote}${tenantPrefix}${path}`;
          });
        }

        text = text.replace(/<script[^>]*src=["'][^"']*(adsbygoogle|popunder|adzone|doubleclick|adsystem)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');

        const injectedScript = `
          <script>
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            const blockVisibility = (e) => { e.stopImmediatePropagation(); e.stopPropagation(); };
            window.addEventListener('visibilitychange', blockVisibility, true);
            document.addEventListener('visibilitychange', blockVisibility, true);

            const originalWindowOpen = window.open;
            window.open = function(url, name, specs) {
                if (typeof url === 'string' && /(ads|popunder|adsystem|track|doubleclick)/i.test(url)) return null;
                return originalWindowOpen.apply(this, arguments);
            };
          </script>
        `;
        text = text.replace(/<head[^>]*>/i, match => match + injectedScript);
      }

      return res.status(response.status).send(text); 
    } else { 
      // 4. XỬ LÝ FILE NHỊ PHÂN AN TOÀN TRÊN VERCEL SERVERLESS
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return res.status(response.status).send(buffer);
    } 

  } catch (error) { 
    clearTimeout(timeoutId);
    
    // Nếu lỗi do hết 8.5 giây chờ
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: "Máy chủ K12Online phản hồi quá chậm (Timeout). Vui lòng thử lại." });
    }
    
    console.error("Proxy Error:", error);
    return res.status(500).send('Lỗi máy chủ Proxy Vercel.'); 
  } 
}
