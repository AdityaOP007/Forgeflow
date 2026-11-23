import React from 'react';
import { SignIn } from '@clerk/clerk-react';
import { Terminal } from 'lucide-react';

export function SignInScreen() {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-slate-100">
      <div className="w-full max-w-md space-y-6">
        {/* Brand Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex h-12 w-12 rounded-xl bg-indigo-600 items-center justify-center text-white shadow-xl shadow-indigo-600/20 mb-2">
            <Terminal className="h-6 w-6" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-white">ForgeFlow</h1>
          <p className="text-sm text-slate-400">Internal Developer Platform</p>
        </div>

        {/* Real Clerk Sign-In Component */}
        <div className="flex justify-center">
          <SignIn
            appearance={{
              elements: {
                card: 'bg-slate-900 border border-slate-800 shadow-2xl',
                headerTitle: 'text-white',
                headerSubtitle: 'text-slate-400',
                formButtonPrimary: 'bg-indigo-600 hover:bg-indigo-500 text-white',
                socialButtonsBlockButton:
                  'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700',
                formFieldInput: 'bg-slate-950 border-slate-700 text-white',
                footerActionLink: 'text-indigo-400 hover:text-indigo-300',
              },
            }}
          />
        </div>
      </div>
    </div>
  );
}
