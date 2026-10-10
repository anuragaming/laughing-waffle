export const config = {
  api: { bodyParser: false } 
};

export default async function handler(req, res) {
  const baseDomain = 'k12online.vn/';
  
  // Lấy tên miền web trung gian của bạn (vd: abc.vercel.app)
  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
  const proxyDomain = 'https://' + proxyHost;

  // Đọc Cookie xem bạn đang đăng nhập vào phân hệ tỉnh nào (vd: quangngai, hanoi,...)
  let targetHost = baseDomain;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/proxy_target_host=([^;]+)/);
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
    
    // Đánh lừa máy chủ gốc rằng request này đến từ chính nó để không bị chặn đăng nhập
    if (headers.origin) headers.origin = targetDomain;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
      redirect: 'manual' 
    });

    let cookiesToSet = [];
    if (typeof response.headers.getSetCookie === 'function') {
       cookiesToSet = response.headers.getSetCookie().map(c => c.replace(/Domain=[^;]+;?\s*/ig, ''));
    }

    // BƯỚC 1: BẮT LỆNH CHUYỂN HƯỚNG TỪ MÁY CHỦ (SERVER-SIDE)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
         const locUrl = new URL(location, targetDomain);
         if (locUrl.hostname.includes(baseDomain)) {
            // Cập nhật Cookie phân hệ tỉnh
            cookiesToSet.push(`proxy_target_host=${locUrl.hostname}; Path=/; HttpOnly`);
            if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet);
            
            // Ép bẻ lái trình duyệt trả về tên miền Vercel của bạn
            res.writeHead(response.status, { Location: proxyDomain + locUrl.pathname + locUrl.search });
            return res.end();
         }
         res.writeHead(response.status, { Location: location });
         return res.end();
      }
    }

    if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet);
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html') || contentType.includes('application/javascript') || contentType.includes('application/json')) {
      let text = await response.text();

      if (contentType.includes('text/html')) {
        const injectedScript = `
          <script>
            // Tắt theo dõi trạng thái thoát trang
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
            Object.defineProperty(document, 'hidden', { get: () => false });
            const originalAdd = document.addEventListener;
            document.addEventListener = function(type, listener, options) {
              if (type === 'visibilitychange') return;
              return originalAdd.call(this, type, listener, options);
            };

            // BƯỚC 2: CHẶN WEB GỐC DÙNG JAVASCRIPT ĐỂ ÉP CHUYỂN TRANG (CLIENT-SIDE)
            const proxyDom = '${proxyDomain}';
            const originalAssign = window.location.assign;
            const originalReplace = window.location.replace;
            
            window.location.assign = function(url) {
                if(typeof url === 'string') url = url.replace(/https:\\/\\/[a-zA-Z0-9-]+\\.?potential-funicular-opal\\.vercel\\.app/g, proxyDom);
                return originalAssign.call(this, url);
            };
            window.location.replace = function(url) {
                if(typeof url === 'string') url = url.replace(/https:\\/\\/[a-zA-Z0-9-]+\\.?potential-funicular-opal\\.vercel\\.app/g, proxyDom);
                return originalReplace.call(this, url);
            };
          </script>
        `;
        text = text.replace(/<head[^>]*>/i, match => match + injectedScript);
      }

      // BƯỚC 3: THAY THẾ TOÀN BỘ TÊN MIỀN GỐC THÀNH TÊN MIỀN CỦA BẠN TRONG DỮ LIỆU
      const urlRegex = new RegExp(`https://[a-zA-Z0-9-]+\\.?${baseDomain.replace(/\./g, '\\.')}`, 'g');
      text = text.replace(urlRegex, proxyDomain);

      // BƯỚC 4: SỬA LỖI CÁC LINK BỊ MÃ HÓA TRONG JSON
      const escapedUrlRegex = new RegExp(`https:\\\\/\\\\/[a-zA-Z0-9-]+\\.?${baseDomain.replace(/\./g, '\\.')}`, 'g');
      text = text.replace(escapedUrlRegex, proxyDomain.replace(/\//g, '\\/'));

      res.setHeader('Content-Type', contentType);
      res.status(200).send(text);
    } else {
      const buffer = await response.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.status(200).send(Buffer.from(buffer));
    }
  } catch (error) {
    res.status(500).send('Lỗi máy chủ Proxy.');
  }
}
