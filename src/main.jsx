import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import RJTerminal from './RJTerminal.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RJTerminal />
  </StrictMode>,
)
