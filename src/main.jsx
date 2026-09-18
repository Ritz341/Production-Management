import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { AuthProvider } from './lib/AuthContext.jsx'
import { ConnectionProvider } from './lib/ConnectionContext.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ConnectionProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ConnectionProvider>
    </BrowserRouter>
  </React.StrictMode>
)

// Makes the app installable ("Add to Home Screen") and open full screen
// on the shop tablets. Production only — in dev a cached shell would
// hide your latest edits.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'))
}
