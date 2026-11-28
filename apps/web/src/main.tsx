import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClerkProvider } from '@clerk/clerk-react';
import App from './App';
import './index.css';

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {publishableKey ? (
      <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
        <App />
      </ClerkProvider>
    ) : (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-rose-500/40 bg-rose-950/20 p-6 space-y-2 text-center">
          <h1 className="text-lg font-semibold text-white">Clerk Configuration Missing</h1>
          <p className="text-sm text-slate-300">
            Set <span className="font-mono text-rose-300">VITE_CLERK_PUBLISHABLE_KEY</span> in{' '}
            <span className="font-mono">apps/web/.env</span> and restart Vite.
          </p>
        </div>
      </div>
    )}
  </React.StrictMode>
);
