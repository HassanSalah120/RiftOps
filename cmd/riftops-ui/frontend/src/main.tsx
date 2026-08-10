import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { LCUConnectionProvider } from './components/LCUProvider'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LCUConnectionProvider>
      <App />
    </LCUConnectionProvider>
  </StrictMode>,
)
