import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Enable standalone output for Docker deployment only
  // Disabled for Vercel deployment
  // output: 'standalone',
  
  // Proxy API requests to the backend
  // Note: In production, these are handled by vercel.json rewrites
  async rewrites() {
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    
    // Only use rewrites in development or when API_URL is explicitly set
    if (process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_API_URL) {
      return [
        {
          source: '/api/:path*',
          destination: `${apiUrl}/api/:path*`,
        },
        {
          source: '/auth/:path*',
          destination: `${apiUrl}/auth/:path*`,
        },
        {
          source: '/seller/:path*',
          destination: `${apiUrl}/seller/:path*`,
        },
        {
          source: '/callbacks/:path*',
          destination: `${apiUrl}/callbacks/:path*`,
        },
        {
          source: '/chat/:path*',
          destination: `${apiUrl}/chat/:path*`,
        },
      ];
    }
    
    return [];
  },
};

export default nextConfig;
