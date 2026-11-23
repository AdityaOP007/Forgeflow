import { useEffect, useState } from 'react';
import { fetchHealth } from './lib/api-client';

export function App() {
  const [status, setStatus] = useState<string>('checking...');

  useEffect(() => {
    fetchHealth()
      .then((data) => {
        if (data.status === 'ok') {
          setStatus('ok');
        } else {
          setStatus('unreachable');
        }
      })
      .catch(() => {
        setStatus('unreachable');
      });
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-md p-8 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl text-center space-y-4">
        <h1 className="text-3xl font-bold tracking-tight text-white">ForgeFlow</h1>
        <p className="text-sm text-slate-400">Internal Developer Platform</p>
        <div className="pt-4 border-t border-slate-800">
          <p className="text-sm font-medium">
            API:{' '}
            <span
              className={
                status === 'ok'
                  ? 'text-emerald-400 font-semibold'
                  : status === 'unreachable'
                    ? 'text-rose-400 font-semibold'
                    : 'text-amber-400 font-semibold'
              }
            >
              {status}
            </span>
          </p>
        </div>
      </div>
    </main>
  );
}

export default App;

