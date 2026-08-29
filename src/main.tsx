import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { VersionBadge } from './ui/VersionBadge'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <VersionBadge />
  </StrictMode>,
)
