import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LCUConnectionProvider } from './components/LCUProvider'
import { LocaleProvider } from './locale'
import { registerServiceWorker } from './pwa'

registerServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider>
      <LCUConnectionProvider>
        <App />
      </LCUConnectionProvider>
    </LocaleProvider>
  </StrictMode>,
)

