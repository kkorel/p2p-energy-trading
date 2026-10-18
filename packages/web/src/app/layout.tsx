import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { AuthProvider } from '@/contexts/auth-context';
import { BalanceProvider } from '@/contexts/balance-context';
import { P2PStatsProvider } from '@/contexts/p2p-stats-context';
import { DataUpdateProvider } from '@/contexts/data-update-context';
import { ToastProvider, ConfirmProvider } from '@/components/ui';
import { ChatBubble } from '@/components/chat/chat-bubble';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'EnergyTrade - P2P Renewable Energy',
  description: 'Buy and sell renewable energy directly from your neighbors',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'EnergyTrade',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0d9488',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
      </head>
      <body className="font-sans antialiased">
        <AuthProvider>
          <BalanceProvider>
            <DataUpdateProvider>
              <P2PStatsProvider>
                <ToastProvider>
                  <ConfirmProvider>
                    {children}
                    <ChatBubble />
                  </ConfirmProvider>
                </ToastProvider>
              </P2PStatsProvider>
            </DataUpdateProvider>
          </BalanceProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
