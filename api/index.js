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

  try {
    const buffers = [];
    for await (const chunk of req) { buffers.push(chunk); }
    const body = buffers.length ? Buffer.concat(buffers) : undefined;

    const headers = { ...req.headers }; 
    delete headers.host; 
    delete headers.referer; 
    delete headers['accept-encoding']; 
    if (headers.origin) headers.origin = targetDomain; 

    const response = await fetch(targetUrl, { 
      method: req.method, 
      headers: headers, 
      body: body, 
      redirect: 'manual' 
    }); 

    // 2. Chuyển tiếp Header và vô hiệu hóa rào cản bảo mật
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

    // 3. XỬ LÝ CHUYỂN HƯỚNG HTTP (Login)
    if (response.status >= 300 && response.status < 400) { 
      const location = response.headers.get('location'); 
      if (location) { 
        let locUrl;
        try { locUrl = new URL(location, targetDomain); } catch (e) { locUrl = null; }

        if (locUrl && locUrl.hostname.includes(baseDomain)) { 
          cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=86400`); 
          if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
          const newLocation = proxyDomain + locUrl.pathname + locUrl.search;
          res.writeHead(response.status, { Location: newLocation }); 
          return res.end(); 
        } 
        res.writeHead(response.status, { Location: location }); 
        return res.end(); 
      } 
    } 

    // 4. KIỂM SOÁT HTML, JSON, JS
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
        const isEscaped = match.includes('\\/'); 
        return isEscaped ? proxyDomain.replace(/\//g, '\\/') : proxyDomain; 
      }); 

      const regexRoot = new RegExp(`https:\\\\?/\\\\?/${baseDomain.replace(/\./g, '\\.')}`, 'g'); 
      text = text.replace(regexRoot, match => { 
        const isEscaped = match.includes('\\/'); 
        return isEscaped ? proxyDomain.replace(/\//g, '\\/') : proxyDomain; 
      }); 

      if (foundTenant && foundTenant !== targetHost) { 
        cookiesToSet.push(`tenant_host=${foundTenant}; Path=/; HttpOnly; Max-Age=86400`); 
      } 
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 

      // 5. BƠM MÃ ĐÃ ĐƯỢC FIX LỖI NÚT BẤM
      if (contentType.includes('text/html')) {
        text = text.replace(/<script[^>]*src=["'][^"']*(adsbygoogle|popunder|adzone|doubleclick|adsystem)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');

        const injectedScript = `
          <script>
            // --- 1. CHỐNG PHÁT HIỆN CHUYỂN TAB ---
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            const originalAdd = document.addEventListener;
            document.addEventListener = function(type, listener, options) {
              if (type === 'visibilitychange') return;
              return originalAdd.call(this, type, listener, options);
            };

            // --- 2. CHẶN POPUP QUẢNG CÁO THÔNG MINH (Bảo tồn nút mở tài liệu/bài thi) ---
            const originalWindowOpen = window.open;
            window.open = function(url, name, specs) {
                if (typeof url === 'string' && ['ads', 'popunder', 'adsystem', 'track'].some(kw => url.toLowerCase().includes(kw))) {
                    console.log('🛡️ Đã chặn quảng cáo popup!');
                    return null;
                }
                return originalWindowOpen.apply(this, arguments);
            };

            // --- 3. XÓA SCRIPT QUẢNG CÁO ẨN ---
            const observer = new MutationObserver(mutations => {
              mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                  if (node.tagName === 'SCRIPT' && node.src) {
                    if (['ads', 'popunder', 'banner', 'adsystem', 'track'].some(kw => node.src.toLowerCase().includes(kw))) {
                      node.type = 'javascript/blocked'; node.remove();
                    }
                  }
                });
              });
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });

            // --- 4. BẢO VỆ SPA: CHO PHÉP BẤM NÚT MƯỢT MÀ ---
            const proxyDom = "${proxyDomain}";
            
            // A. Đánh chặn History API (Cách React/Vue chuyển trang nội bộ)
            const originalPushState = history.pushState;
            history.pushState = function(state, unused, url) {
                let newArgs = Array.prototype.slice.call(arguments);
                if (typeof url === 'string' && url.includes('k12online.vn')) {
                    try {
                        const u = new URL(url, window.location.origin);
                        document.cookie = "tenant_host=" + u.hostname + "; path=/; max-age=86400";
                        newArgs[2] = proxyDom + u.pathname + u.search;
                    } catch(e) {}
                }
                return originalPushState.apply(this, newArgs);
            };

            const originalReplaceState = history.replaceState;
            history.replaceState = function(state, unused, url) {
                let newArgs = Array.prototype.slice.call(arguments);
                if (typeof url === 'string' && url.includes('k12online.vn')) {
                    try {
                        const u = new URL(url, window.location.origin);
                        document.cookie = "tenant_host=" + u.hostname + "; path=/; max-age=86400";
                        newArgs[2] = proxyDom + u.pathname + u.search;
                    } catch(e) {}
                }
                return originalReplaceState.apply(this, newArgs);
            };

            // B. Đánh chặn ngầm Fetch API (Fix lỗi Object Request)
            const originalFetch = window.fetch;
            window.fetch = async function(...args) {
                let newArgs = Array.prototype.slice.call(args);
                if (newArgs[0] && typeof newArgs[0] === 'string' && newArgs[0].includes('k12online.vn')) {
                    try {
                        const u = new URL(newArgs[0], window.location.origin);
                        document.cookie = "tenant_host=" + u.hostname + "; path=/; max-age=86400";
                        newArgs[0] = proxyDom + u.pathname + u.search;
                    } catch(e){}
                }
                return originalFetch.apply(this, newArgs);
            };

            // C. Đánh chặn ngầm XHR (Ajax)
            const originalXhrOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
                let newArgs = Array.prototype.slice.call(arguments);
                if (typeof url === 'string' && url.includes('k12online.vn')) {
                    try {
                        const u = new URL(url, window.location.origin);
                        document.cookie = "tenant_host=" + u.hostname + "; path=/; max-age=86400";
                        newArgs[1] = proxyDom + u.pathname + u.search;
                    } catch(e){}
                }
                return originalXhrOpen.apply(this, newArgs);
            };
          </script>
        `;
        text = text.replace(/<head[^>]*>/i, match => match + injectedScript);
      }

      res.status(response.status).send(text); 
    } else { 
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
      const buffer = await response.arrayBuffer(); 
      res.status(response.status).send(Buffer.from(buffer)); 
    } 

  } catch (error) { 
    res.status(500).send('Lỗi máy chủ Proxy Vercel.'); 
  } 
}
