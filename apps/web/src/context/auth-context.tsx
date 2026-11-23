import React, { createContext, useContext, useEffect, useState } from 'react';
import type { UserProfile, UserRole } from '@forgeflow/shared-types';
import { fetchMe } from '../lib/api-client';

export interface AuthContextValue {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: UserProfile | null;
  role: UserRole;
  refetch: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);

  const loadUser = async () => {
    try {
      const profile = await fetchMe();
      setUser(profile);
    } catch (err) {
      console.error('Failed to load local user from /api/me:', err);
    } finally {
      setIsLoaded(true);
    }
  };

  useEffect(() => {
    loadUser();
  }, []);

  const role: UserRole = user?.role || 'admin';

  return (
    <AuthContext.Provider
      value={{
        isLoaded,
        isSignedIn: true,
        user,
        role,
        refetch: loadUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAppAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAppAuth must be used within an AuthProvider');
  }
  return ctx;
}
