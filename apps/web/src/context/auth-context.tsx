import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useAuth, useClerk } from '@clerk/clerk-react';
import type { UserProfile, UserRole } from '@forgeflow/shared-types';
import { fetchMe, setAuthTokenGetter } from '../lib/api-client';

export interface AuthContextValue {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: UserProfile | null;
  role: UserRole;
  refetch: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { isLoaded: clerkLoaded, isSignedIn: clerkSignedIn, getToken } = useAuth();
  const { signOut: clerkSignOut } = useClerk();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState<boolean>(false);

  useEffect(() => {
    setAuthTokenGetter(() => getToken());
  }, [getToken]);

  const loadUser = useCallback(async () => {
    if (!clerkLoaded) return;
    if (!clerkSignedIn) {
      setUser(null);
      setProfileLoaded(true);
      return;
    }
    try {
      const profile = await fetchMe();
      setUser(profile);
    } catch (err) {
      console.error('Failed to load user from /api/me:', err);
      setUser(null);
    } finally {
      setProfileLoaded(true);
    }
  }, [clerkLoaded, clerkSignedIn]);

  useEffect(() => {
    if (clerkLoaded) {
      loadUser();
    }
  }, [clerkLoaded, clerkSignedIn, loadUser]);

  const role: UserRole = user?.role || 'viewer';

  return (
    <AuthContext.Provider
      value={{
        isLoaded: clerkLoaded && (!clerkSignedIn || profileLoaded),
        isSignedIn: Boolean(clerkSignedIn),
        user,
        role,
        refetch: loadUser,
        signOut: () => clerkSignOut({ redirectUrl: '/' }),
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
