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

    // 2. Chuyển tiếp an toàn Header gốc 
    response.headers.forEach((value, key) => { 
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) { 
        res.setHeader(key, value); 
      } 
    }); 

    let cookiesToSet = []; 
    if (typeof response.headers.getSetCookie === 'function') { 
      cookiesToSet = response.headers.getSetCookie().map(c => c.replace(/Domain=[^;]+;?\s*/ig, '')); 
    } 

    // 3. Xử lý HTTP Redirect (Server-side)
    if (response.status >= 300 && response.status < 400) { 
      const location = response.headers.get('location'); 
      if (location) { 
        const locUrl = new URL(location, location.startsWith('http') ? undefined : targetDomain); 
        
        // Nếu Server muốn điều hướng đến một tên miền k12online.vn bất kỳ
        if (locUrl.hostname.includes(baseDomain)) { 
          // Lưu subdomain (ví dụ: quangngai.k12online.vn) vào cookie
          cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=86400`); 
          if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
          
          // Bẻ lái: Chuyển hướng người dùng về lại Proxy, giữ nguyên đường dẫn phía sau
          res.writeHead(response.status, { Location: proxyDomain + locUrl.pathname + locUrl.search }); 
          return res.end(); 
        } 
        
        // Nếu điều hướng ra ngoài (ví dụ: google.com), cứ để đi tự nhiên
        res.writeHead(response.status, { Location: location }); 
        return res.end(); 
      } 
    } 

    // 4. Can thiệp nội dung HTML/JSON 
    const contentType = response.headers.get('content-type') || ''; 
    const isHTML = contentType.includes('text/html'); 
    const isJSON = contentType.includes('application/json'); 

    if (isHTML || isJSON) { 
      let text = await response.text(); 

      // Ép tất cả các đường link dạng https://abc.k12online.vn/xyz trong nội dung thành Proxy
      const regex = new RegExp(`https:\\\\?/\\\\?/([a-zA-Z0-9-]+)\\.${baseDomain.replace(/\./g, '\\.')}`, 'g'); 
      let foundTenant = null; 
      text = text.replace(regex, (match, subdomain) => { 
        foundTenant = subdomain + '.' + baseDomain; 
        const isEscaped = match.includes('\\/'); 
        return isEscaped ? proxyDomain.replace(/\//g, '\\/') : proxyDomain; 
      }); 

      const rootRegex = new RegExp(`https:\\\\?/\\\\?/${baseDomain.replace(/\./g, '\\.')}`, 'g'); 
      text = text.replace(rootRegex, match => { 
        const isEscaped = match.includes('\\/'); 
        return isEscaped ? proxyDomain.replace(/\//g, '\\/') : proxyDomain; 
      }); 

      if (foundTenant && foundTenant !== targetHost) { 
        cookiesToSet.push(`tenant_host=${foundTenant}; Path=/; HttpOnly; Max-Age=86400`); 
      } 
      
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 

      // Bơm mã vô hiệu hóa
      if (isHTML) {
        // Cắt bỏ script quảng cáo trực tiếp
        text = text.replace(/<script[^>]*src=["'][^"']*(adsbygoogle|popunder|adzone|doubleclick|adsystem)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');

        const proxyHostString = proxyDomain;

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

            // --- 2. CHẶN QUẢNG CÁO MỞ POPUP ---
            window.open = function() { 
              console.log('🛡️ Đã chặn popup quảng cáo!'); 
              return null; 
            };

            // --- 3. THEO DÕI VÀ XÓA SCRIPT QUẢNG CÁO CHÈN ĐỘNG ---
            const observer = new MutationObserver(mutations => {
              mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                  if (node.tagName === 'SCRIPT' && node.src) {
                    const badKeywords = ['ads', 'popunder', 'banner', 'adsystem', 'track'];
                    if (badKeywords.some(kw => node.src.toLowerCase().includes(kw))) {
                      node.type = 'javascript/blocked';
                      node.remove();
                      console.log('🛡️ Đã xóa script:', node.src);
                    }
                  }
                });
              });
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });

            // --- 4. "CÙM CHÂN" LỆNH CHUYỂN HƯỚNG BẰNG JAVASCRIPT (URL HIJACKING) ---
            // Trang web thường dùng lệnh như window.location.href = "https://quangngai.k12online.vn/..."
            // Đoạn code này sẽ chặn việc đổi URL ra khỏi Proxy.
            
            const proxyDomain = "${proxyHostString}";
            const originalLocation = window.location;

            // Đánh chặn việc gán giá trị mới cho window.location.href
            let locationHref = originalLocation.href;
            Object.defineProperty(window.location, 'href', {
                get: function() { return locationHref; },
                set: function(newUrl) {
                    if (typeof newUrl === 'string' && newUrl.includes('k12online.vn')) {
                        console.log("🛡️ Bẻ lái URL:", newUrl);
                        try {
                            const parsedUrl = new URL(newUrl);
                            
                            // Gửi yêu cầu lưu cookie ngầm lên server để biết phân hệ mới
                            document.cookie = "tenant_host=" + parsedUrl.hostname + "; path=/; max-age=86400";
                            
                            // Ép trình duyệt đi đến URL của Proxy, giữ nguyên path và tham số
                            locationHref = proxyDomain + parsedUrl.pathname + parsedUrl.search;
                            originalLocation.href = locationHref; 
                            return;
                        } catch(e) {
                             // Lỗi parse URL, cứ để trôi
                        }
                    }
                    locationHref = newUrl;
                    originalLocation.href = newUrl;
                }
            });
            
            // Đánh chặn window.location.replace
            const originalReplace = window.location.replace;
            window.location.replace = function(newUrl) {
                if (typeof newUrl === 'string' && newUrl.includes('k12online.vn')) {
                     console.log("🛡️ Bẻ lái Replace URL:", newUrl);
                     try {
                          const parsedUrl = new URL(newUrl);
                          document.cookie = "tenant_host=" + parsedUrl.hostname + "; path=/; max-age=86400";
                          return originalReplace.call(window.location, proxyDomain + parsedUrl.pathname + parsedUrl.search);
                     } catch(e) {}
                }
                return originalReplace.call(window.location, newUrl);
            };
            
            // Đánh chặn window.location.assign
            const originalAssign = window.location.assign;
            window.location.assign = function(newUrl) {
                if (typeof newUrl === 'string' && newUrl.includes('k12online.vn')) {
                     console.log("🛡️ Bẻ lái Assign URL:", newUrl);
                     try {
                          const parsedUrl = new URL(newUrl);
                          document.cookie = "tenant_host=" + parsedUrl.hostname + "; path=/; max-age=86400";
                          return originalAssign.call(window.location, proxyDomain + parsedUrl.pathname + parsedUrl.search);
                     } catch(e) {}
                }
                return originalAssign.call(window.location, newUrl);
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
