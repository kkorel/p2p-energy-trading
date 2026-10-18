'use client';

import { createContext, useContext, useCallback, useState, ReactNode } from 'react';

/**
 * Data Update Context
 * 
 * Provides a way to notify components when data should be refreshed.
 * Instead of constant polling, components can:
 * 1. Subscribe to update events
 * 2. Trigger updates after actions (accept, cancel, update offer)
 * 
 * This prevents the auto-refresh from disrupting user interactions
 * while still ensuring both buyer and seller see updates when actions occur.
 */

type UpdateType = 'offers' | 'orders' | 'stats' | 'all';

interface DataUpdateContextType {
  // Trigger a data refresh for specific data types
  triggerUpdate: (types: UpdateType | UpdateType[]) => void;
  // Version numbers that components can watch to know when to refresh
  offersVersion: number;
  ordersVersion: number;
  statsVersion: number;
}

const DataUpdateContext = createContext<DataUpdateContextType | undefined>(undefined);

export function DataUpdateProvider({ children }: { children: ReactNode }) {
  const [offersVersion, setOffersVersion] = useState(0);
  const [ordersVersion, setOrdersVersion] = useState(0);
  const [statsVersion, setStatsVersion] = useState(0);

  const triggerUpdate = useCallback((types: UpdateType | UpdateType[]) => {
    const typeArray = Array.isArray(types) ? types : [types];
    
    for (const type of typeArray) {
      switch (type) {
        case 'offers':
          setOffersVersion(v => v + 1);
          break;
        case 'orders':
          setOrdersVersion(v => v + 1);
          break;
        case 'stats':
          setStatsVersion(v => v + 1);
          break;
        case 'all':
          setOffersVersion(v => v + 1);
          setOrdersVersion(v => v + 1);
          setStatsVersion(v => v + 1);
          break;
      }
    }
  }, []);

  return (
    <DataUpdateContext.Provider value={{ triggerUpdate, offersVersion, ordersVersion, statsVersion }}>
      {children}
    </DataUpdateContext.Provider>
  );
}

export function useDataUpdate() {
  const context = useContext(DataUpdateContext);
  if (context === undefined) {
    throw new Error('useDataUpdate must be used within a DataUpdateProvider');
  }
  return context;
}

/**
 * Hook to trigger updates after an action completes.
 * Use this in components that modify offers or orders.
 * 
 * Example usage:
 * ```tsx
 * const { triggerOrderUpdate, triggerOfferUpdate } = useDataUpdateActions();
 * 
 * const handleCancelOrder = async () => {
 *   await cancelOrder();
 *   triggerOrderUpdate(); // This will notify other components to refresh
 * };
 * ```
 */
export function useDataUpdateActions() {
  const { triggerUpdate } = useDataUpdate();

  return {
    triggerOfferUpdate: () => triggerUpdate(['offers', 'stats']),
    triggerOrderUpdate: () => triggerUpdate(['orders', 'stats']),
    triggerAllUpdate: () => triggerUpdate('all'),
  };
}
