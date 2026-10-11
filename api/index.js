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
    delete headers['accept-encoding']; // Tắt nén để dễ dàng cắt sửa chuỗi 
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

    // 3. Đánh tráo lệnh chuyển hướng từ Server 
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

    // 4. Tuyệt chiêu cuối: Can thiệp thẳng vào dữ liệu JSON & HTML 
    const contentType = response.headers.get('content-type') || ''; 
    const isHTML = contentType.includes('text/html'); 
    const isJSON = contentType.includes('application/json'); 

    if (isHTML || isJSON) { 
      let text = await response.text(); 

      // Tìm mọi đường link chứa tên miền phụ (Kể cả link bị mã hóa bằng dấu gạch chéo) 
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

      // Nếu bắt được phân hệ mới, lưu ngầm vào Cookie ngay lập tức 
      if (foundTenant && foundTenant !== targetHost) { 
        cookiesToSet.push(`tenant_host=${foundTenant}; Path=/; HttpOnly; Max-Age=86400`); 
      } 
      
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 

      // Bơm mã vô hiệu hóa theo dõi + CHẶN QUẢNG CÁO/CHUYỂN TRANG
      if (isHTML) {
        // Cấp độ 1: Xóa thẳng script quảng cáo bằng Regex từ server
        text = text.replace(/<script[^>]*src=["'][^"']*(adsbygoogle|popunder|adzone|doubleclick|adsystem)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');

        const injectedScript = `
          <script>
            // --- 1. CHỐNG PHÁT HIỆN CHUYỂN TAB (Anti-Cheat) ---
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
            const originalAdd = document.addEventListener;
            document.addEventListener = function(type, listener, options) {
              if (type === 'visibilitychange') return;
              return originalAdd.call(this, type, listener, options);
            };

            // --- 2. CHẶN QUẢNG CÁO & REDIRECT ---
            // A. Vô hiệu hóa hàm mở popup hoặc tab mới (window.open)
            window.open = function() { 
              console.log('🛡️ Đã chặn 1 popup quảng cáo!'); 
              return null; 
            };

            // B. Theo dõi và tiêu diệt các script quảng cáo chèn lén lút vào DOM
            const observer = new MutationObserver(mutations => {
              mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                  if (node.tagName === 'SCRIPT' && node.src) {
                    const badKeywords = ['ads', 'popunder', 'banner', 'adsystem', 'track'];
                    const srcLower = node.src.toLowerCase();
                    if (badKeywords.some(kw => srcLower.includes(kw))) {
                      node.type = 'javascript/blocked'; // Vô hiệu hóa script
                      node.remove(); // Xóa khỏi DOM
                      console.log('🛡️ Đã tiêu diệt script quảng cáo:', node.src);
                    }
                  }
                });
              });
            });
            // Kích hoạt theo dõi ngay
            observer.observe(document.documentElement, { childList: true, subtree: true });

            // C. Chống JS ép tự động chuyển trang 
            // Nếu bạn vẫn bị chuyển hướng, hãy bỏ dấu // ở 2 dòng dưới:
            // window.addEventListener('beforeunload', function(e) {
            //   e.preventDefault(); 
            //   e.returnValue = ''; 
            // });
          </script>
        `;
        text = text.replace(/<head[^>]*>/i, match => match + injectedScript);
      }

      res.status(response.status).send(text); 
    } else { 
      // 5. Trả về nguyên vẹn các file Hình ảnh, CSS, JS để tránh vỡ web 
      if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet); 
      const buffer = await response.arrayBuffer(); 
      res.status(response.status).send(Buffer.from(buffer)); 
    } 

  } catch (error) { 
    res.status(500).send('Lỗi máy chủ Proxy Vercel.'); 
  } 
}
