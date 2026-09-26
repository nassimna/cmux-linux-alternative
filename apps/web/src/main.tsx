import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import '@fontsource-variable/jetbrains-mono/wght.css'
import '@xterm/xterm/css/xterm.css'
import './styles/foundation.css'
import './styles.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Renderer root element is missing')
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
