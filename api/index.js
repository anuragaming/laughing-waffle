export const config = {
  api: { bodyParser: false } // Bắt buộc tắt để hỗ trợ truyền form Đăng nhập
};

export default async function handler(req, res) {
  const baseDomain = 'k12online.vn/';
  
  // 1. Kiểm tra xem người dùng đã được điều hướng tới tỉnh nào chưa (Đọc từ Cookie)
  let targetHost = baseDomain;
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/proxy_target_host=([^;]+)/);
  if (match) {
    targetHost = match[1]; // Vd: quangngai.potential...
  }

  const targetDomain = 'https://' + targetHost;
  const targetUrl = targetDomain + req.url;

  try {
    // Thu thập dữ liệu bạn nhập (Tài khoản/Mật khẩu) để gửi đi
    const buffers = [];
    for await (const chunk of req) { buffers.push(chunk); }
    const body = buffers.length ? Buffer.concat(buffers) : undefined;

    // Chuẩn bị Header (Xóa host để vượt rào Vercel, xóa nén GZIP để dễ tiêm mã)
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.referer;
    delete headers['accept-encoding']; 

    // Tải trang/Đăng nhập (Tắt tự chuyển hướng để tự xử lý)
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
      redirect: 'manual' 
    });

    // Xử lý và giữ lại Cookie đăng nhập của server trả về
    let cookiesToSet = [];
    if (typeof response.headers.getSetCookie === 'function') {
       const cookies = response.headers.getSetCookie();
       // Xóa cờ Domain để Cookie có thể lưu được trên tên miền Vercel của bạn
       cookiesToSet = cookies.map(c => c.replace(/Domain=[^;]+;?\s*/ig, ''));
    }

    // 2. Bắt lệnh chuyển hướng khi đăng nhập thành công
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
         const locUrl = new URL(location, targetDomain);
         
         // Nếu server đẩy về tên miền của tỉnh
         if (locUrl.hostname.includes(baseDomain)) {
            // Lưu ngầm tên miền tỉnh đó vào Cookie
            cookiesToSet.push(`proxy_target_host=${locUrl.hostname}; Path=/; HttpOnly`);
            if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet);
            
            // Bẻ lái trình duyệt giữ nguyên ở link web trung gian
            res.writeHead(response.status, { Location: locUrl.pathname + locUrl.search });
            return res.end();
         }
         
         // Nếu là chuyển hướng ngoài hệ thống (Vd: Login bằng Google)
         res.writeHead(response.status, { Location: location });
         return res.end();
      }
    }

    if (cookiesToSet.length > 0) res.setHeader('Set-Cookie', cookiesToSet);
    const contentType = response.headers.get('content-type') || '';

    // 3. Tiêm mã và "Tẩy xóa" sạch sẽ dấu vết web gốc
    if (contentType.includes('text/html') || contentType.includes('application/javascript') || contentType.includes('application/json')) {
      let text = await response.text();

      // Tiêm script ẩn danh vào thẻ Head
      if (contentType.includes('text/html')) {
        const injectedScript = `
          <script>
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
            Object.defineProperty(document, 'hidden', { get: () => false });
            const originalAdd = document.addEventListener;
            document.addEventListener = function(type, listener, options) {
              if (type === 'visibilitychange') return;
              return originalAdd.call(this, type, listener, options);
            };
          </script>
        `;
        text = text.replace(/<head[^>]*>/i, match => match + injectedScript);
      }

      // Xóa toàn bộ link chứa tên miền gốc HOẶC tên miền tỉnh để chống bị văng
      const urlRegex = new RegExp(`https://[a-zA-Z0-9-]+\\.?${baseDomain.replace(/\./g, '\\.')}`, 'g');
      text = text.replace(urlRegex, '');

      res.setHeader('Content-Type', contentType);
      res.status(200).send(text);
    } else {
      // Trả về file hình ảnh, giao diện y nguyên
      const buffer = await response.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.status(200).send(Buffer.from(buffer));
    }
  } catch (error) {
    res.status(500).send('Lỗi máy chủ Proxy trong quá trình đăng nhập.');
  }
}
