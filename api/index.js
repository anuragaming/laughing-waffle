export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  const baseDomain = 'k12online.vn';

  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
  const proxyDomain = 'https://' + proxyHost;

  // 1. Kiểm tra Cookie xem đang ở phân hệ (tỉnh/trường) nào
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

    // 2. Chuyển tiếp Header và tháo gỡ khiên bảo mật gốc
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

    // 3. XỬ LÝ CHUYỂN HƯỚNG HTTP (Vượt lỗi khi Đăng Nhập)
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

    // 4. THAY MÁU TOÀN BỘ LINK TRONG HTML, JSON, JAVASCRIPT
    const contentType = response.headers.get('content-type') || ''; 
    const isTextContent = contentType.includes('text/') || 
                          contentType.includes('application/json') || 
                          contentType.includes('javascript') ||
                          contentType.includes('application/x-javascript');

    if (isTextContent) { 
      let text = await response.text(); 
      let foundTenant = null; 

      // Ép các domain con (VD: quangngai.k12online.vn) chạy qua Proxy
      const regexSub = new RegExp(`https:\\\\?/\\\\?/([a-zA-Z0-9-]+)\\.${baseDomain.replace(/\./g, '\\.')}`, 'g'); 
      text = text.replace(regexSub, (match, subdomain) => { 
        foundTenant = subdomain + '.' + baseDomain; 
        return match.includes('\\/') ? proxyDomain.replace(/\//g, '\\/') : proxyDomain; 
      }); 

      // Ép root domain (k12online.vn) chạy qua Proxy
      const regexRoot = new RegExp(`https:\\\\?/\\\\?/${baseDomain.replace(/\./g, '\\.')}`, 'g'); 
      text = text.replace(regexRoot, match => { 
        return match.includes('\\/') ? proxyDomain.replace(/\//g, '\\/') : proxyDomain; 
      }); 

      if (foundTenant && foundTenant !== targetHost) { 
        cookiesToSet.push(`tenant_host=${foundTenant}; Path=/; HttpOnly; Max-Age=86400`); 
      } 
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 

      // 5. BƠM MÃ ĐÃ ĐƯỢC THIẾT KẾ LẠI (Tương thích 100% với SPA, không liệt nút)
      if (contentType.includes('text/html')) {
        // Cắt bỏ script quảng cáo nhúng sẵn
        text = text.replace(/<script[^>]*src=["'][^"']*(adsbygoogle|popunder|adzone|doubleclick|adsystem)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');

        const injectedScript = `
          <script>
            // --- 1. CHỐNG PHÁT HIỆN CHUYỂN TAB (Cách mới: An toàn & Không gây liệt web) ---
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            
            // Bắt sự kiện rời tab từ trứng nước và chặn lại, không can thiệp vào hàm cốt lõi của web
            const blockVisibility = (e) => {
                e.stopImmediatePropagation();
                e.stopPropagation();
            };
            window.addEventListener('visibilitychange', blockVisibility, true);
            document.addEventListener('visibilitychange', blockVisibility, true);

            // --- 2. CHẶN POPUP QUẢNG CÁO RÁC (Cho phép popup tài liệu/đề thi) ---
            const originalWindowOpen = window.open;
            window.open = function(url, name, specs) {
                if (typeof url === 'string' && /(ads|popunder|adsystem|track|doubleclick)/i.test(url)) {
                    console.log('🛡️ Đã chặn popup quảng cáo!');
                    return null;
                }
                return originalWindowOpen.apply(this, arguments);
            };

            // --- 3. TIÊU DIỆT SCRIPT QUẢNG CÁO CHÈN ĐỘNG ---
            const observer = new MutationObserver(mutations => {
              mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                  if (node.tagName === 'SCRIPT' && node.src) {
                    if (/(adsbygoogle|popunder|adzone|adsystem)/i.test(node.src)) {
                      node.type = 'javascript/blocked'; 
                      node.remove();
                    }
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
      // Xử lý Ảnh, Video, Font chữ
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
      const buffer = await response.arrayBuffer(); 
      res.status(response.status).send(Buffer.from(buffer)); 
    } 

  } catch (error) { 
    res.status(500).send('Lỗi máy chủ Proxy Vercel.'); 
  } 
}
