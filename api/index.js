export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ===== CẤU HÌNH =====
    const TARGET_HOST = 'k12online.vn';
    const TARGET_ORIGIN = 'https://' + TARGET_HOST;
    const PROXY_ORIGIN = url.origin;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Credentials': 'true'
        }
      });
    }

    const targetUrl = TARGET_ORIGIN + url.pathname + url.search;

    try {
      const newHeaders = new Headers(request.headers);
      [
        'host','referer','accept-encoding','x-forwarded-host','x-forwarded-proto',
        'x-forwarded-for','x-real-ip','cf-connecting-ip','cf-ray','cf-visitor',
        'sec-fetch-site','sec-fetch-mode','sec-fetch-dest','origin'
      ].forEach(h => newHeaders.delete(h));

      newHeaders.set('Host', TARGET_HOST);
      newHeaders.set('Origin', TARGET_ORIGIN);
      newHeaders.set('Referer', TARGET_ORIGIN + '/');
      newHeaders.set('User-Agent', request.headers.get('User-Agent') || 'Mozilla/5.0');

      const fetchInit = {
        method: request.method,
        headers: newHeaders,
        redirect: 'manual'
      };
      if (!['GET','HEAD'].includes(request.method)) {
        fetchInit.body = await request.clone().arrayBuffer();
      }

      const response = await fetch(targetUrl, fetchInit);
      const responseHeaders = new Headers(response.headers);

      [
        'content-encoding','content-length','transfer-encoding','connection',
        'content-security-policy','content-security-policy-report-only',
        'x-frame-options','strict-transport-security','report-to',
        'cross-origin-opener-policy','cross-origin-embedder-policy',
        'cross-origin-resource-policy','permissions-policy'
      ].forEach(h => responseHeaders.delete(h));

      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Credentials', 'true');

      // ===== COOKIE =====
      const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      responseHeaders.delete('set-cookie');
      const cookiesToSet = rawCookies.map(cookie => {
        let c = cookie
          .replace(/Domain=[^;]+;?\s*/ig, '')
          .replace(/SameSite=[^;]+;?\s*/ig, '; SameSite=Lax')
          .replace(/Secure;?\s*/ig, '');
        if (!/path=/i.test(c)) c += '; Path=/';
        return c.trim();
      });

      // ===== REDIRECT =====
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          try {
            const locUrl = new URL(location, TARGET_ORIGIN);
            // Nếu redirect nội bộ → giữ ở proxy
            if (locUrl.hostname === TARGET_HOST) {
              responseHeaders.set('Location', PROXY_ORIGIN + locUrl.pathname + locUrl.search);
            } else {
              // Redirect ra ngoài → cũng kéo về proxy (tuỳ nhu cầu)
              responseHeaders.set('Location', PROXY_ORIGIN + locUrl.pathname + locUrl.search);
            }
          } catch {}
        }
        cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
        return new Response(null, { status: response.status, headers: responseHeaders });
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
      const isJs = contentType.includes('javascript') || contentType.includes('ecmascript');
      const isCss = contentType.includes('text/css');
      const isJson = contentType.includes('application/json');

      // ===== REWRITE BODY =====
      if (isHtml || isJs || isCss || isJson) {
        let text = await response.text();

        const escapedHost = TARGET_HOST.replace(/\./g, '\\.');
        const reHttp  = new RegExp(`https?://${escapedHost}`, 'g');
        const reProto = new RegExp(`//${escapedHost}`, 'g');

        text = text.replace(reHttp, PROXY_ORIGIN);
        text = text.replace(reProto, '//' + new URL(PROXY_ORIGIN).host);

        if (isHtml) {
          text = text.replace(
            /<meta\s+[^>]*http-equiv=["']refresh["'][^>]*>/gi,
            ''
          );

          const injectedScript = buildAntiDetectScript(PROXY_ORIGIN, TARGET_HOST);

          // Chèn CÀNG SỚM CÀNG TỐT — trước mọi script khác
          if (/<head[^>]*>/i.test(text)) {
            text = text.replace(/<head([^>]*)>/i, `<head$1>${injectedScript}`);
          } else if (/<html[^>]*>/i.test(text)) {
            text = text.replace(/<html([^>]*)>/i, `<html$1><head>${injectedScript}</head>`);
          } else {
            text = injectedScript + text;
          }
        }

        cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
        return new Response(text, { status: response.status, headers: responseHeaders });
      }

      // Binary passthrough
      cookiesToSet.forEach(c => responseHeaders.append('Set-Cookie', c));
      return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy Error', details: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};

// ============================================================
// SCRIPT CHỐNG ANTI-RETURN DETECTOR (chèn trước mọi script khác)
// ============================================================
function buildAntiDetectScript(PROXY_ORIGIN, TARGET_HOST) {
  return `<script>
(function(){
  'use strict';
  try {
    // ---- 1. Vô hiệu hoá Page Visibility API ----
    var hiddenProps = {
      hidden: false,
      visibilityState: 'visible',
      webkitHidden: false,
      webkitVisibilityState: 'visible',
      mozHidden: false,
      mozVisibilityState: 'visible',
      msHidden: false,
      msVisibilityState: 'visible'
    };
    Object.keys(hiddenProps).forEach(function(k){
      try {
        Object.defineProperty(document, k, { get: function(){ return hiddenProps[k]; }, configurable: false });
        Object.defineProperty(Document.prototype, k, { get: function(){ return hiddenProps[k]; }, configurable: false });
      } catch(e){}
    });

    // ---- 2. hasFocus luôn true ----
    try {
      Document.prototype.hasFocus = function(){ return true; };
      document.hasFocus = function(){ return true; };
    } catch(e){}

    // ---- 3. Chặn event blur/visibility/pagehide ----
    var blocked = ['visibilitychange','webkitvisibilitychange','mozvisibilitychange',
                   'msvisibilitychange','blur','pagehide','beforeunload','freeze'];
    var stopIt = function(e){
      try {
        e.stopImmediatePropagation();
        e.stopPropagation();
        if (e.preventDefault) e.preventDefault();
      } catch(_){}
      return false;
    };
    blocked.forEach(function(evt){
      try {
        window.addEventListener(evt, stopIt, true);
        document.addEventListener(evt, stopIt, true);
        document.body && document.body.addEventListener(evt, stopIt, true);
      } catch(e){}
    });

    // ---- 4. Override onblur / onvisibilitychange / onpagehide ----
    ['onblur','onvisibilitychange','onpagehide','onbeforeunload'].forEach(function(p){
      try {
        Object.defineProperty(window, p, { get: function(){ return null; }, set: function(){}, configurable: false });
        Object.defineProperty(document, p, { get: function(){ return null; }, set: function(){}, configurable: false });
      } catch(e){}
    });

    // ---- 5. requestAnimationFrame luôn chạy như đang visible ----
    var _raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = function(cb){
      return _raf(function(t){ cb(t); });
    };
    var _ric = window.requestIdleCallback;
    if (_ric) window.requestIdleCallback = function(cb, o){ return _ric(function(d){ cb(d); }, o); };

    // ---- 6. Chặn sendBeacon tracking ----
    if (navigator.sendBeacon) {
      navigator.sendBeacon = function(){ return true; };
    }

    // ---- 7. Chặn fetch/image beacon khi unload ----
    // Ghi đè window.fetch để ép mọi URL về proxy
    var _fetch = window.fetch;
    if (_fetch) {
      window.fetch = function(input, init){
        try {
          if (typeof input === 'string' && /^https?:\\/\\//i.test(input)) {
            var u = new URL(input);
            if (u.hostname !== location.hostname) {
              input = '${PROXY_ORIGIN}' + u.pathname + u.search + u.hash;
            }
          } else if (input && input.url && /^https?:\\/\\//i.test(input.url)) {
            var u2 = new URL(input.url);
            if (u2.hostname !== location.hostname) {
              input = new Request('${PROXY_ORIGIN}' + u2.pathname + u2.search + u2.hash, input);
            }
          }
        } catch(e){}
        return _fetch.call(this, input, init);
      };
    }

    // ---- 8. XMLHttpRequest open → rewrite ----
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      try {
        if (typeof url === 'string' && /^https?:\\/\\//i.test(url)) {
          var u = new URL(url);
          if (u.hostname !== location.hostname) {
            arguments[1] = '${PROXY_ORIGIN}' + u.pathname + u.search;
          }
        }
      } catch(e){}
      return _open.apply(this, arguments);
    };

    // ---- 9. Image.src tracking ----
    try {
      var _imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        get: _imgSrc.get,
        set: function(v){
          try {
            if (typeof v === 'string' && /^https?:\\/\\//i.test(v)) {
              var u = new URL(v);
              if (u.hostname !== location.hostname) v = '${PROXY_ORIGIN}' + u.pathname + u.search;
            }
          } catch(e){}
          return _imgSrc.set.call(this, v);
        },
        configurable: true
      });
    } catch(e){}

    // ---- 10. Override document.referrer / window.name ----
    try {
      Object.defineProperty(document, 'referrer', { get: function(){ return '${PROXY_ORIGIN}/'; }, configurable: false });
    } catch(e){}

  } catch(err) {
    console.warn('[AntiDetect]', err);
  }
})();
<\/script>`;
}
