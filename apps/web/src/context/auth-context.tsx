import React, { createContext, useContext, useEffect, useState } from 'react';
import { ClerkProvider, useAuth, useUser } from '@clerk/clerk-react';
import type { UserProfile, UserRole } from '@forgeflow/shared-types';
import { fetchMe } from '../lib/api-client';

export interface AuthContextValue {
  isSignedIn: boolean;
  isLoaded: boolean;
  token: string | null;
  user: UserProfile | null;
  role: UserRole | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function ClerkAuthConsumer({ children }: { children: React.ReactNode }) {
  const { isLoaded: clerkLoaded, isSignedIn, getToken, signOut } = useAuth();
  const { user: clerkUser } = useUser();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoadingProfile, setIsLoadingProfile] = useState<boolean>(true);

  useEffect(() => {
    if (!clerkLoaded) return;

    if (!isSignedIn) {
      setToken(null);
      setProfile(null);
      setIsLoadingProfile(false);
      return;
    }

    let mounted = true;
    setIsLoadingProfile(true);

    getToken()
      .then(async (jwt) => {
        if (!mounted) return;
        setToken(jwt);
        if (!jwt) {
          setIsLoadingProfile(false);
          return;
        }

        try {
          const userProfile = await fetchMe(jwt);
          if (mounted) setProfile(userProfile);
        } catch (err) {
          console.error('Failed to fetch user profile from /api/me:', err);
        } finally {
          if (mounted) setIsLoadingProfile(false);
        }
      })
      .catch((err) => {
        console.error('Failed to get Clerk session token:', err);
        if (mounted) setIsLoadingProfile(false);
      });

    return () => {
      mounted = false;
    };
  }, [clerkLoaded, isSignedIn, getToken, clerkUser]);

  const role = profile?.role || 'viewer';

  return (
    <AuthContext.Provider
      value={{
        isSignedIn: Boolean(isSignedIn),
        isLoaded: clerkLoaded && !isLoadingProfile,
        token,
        user: profile,
        role,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

  if (!clerkPubKey) {
    throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in environment');
  }

  return (
    <ClerkProvider publishableKey={clerkPubKey}>
      <ClerkAuthConsumer>{children}</ClerkAuthConsumer>
    </ClerkProvider>
  );
}

export function useAppAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAppAuth must be used within an AuthProvider');
  return ctx;
}
