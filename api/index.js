export default async function handler(req, res) {
  const targetDomain = 'https://k12online.vn/';
  
  // 1. Bắt đường dẫn động (Ví dụ: /about, /css/style.css) thay vì chỉ tải trang chủ
  const targetUrl = targetDomain + req.url;

  try {
    const response = await fetch(targetUrl);
    const contentType = response.headers.get('content-type') || '';

    // 2. Chỉ tiêm mã nếu file tải về là giao diện web (HTML)
    if (contentType.includes('text/html')) {
      let html = await response.text();

      const injectedScript = `
        <script>
          Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
          Object.defineProperty(document, 'hidden', { get: () => false });
          const originalAdd = document.addEventListener;
          document.addEventListener = function(type, listener, options) {
            if (type === 'visibilitychange') return; // Chặn theo dõi
            return originalAdd.call(this, type, listener, options);
          };
        </script>
      `;

      // Tìm thẻ <head> (bất kể có thuộc tính gì) và nhét code vào
      html = html.replace(/<head[^>]*>/i, match => match + injectedScript);

      // 3. Viết lại toàn bộ link: Xóa tên miền gốc đi để bạn không bị văng ra ngoài khi click
      html = html.replaceAll(targetDomain, '');

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } 
    // 4. Nếu là các file hình ảnh, CSS, JS... thì giữ nguyên, trả thẳng về
    else {
      const buffer = await response.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      res.status(200).send(Buffer.from(buffer));
    }
  } catch (error) {
    res.status(500).send('Lỗi máy chủ Proxy khi tải trang.');
  }
}
