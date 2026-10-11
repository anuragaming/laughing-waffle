const antiAntiDetectorScript = `
<script>
  (function() {
    console.log("[Proxy] Bật khiên Anti-Anti Return Detector...");

    // 1. Tẩy não document.domain và các thuộc tính URL của document
    try {
      Object.defineProperty(document, 'domain', { get: () => 'k12online.vn', configurable: true });
      Object.defineProperty(document, 'URL', { get: () => 'https://k12online.vn' + window.location.pathname, configurable: true });
      Object.defineProperty(document, 'documentURI', { get: () => 'https://k12online.vn' + window.location.pathname, configurable: true });
    } catch(e) {}

    // 2. Phục kích các lệnh chuyển hướng (Chặn web tự văng ra ngoài)
    const originalAssign = window.location.assign;
    const originalReplace = window.location.replace;
    
    // Nếu JS gốc gọi lệnh bắt văng về k12online.vn, ta bẻ lái nó về lại domain proxy
    window.location.assign = function(url) {
      if(typeof url === 'string' && url.includes('k12online.vn')) {
         url = url.replace(/https?:\\/\\/([a-zA-Z0-9.-]*k12online\\.vn)/gi, window.location.origin);
      }
      return originalAssign.call(window.location, url);
    };
    
    window.location.replace = function(url) {
      if(typeof url === 'string' && url.includes('k12online.vn')) {
         url = url.replace(/https?:\\/\\/([a-zA-Z0-9.-]*k12online\\.vn)/gi, window.location.origin);
      }
      return originalReplace.call(window.location, url);
    };

    // 3. Tẩy não Fetch / XHR (Bắt ngầm các request gọi API và sửa header nếu cần)
    const originalFetch = window.fetch;
    window.fetch = async function() {
      let args = arguments;
      // Nếu có lệnh gọi API chứa k12online.vn, chặn nó lại và đổi sang proxy
      if (typeof args[0] === 'string' && args[0].includes('k12online.vn')) {
          args[0] = args[0].replace(/https?:\\/\\/([a-zA-Z0-9.-]*k12online\\.vn)/gi, window.location.origin);
      }
      return originalFetch.apply(this, args);
    };
  })();
</script>
`;
