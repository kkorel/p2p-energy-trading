'use client';

import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { buyerApi, sellerApi } from '@/lib/api';
import { useAuth } from './auth-context';
import { useDataUpdate } from './data-update-context';

interface P2PStats {
  totalSold: number;
  avgSellPrice: number;
  totalBought: number;
  avgBuyPrice: number;
  totalValue: number;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

const P2PStatsContext = createContext<P2PStats | undefined>(undefined);

// Reference DISCOM rates for value calculation
const DISCOM_BUY_RATE = 8;    // Rs per kWh (what DISCOM charges consumers)
const DISCOM_SELLBACK_RATE = 2; // Rs per kWh (what DISCOM pays for surplus)

export function P2PStatsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { statsVersion } = useDataUpdate();
  const [stats, setStats] = useState({
    totalSold: 0,
    avgSellPrice: 0,
    totalBought: 0,
    avgBuyPrice: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchStats = async () => {
    if (!user) {
      setStats({ totalSold: 0, avgSellPrice: 0, totalBought: 0, avgBuyPrice: 0 });
      setIsLoading(false);
      return;
    }

    try {
      // Fetch both buyer and seller orders
      const [buyerResult, sellerResult] = await Promise.all([
        buyerApi.getMyOrders().catch(() => ({ orders: [] })),
        sellerApi.getMyOrders().catch(() => ({ orders: [] })),
      ]);

      // Filter for active/completed orders only (excludes cancelled/pending)
      // Order statuses: DRAFT -> PENDING -> ACTIVE -> COMPLETED (or CANCELLED)
      const confirmedBuyerOrders = buyerResult.orders.filter(
        (o) => o.status === 'ACTIVE' || o.status === 'COMPLETED'
      );
      const confirmedSellerOrders = sellerResult.orders.filter(
        (o) => o.status === 'ACTIVE' || o.status === 'COMPLETED'
      );

      // Calculate buyer stats
      let totalBought = 0;
      let totalBuyValue = 0;
      for (const order of confirmedBuyerOrders) {
        const qty = order.itemInfo?.quantity || order.quote?.totalQuantity || 0;
        const price = order.itemInfo?.price_per_kwh || (order.quote?.price?.value && order.quote?.totalQuantity ? order.quote.price.value / order.quote.totalQuantity : 0);
        totalBought += qty;
        totalBuyValue += qty * price;
      }

      // Calculate seller stats
      let totalSold = 0;
      let totalSellValue = 0;
      for (const order of confirmedSellerOrders) {
        const qty = order.itemInfo?.sold_quantity || order.quote?.totalQuantity || 0;
        const price = order.itemInfo?.price_per_kwh || (order.quote?.price?.value && order.quote?.totalQuantity ? order.quote.price.value / order.quote.totalQuantity : 0);
        totalSold += qty;
        totalSellValue += qty * price;
      }

      setStats({
        totalSold,
        avgSellPrice: totalSold > 0 ? totalSellValue / totalSold : 0,
        totalBought,
        avgBuyPrice: totalBought > 0 ? totalBuyValue / totalBought : 0,
      });
    } catch (err) {
      console.error('Failed to fetch P2P stats:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, [user]);

  // Refresh stats when triggered by other components (e.g., after order completion)
  useEffect(() => {
    // Skip on initial mount (version starts at 0)
    if (statsVersion > 0) {
      fetchStats();
    }
  }, [statsVersion]);

  // Calculate total value
  const sellerGain = stats.totalSold * (stats.avgSellPrice - DISCOM_SELLBACK_RATE);
  const buyerSavings = stats.totalBought * (DISCOM_BUY_RATE - stats.avgBuyPrice);
  const totalValue = sellerGain + buyerSavings;

  const value: P2PStats = {
    ...stats,
    totalValue,
    isLoading,
    refresh: fetchStats,
  };

  return <P2PStatsContext.Provider value={value}>{children}</P2PStatsContext.Provider>;
}

export function useP2PStats() {
  const context = useContext(P2PStatsContext);
  if (context === undefined) {
    throw new Error('useP2PStats must be used within a P2PStatsProvider');
  }
  return context;
}
