export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  const baseDomain = 'k12online.vn';
  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
  const proxyDomain = 'https://' + proxyHost;

  // 1. Kiểm tra Cookie
  let targetHost = baseDomain;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/tenant_host=([^;]+)/);
  if (match) targetHost = match[1];

  const targetDomain = 'https://' + targetHost;
  const targetUrl = targetDomain + req.url;

  const prefixMatch = req.url.match(/^\/([a-zA-Z0-9-]+)(?=\/)/);
  const tenantPrefix = prefixMatch ? prefixMatch[0] : ''; 

  try {
    const buffers = [];
    for await (const chunk of req) { buffers.push(chunk); }
    const body = buffers.length ? Buffer.concat(buffers) : undefined;

    const headers = { ...req.headers }; 
    
    delete headers.host; 
    delete headers.referer; 
    delete headers['accept-encoding']; 
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-for'];
    delete headers['x-real-ip'];
    delete headers['x-vercel-id'];
    delete headers['x-vercel-ip-city'];
    delete headers['x-vercel-ip-country'];
    delete headers['x-vercel-forwarded-for'];
    
    if (headers.origin) headers.origin = targetDomain; 

    const response = await fetch(targetUrl, { 
      method: req.method, 
      headers: headers, 
      body: body, 
      redirect: 'manual' 
    }); 

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

    // 2. XỬ LÝ CHUYỂN HƯỚNG
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

    // 3. XỬ LÝ TEXT (HTML, JSON, JS, CSS)
    const contentType = response.headers.get('content-type') || ''; 
    const isTextContent = contentType.includes('text/') || 
                          contentType.includes('application/json') || 
                          contentType.includes('javascript') ||
                          contentType.includes('application/x-javascript');

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
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 

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

            const observer = new MutationObserver(mutations => {
              mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                  if (node.tagName === 'SCRIPT' && node.src && /(adsbygoogle|popunder|adzone|adsystem)/i.test(node.src)) {
                      node.type = 'javascript/blocked'; node.remove();
                  }
                });
              });
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
          </script>
        `;
        text = text.replace(/<head[^>]*>/i, match => match + injectedScript);
      }

      res.status(response.status).send(text); 
    } else { 
      // 4. XỬ LÝ FILE NHỊ PHÂN (ẢNH, VIDEO, TÀI LIỆU...) BẰNG STREAMING CỰC NHANH
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
      res.status(response.status);

      if (response.body) {
        // Truyền trực tiếp dữ liệu thành từng mảnh nhỏ ngay khi nhận được
        for await (const chunk of response.body) {
          res.write(chunk);
        }
        return res.end();
      } else {
        return res.end();
      }
    } 

  } catch (error) { 
    console.error("Proxy Error:", error);
    res.status(500).send('Lỗi máy chủ Proxy Vercel.'); 
  } 
}
