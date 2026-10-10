export const config = {
  api: { bodyParser: false } 
};

export default async function handler(req, res) {
  const baseDomain = 'k12online.vn';
  
  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
  const proxyDomain = 'https://' + proxyHost;

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
    if (headers.origin) headers.origin = targetDomain;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
      redirect: 'manual' 
    });

    // BƯỚC 1: GIỮ NGUYÊN TOÀN BỘ HEADER CỦA WEB GỐC ĐỂ KHÔNG BỊ LỖI FONT/CSS
    response.headers.forEach((value, key) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
            res.setHeader(key, value);
        }
    });

    let cookiesToSet = [];
    if (typeof response.headers.getSetCookie === 'function') {
       cookiesToSet = response.headers.getSetCookie().map(c => c.replace(/Domain=[^;]+;?\s*/ig, ''));
    }

    // BƯỚC 2: XỬ LÝ CHUYỂN HƯỚNG CỦA PHÂN HỆ TỈNH (SSO Login)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
         const locUrl = new URL(location, targetDomain);
         if (locUrl.hostname.includes(baseDomain)) {
            cookiesToSet.push(`proxy_target_host=${locUrl.hostname}; Path=/; HttpOnly`);
            res.setHeader('Set-Cookie', cookiesToSet);
            res.writeHead(response.status, { Location: proxyDomain + locUrl.pathname + locUrl.search });
            return res.end();
         }
         res.writeHead(response.status, { Location: location });
         return res.end();
      }
    }

    if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet);
    const contentType = response.headers.get('content-type') || '';

    // BƯỚC 3: CHỈ CHỈNH SỬA DUY NHẤT FILE HTML (Giữ an toàn cho JS/CSS)
    if (contentType.includes('text/html')) {
      let text = await response.text();

      const injectedScript = `
        <script>
          // Tắt cảnh báo thoát trang
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
          Object.defineProperty(document, 'hidden', { get: () => false });
          const originalAdd = document.addEventListener;
          document.addEventListener = function(type, listener, options) {
            if (type === 'visibilitychange') return;
            return originalAdd.call(this, type, listener, options);
          };

          // Gài bẫy chặn tự động chuyển hướng của JavaScript gốc
          const proxyDom = '${proxyDomain}';
          const baseRegex = new RegExp('https://[a-zA-Z0-9-]+\\\\.?${baseDomain.replace(/\./g, '\\\\.')}', 'g');
          
          const originalFetch = window.fetch;
          window.fetch = async function() {
              if (typeof arguments[0] === 'string') arguments[0] = arguments[0].replace(baseRegex, proxyDom);
              return originalFetch.apply(this, arguments);
          };

          const originalOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function() {
              if (typeof arguments[1] === 'string') arguments[1] = arguments[1].replace(baseRegex, proxyDom);
              return originalOpen.apply(this, arguments);
          };

          const originalAssign = window.location.assign;
          const originalReplace = window.location.replace;
          window.location.assign = function(url) {
              if(typeof url === 'string') url = url.replace(baseRegex, proxyDom);
              return originalAssign.call(this, url);
          };
          window.location.replace = function(url) {
              if(typeof url === 'string') url = url.replace(baseRegex, proxyDom);
              return originalReplace.call(this, url);
          };
        </script>
      `;
      text = text.replace(/<head[^>]*>/i, match => match + injectedScript);

      // Thay thế link cứng trong HTML
      const urlRegex = new RegExp(`https://[a-zA-Z0-9-]+\\.?${baseDomain.replace(/\./g, '\\.')}`, 'g');
      text = text.replace(urlRegex, proxyDomain);

      res.status(200).send(text);
    } 
    // BƯỚC 4: TRẢ NGUYÊN DỮ LIỆU GỐC CHO CSS, HÌNH ẢNH, JS ĐỂ GIAO DIỆN HOẠT ĐỘNG
    else {
      const buffer = await response.arrayBuffer();
      res.status(response.status).send(Buffer.from(buffer));
    }
  } catch (error) {
    res.status(500).send('Lỗi proxy nội bộ.');
  }
}
