export const config = {
  api: { bodyParser: false } 
};

export default async function handler(req, res) {
  const baseDomain = 'potential-funicular-opal.vercel.app';
  
  const proxyHost = req.headers['x-forwarded-host'] || req.headers.host;
  const proxyDomain = 'https://' + proxyHost;

  // Đọc tên miền tỉnh từ Cookie
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

    response.headers.forEach((value, key) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
            res.setHeader(key, value);
        }
    });

    let cookiesToSet = [];
    if (typeof response.headers.getSetCookie === 'function') {
       cookiesToSet = response.headers.getSetCookie().map(c => c.replace(/Domain=[^;]+;?\s*/ig, ''));
    }

    // Xử lý server-side redirect (nếu có)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
         const locUrl = new URL(location, location.startsWith('http') ? undefined : targetDomain);
         if (locUrl.hostname.includes(baseDomain)) {
            cookiesToSet.push(`proxy_target_host=${locUrl.hostname}; Path=/; HttpOnly; Max-Age=3600`);
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

    if (contentType.includes('text/html')) {
      let text = await response.text();

      // ĐOẠN MÃ GIÁN ĐIỆP CHẶN MỌI ĐƯỜNG THOÁT
      const injectedScript = `
        <script>
          // 1. Tắt theo dõi trạng thái tab
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
          Object.defineProperty(document, 'hidden', { get: () => false });
          const originalAdd = document.addEventListener;
          document.addEventListener = function(type, listener, options) {
            if (type === 'visibilitychange') return;
            return originalAdd.call(this, type, listener, options);
          };

          // 2. Hàm lõi: Bắt URL tỉnh -> Lưu Cookie -> Bẻ lái sang Proxy
          const proxyOrigin = '${proxyDomain}';
          const baseDomain = '${baseDomain}';
          
          function trapUrl(url) {
              if (typeof url !== 'string') return url;
              try {
                  if (url.includes(baseDomain)) {
                      const urlObj = new URL(url);
                      if (urlObj.hostname.includes(baseDomain)) {
                          // Bắt quả tang tên miền tỉnh và lưu vào cookie ngầm
                          document.cookie = "proxy_target_host=" + urlObj.hostname + "; path=/; max-age=3600";
                          // Đánh tráo link gốc thành link Vercel của bạn
                          return proxyOrigin + urlObj.pathname + urlObj.search + urlObj.hash;
                      }
                  }
              } catch(e) {}
              return url;
          }

          // 3. Giăng bẫy History API (Công cụ chuyển trang ngầm của React/NextJS)
          const originalPushState = history.pushState;
          const originalReplaceState = history.replaceState;
          history.pushState = function(state, unused, url) {
              return originalPushState.call(this, state, unused, trapUrl(url));
          };
          history.replaceState = function(state, unused, url) {
              return originalReplaceState.call(this, state, unused, trapUrl(url));
          };

          // 4. Giăng bẫy toàn bộ cú Click chuột và Form Submit
          window.addEventListener('click', function(e) {
              const a = e.target.closest('a');
              if (a && a.href && a.href.includes(baseDomain)) {
                  e.preventDefault(); // Chặn trình duyệt mở link gốc
                  window.location.href = trapUrl(a.href); // Ép nhảy sang link proxy
              }
          }, true); // Dùng true (capture phase) để chặn từ trứng nước trước khi web gốc kịp xử lý

          window.addEventListener('submit', function(e) {
              if (e.target && e.target.action && e.target.action.includes(baseDomain)) {
                  e.target.action = trapUrl(e.target.action);
              }
          }, true);

          // 5. Giăng bẫy các API ngầm (Fetch/XHR)
          const originalFetch = window.fetch;
          window.fetch = async function() {
              if (typeof arguments[0] === 'string') arguments[0] = trapUrl(arguments[0]);
              return originalFetch.apply(this, arguments);
          };
          const originalOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function() {
              if (typeof arguments[1] === 'string') arguments[1] = trapUrl(arguments[1]);
              return originalOpen.apply(this, arguments);
          };
        </script>
      `;
      
      text = text.replace(/<head[^>]*>/i, match => match + injectedScript);

      // Lưu ý: Không dùng lệnh "text.replace" xóa link gốc nữa, 
      // Cứ để nguyên link gốc trong HTML để hàm Gián Điệp phía trên mồi chài và bắt sống nó.
      res.status(200).send(text);
    } else {
      const buffer = await response.arrayBuffer();
      res.status(response.status).send(Buffer.from(buffer));
    }
  } catch (error) {
    res.status(500).send('Lỗi proxy nội bộ.');
  }
}
