// File: api/index.js
export default async function handler(req, res) {
  const targetUrl = 'https://potential-funicular-opal.vercel.app/';
  
  try {
    // 1. Máy chủ Vercel tự tải web gốc (Không dính lỗi CORS, không cần proxy ngoài)
    const response = await fetch(targetUrl);
    let html = await response.text();

    // 2. Đoạn mã đánh lừa (Ép tab luôn ở trạng thái visible)
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

    // 3. Tiêm mã vào trang gốc
    html = html.replace('<head>', '<head>' + injectedScript);

    // 4. Trả kết quả về trình duyệt
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (error) {
    res.status(500).send('Lỗi máy chủ Vercel khi tải trang gốc.');
  }
}
