import { StrictMode } from 'react'
import { applyBuildTimeBackgroundPolicy } from './lib/theme';
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

applyBuildTimeBackgroundPolicy();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
