'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { authApi } from '@/lib/api';
import { useAuth } from '@/contexts/auth-context';

interface BalanceContextType {
  balance: number;
  isLoading: boolean;
  refreshBalance: () => Promise<void>;
  setBalance: (balance: number) => Promise<void>;
  processPayment: (orderId: string, amount: number, sellerId?: string) => Promise<{ success: boolean; newBalance: number }>;
}

const BalanceContext = createContext<BalanceContextType | null>(null);

export function BalanceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  const [balance, setBalanceState] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);

  // Load balance from server when authenticated
  const refreshBalance = useCallback(async () => {
    if (!isAuthenticated) {
      setBalanceState(0);
      setIsLoading(false);
      return;
    }

    try {
      setIsLoading(true);
      const res = await authApi.getBalance();
      setBalanceState(res.balance);
    } catch (error) {
      console.error('Failed to fetch balance:', error);
      // Use user's balance from auth if available
      if (user?.balance !== undefined) {
        setBalanceState(user.balance);
      }
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, user]);

  // Initial load and when auth changes
  useEffect(() => {
    if (isAuthenticated) {
      // Use user's balance immediately if available
      if (user?.balance !== undefined) {
        setBalanceState(user.balance);
        setIsLoading(false);
      }
      // Then refresh from server
      refreshBalance();
    } else {
      setBalanceState(0);
      setIsLoading(false);
    }
  }, [isAuthenticated, user?.balance]);

  const setBalance = async (newBalance: number) => {
    try {
      const res = await authApi.updateBalance(newBalance);
      setBalanceState(res.balance);
    } catch (error) {
      console.error('Failed to update balance:', error);
      throw error;
    }
  };

  const processPayment = async (orderId: string, amount: number, sellerId?: string) => {
    try {
      const res = await authApi.processPayment({ orderId, amount, sellerId });
      setBalanceState(res.newBalance);
      return { success: true, newBalance: res.newBalance };
    } catch (error) {
      console.error('Payment failed:', error);
      throw error;
    }
  };

  return (
    <BalanceContext.Provider value={{ balance, isLoading, refreshBalance, setBalance, processPayment }}>
      {children}
    </BalanceContext.Provider>
  );
}

export function useBalance() {
  const context = useContext(BalanceContext);
  if (!context) {
    throw new Error('useBalance must be used within a BalanceProvider');
  }
  return context;
}
