import { createServer } from 'node:http'
import { URL } from 'node:url'

const secret = 'M5_PAGE_SECRET_MUST_NOT_CROSS_QUERY'

const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>M5 hostile automation target</title></head>
  <body data-page-secret="${secret}">
    <h1>M5 hostile automation target</h1>
    <input id="typed" aria-label="Automation input">
    <button id="commit">Commit input</button>
    <button id="popup">Open popup</button>
    <a id="download" download href="/download">Download</a>
    <button id="permission">Request permission</button>
    <button id="external">Open external URL</button>
    <a id="next" href="/next">Navigate next</a>
    <div id="never"></div>
    <script>
      const probe = {
        process: typeof globalThis.process,
        require: typeof globalThis.require,
        electron: typeof globalThis.electron,
        desktopBridge: typeof globalThis.desktopBridge,
        controlToken: typeof globalThis.controlToken,
        partition: typeof globalThis.partition
      };
      globalThis.__m5Probe = probe;
      globalThis.__m5Secret = document.body.dataset.pageSecret;
      globalThis.__m5InputCommitted = false;
      globalThis.__m5SelectorPolls = {};
      const originalQuerySelector = document.querySelector.bind(document);
      document.querySelector = selector => {
        if (selector === '#will-never-exist' || selector === '#still-never-exists') {
          globalThis.__m5SelectorPolls[selector] = (globalThis.__m5SelectorPolls[selector] ?? 0) + 1;
        }
        return originalQuerySelector(selector);
      };
      document.querySelector('#commit').addEventListener('click', () => {
        globalThis.__m5InputCommitted = document.querySelector('#typed').value.length > 0;
        fetch('/event/input', { method: 'POST' }).catch(() => undefined);
      });
      document.querySelector('#popup').addEventListener('click', () => {
        window.open('/popup', '_blank');
      });
      document.querySelector('#permission').addEventListener('click', () => {
        navigator.geolocation.getCurrentPosition(
          () => fetch('/event/permission-granted', { method: 'POST' }),
          () => fetch('/event/permission-denied', { method: 'POST' })
        );
      });
      document.querySelector('#external').addEventListener('click', () => {
        window.open('mailto:m5-should-not-open@example.invalid', '_blank');
      });
    </script>
  </body>
</html>`

export async function createBrowserAutomationTestServer() {
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: request.method ?? 'GET', path: url.pathname })
    if (url.pathname === '/download') {
      response.writeHead(200, {
        'content-disposition': 'attachment; filename="m5-forbidden-download.txt"',
        'content-type': 'text/plain; charset=utf-8'
      })
      response.end('M5_DOWNLOAD_BYTES_MUST_NOT_PERSIST')
      return
    }
    if (url.pathname.startsWith('/event/')) {
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (url.pathname === '/popup') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<title>Forbidden popup</title>')
      return
    }
    if (url.pathname === '/next') {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8'
      })
      response.end('<title>M5 navigation target</title><h1>M5 navigation target</h1>')
      return
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self' 'unsafe-inline'",
      'content-type': 'text/html; charset=utf-8'
    })
    response.end(html)
  })

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('M5 test server has no port')

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    secret,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()))
      })
  }
}
