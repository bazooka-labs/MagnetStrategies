/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    // /earn was renamed to /pools — keep old links/bookmarks working.
    return [
      { source: "/earn", destination: "/pools", permanent: true },
      { source: "/api/earn/pools", destination: "/api/pools", permanent: true },
    ];
  },
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};

module.exports = nextConfig;
