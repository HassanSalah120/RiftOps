import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './design-system.css'
import App from './App.tsx'
import { LCUConnectionProvider } from './components/LCUProvider'
import { LocaleProvider } from './locale'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleProvider>
      <LCUConnectionProvider>
        <App />
      </LCUConnectionProvider>
    </LocaleProvider>
  </StrictMode>,
)
