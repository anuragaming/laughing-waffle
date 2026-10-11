export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  const baseDomain = 'k12online.vn';

  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
  const proxyDomain = 'https://' + proxyHost;

  // 1. Kiểm tra Cookie xem bạn đang ở phân hệ quản lý nào
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

    // 2. Chuyển tiếp Header nhưng TƯỚC BỎ các lá chắn bảo mật của web gốc
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

    // 3. Xử lý Redirect từ Server (HTTP 3xx)
    if (response.status >= 300 && response.status < 400) { 
      const location = response.headers.get('location'); 
      if (location) { 
        const locUrl = new URL(location, location.startsWith('http') ? undefined : targetDomain); 
        if (locUrl.hostname.includes(baseDomain)) { 
          cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=86400`); 
          if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
          res.writeHead(response.status, { Location: proxyDomain + locUrl.pathname + locUrl.search }); 
          return res.end(); 
        } 
        res.writeHead(response.status, { Location: location }); 
        return res.end(); 
      } 
    } 

    // 4. KIỂM SOÁT TOÀN DIỆN: HTML, JSON và đặc biệt là file JAVASCRIPT
    const contentType = response.headers.get('content-type') || ''; 
    const isTextContent = contentType.includes('text/') || 
                          contentType.includes('application/json') || 
                          contentType.includes('javascript') ||
                          contentType.includes('application/x-javascript');

    if (isTextContent) { 
      let text = await response.text(); 
      let foundTenant = null; 

      // Ép mọi đường link dạng https://*.k12online.vn (hoặc bị encode) về Proxy
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

      // 5. Bơm mã chống theo dõi và cùm chân Client (Chỉ tiêm vào giao diện HTML)
      if (contentType.includes('text/html')) {
        // Cắt bỏ script quảng cáo
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

            // --- 2. CHẶN POPUP QUẢNG CÁO ---
            window.open = () => null; 

            // --- 3. THEO DÕI VÀ XÓA SCRIPT QUẢNG CÁO ẨN ---
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

            // --- 4. BẮT CÓC MỌI SỰ KIỆN CLICK VÀ CHUYỂN TRANG ---
            const proxyDom = "${proxyDomain}";
            
            // A. Đánh chặn Click vào bất kỳ đường link <a> nào
            document.addEventListener('click', function(e) {
                const link = e.target.closest('a');
                if (link && link.href) {
                    try {
                        const url = new URL(link.href);
                        if (url.hostname.includes('k12online.vn')) {
                            e.preventDefault(); // Chặn hành động gốc
                            document.cookie = "tenant_host=" + url.hostname + "; path=/; max-age=86400";
                            window.location.href = proxyDom + url.pathname + url.search;
                        }
                    } catch(err) {}
                }
            }, true); // Bắt từ gốc (Capture Phase)

            // B. Đánh chặn Fetch API (Các dữ liệu load ngầm)
            const originalFetch = window.fetch;
            window.fetch = async function() {
                if (typeof arguments[0] === 'string' && arguments[0].includes('k12online.vn')) {
                    try {
                        const u = new URL(arguments[0]);
                        document.cookie = "tenant_host=" + u.hostname + "; path=/; max-age=86400";
                        arguments[0] = proxyDom + u.pathname + u.search;
                    } catch(e){}
                }
                return originalFetch.apply(this, arguments);
            };

            // C. Đánh chặn XMLHttpRequest (Ajax)
            const originalXhrOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
                if (typeof url === 'string' && url.includes('k12online.vn')) {
                    try {
                        const u = new URL(url);
                        document.cookie = "tenant_host=" + u.hostname + "; path=/; max-age=86400";
                        url = proxyDom + u.pathname + u.search;
                    } catch(e){}
                }
                return originalXhrOpen.apply(this, [method, url, ...Array.prototype.slice.call(arguments, 2)]);
            };

            // D. Bức tường cuối cùng: Nếu web cố tình ép chuyển trang bằng JS
            window.addEventListener('beforeunload', function (e) {
                // Nếu trình duyệt hiện thông báo, BẠN CHỈ CẦN BẤM "CANCEL / Ở LẠI"
                e.preventDefault();
                e.returnValue = '';
            });
          </script>
        `;
        text = text.replace(/<head[^>]*>/i, match => match + injectedScript);
      }

      res.status(response.status).send(text); 
    } else { 
      // Các file nhị phân (Hình ảnh, Font...)
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
      const buffer = await response.arrayBuffer(); 
      res.status(response.status).send(Buffer.from(buffer)); 
    } 

  } catch (error) { 
    res.status(500).send('Lỗi máy chủ Proxy Vercel.'); 
  } 
}
