'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { authApi, type User, type VerifyOtpResponse } from '@/lib/api';

// Custom error for when VCs are required for signup
export class VCRequiredError extends Error {
  requiresVC: string[];
  userId: string;
  isNewUser: boolean;

  constructor(response: { requiresVC: string[]; userId: string; isNewUser: boolean; message: string }) {
    super(response.message);
    this.name = 'VCRequiredError';
    this.requiresVC = response.requiresVC;
    this.userId = response.userId;
    this.isNewUser = response.isNewUser;
  }
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (phone: string, otp: string, name?: string) => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (user: User) => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  const checkAuth = useCallback(async () => {
    const token = localStorage.getItem('authToken');
    if (!token) {
      setIsLoading(false);
      return;
    }

    try {
      const { user } = await authApi.getMe();
      setUser(user);
    } catch (error: any) {
      // Only remove token on 401 (unauthorized), not on network/server errors
      // This prevents logout on temporary server issues (502, 503, network errors)
      if (error?.status === 401) {
        localStorage.removeItem('authToken');
      } else {
        console.warn('Auth check failed (server issue, keeping token):', error?.message);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();

    // Listen for login events (from chat agent OTP auth)
    const handleLogin = () => {
      checkAuth();
    };
    window.addEventListener('auth:login', handleLogin);

    // Listen for logout events (from API 401)
    const handleLogout = () => {
      setUser(null);
    };
    window.addEventListener('auth:logout', handleLogout);
    return () => {
      window.removeEventListener('auth:login', handleLogin);
      window.removeEventListener('auth:logout', handleLogout);
    };
  }, [checkAuth]);

  const login = async (phone: string, otp: string, name?: string) => {
    const result = await authApi.verifyOtp(phone, otp, name);

    // Check if VCs are required
    if (!result.success) {
      throw new VCRequiredError(result);
    }

    localStorage.setItem('authToken', result.token);
    setUser(result.user);
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } catch (error) {
      // Ignore logout errors
    }
    localStorage.removeItem('authToken');
    setUser(null);

    // Redirect to home page (which will show login)
    router.push('/');
  };

  const updateUser = (updatedUser: User) => {
    setUser(updatedUser);
  };

  const refreshUser = useCallback(async () => {
    const token = localStorage.getItem('authToken');
    if (!token) return;

    try {
      const { user } = await authApi.getMe();
      setUser(user);
    } catch (error) {
      // Ignore refresh errors
    }
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
        updateUser,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

