import { createServer } from 'node:http'
import { setTimeout } from 'node:timers'
import { URL } from 'node:url'

const page = ({ title, heading, body = '' }) => `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${heading}</h1>
    ${body}
    <output id="isolation"></output>
    <script>
      const probe = {
        process: typeof globalThis.process,
        require: typeof globalThis.require,
        electron: typeof globalThis.electron,
        desktopBridge: typeof globalThis.desktopBridge
      };
      globalThis.__browserIsolationProbe = probe;
      document.querySelector('#isolation').textContent = JSON.stringify(probe);
    </script>
  </body>
</html>`

export async function createBrowserTestServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const send = (html) => {
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8'
      })
      response.end(html)
    }

    if (url.pathname === '/slow') {
      setTimeout(
        () => send(page({ title: 'Slow Browser Target', heading: 'Slow browser target' })),
        1_500
      )
      return
    }
    if (url.pathname === '/next') {
      send(
        page({
          title: 'Navigation Target',
          heading: 'Navigation target',
          body: '<a id="home" href="/">Back to initial</a>'
        })
      )
      return
    }
    if (url.pathname === '/popup') {
      send(page({ title: 'Popup Target', heading: 'Same-origin popup target' }))
      return
    }
    if (url.pathname === '/download') {
      response.writeHead(200, {
        'content-disposition': 'attachment; filename="browser-test.txt"',
        'content-type': 'text/plain; charset=utf-8'
      })
      response.end('deterministic browser download')
      return
    }
    send(
      page({
        title: 'Initial Browser Test',
        heading: 'Initial browser test',
        body:
          '<a id="next" href="/next">Navigate next</a>' +
          '<button id="popup" onclick="window.open(\'/popup\', \'_blank\')">Open popup</button>'
      })
    )
  })

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Browser test server has no port')
  const origin = `http://127.0.0.1:${String(address.port)}`

  return {
    origin,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()))
      })
  }
}
