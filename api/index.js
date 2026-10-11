export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  const baseDomain = 'k12online.vn';

  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
  const proxyDomain = 'https://' + proxyHost;

  // 1. Xác định phân hệ (Tenant) từ Cookie
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
    
    // --- [NÂNG CẤP TỐI QUAN TRỌNG]: Ngụy trang Header ---
    // Xóa dấu vết của Vercel Proxy để K12 không bắt chuyển hướng báo lỗi
    delete headers.host; 
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-for'];
    delete headers['x-real-ip'];
    delete headers['accept-encoding']; 

    // Fake Origin và Referer cho chuẩn chỉ
    if (headers.origin) headers.origin = targetDomain; 
    if (headers.referer) {
        headers.referer = headers.referer.replace(proxyHost, targetHost);
    }

    const response = await fetch(targetUrl, { 
      method: req.method, 
      headers: headers, 
      body: body, 
      redirect: 'manual' 
    }); 

    // 2. Chuyển tiếp Header trả về và gỡ khiên bảo mật
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

    // 3. XỬ LÝ CHUYỂN HƯỚNG HTTP (Bẻ lái & CHỐNG LẶP INFINITE LOOP)
    if (response.status >= 300 && response.status < 400) { 
      const location = response.headers.get('location'); 
      if (location) { 
        let locUrl;
        try { locUrl = new URL(location, targetDomain); } catch (e) { locUrl = null; }

        if (locUrl && locUrl.hostname.includes(baseDomain)) { 
          const targetPath = locUrl.pathname + locUrl.search;

          // BỘ CHỐNG LẶP: Nếu K12 bắt chuyển hướng về đúng cái link đang gọi, ngắt ngay lập tức!
          if (req.url === targetPath && targetHost === locUrl.hostname) {
              console.log('🛡️ Đã chặn vòng lặp ERR_TOO_MANY_REDIRECTS!');
              // Ép trả về mã 200 để ngắt lặp
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              return res.end('<h1>Proxy đã chặn 1 vòng lặp lỗi từ K12. Vui lòng F5 Tải lại trang!</h1>');
          }

          // Cập nhật Cookie phân hệ một cách chính thống từ lệnh Redirect
          cookiesToSet.push(`tenant_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`); 
          if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
          
          const newLocation = proxyDomain + targetPath;
          res.writeHead(response.status, { Location: newLocation }); 
          return res.end(); 
        } 
        res.writeHead(response.status, { Location: location }); 
        return res.end(); 
      } 
    } 

    // 4. KIỂM SOÁT HTML, JSON, JAVASCRIPT
    const contentType = response.headers.get('content-type') || ''; 
    const isTextContent = contentType.includes('text/') || 
                          contentType.includes('application/json') || 
                          contentType.includes('javascript') ||
                          contentType.includes('application/x-javascript');

    if (isTextContent) { 
      let text = await response.text(); 

      // Ép tên miền K12 thành Proxy (ĐÃ GỠ BỎ tính năng bắt Cookie tự động gây lặp)
      const regexSub = new RegExp(`https:\\\\?/\\\\?/([a-zA-Z0-9-]+)\\.${baseDomain.replace(/\./g, '\\.')}`, 'g'); 
      text = text.replace(regexSub, match => { 
        return match.includes('\\/') ? proxyDomain.replace(/\//g, '\\/') : proxyDomain; 
      }); 

      const regexRoot = new RegExp(`https:\\\\?/\\\\?/${baseDomain.replace(/\./g, '\\.')}`, 'g'); 
      text = text.replace(regexRoot, match => { 
        return match.includes('\\/') ? proxyDomain.replace(/\//g, '\\/') : proxyDomain; 
      }); 

      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 

      // 5. BƠM MÃ JS AN TOÀN (Không làm đơ nút bấm)
      if (contentType.includes('text/html')) {
        text = text.replace(/<script[^>]*src=["'][^"']*(adsbygoogle|popunder|adzone|doubleclick|adsystem)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');

        const injectedScript = `
          <script>
            // --- 1. CHỐNG PHÁT HIỆN CHUYỂN TAB ---
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            
            const blockVisibility = (e) => { e.stopImmediatePropagation(); e.stopPropagation(); };
            window.addEventListener('visibilitychange', blockVisibility, true);
            document.addEventListener('visibilitychange', blockVisibility, true);

            // --- 2. CHẶN POPUP QUẢNG CÁO RÁC ---
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
      // Xử lý Ảnh, Video
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
      const buffer = await response.arrayBuffer(); 
      res.status(response.status).send(Buffer.from(buffer)); 
    } 

  } catch (error) { 
    res.status(500).send('Lỗi máy chủ Proxy Vercel.'); 
  } 
}
