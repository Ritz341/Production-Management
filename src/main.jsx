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
