/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    // /earn was renamed to /pools — keep old links/bookmarks working.
    // /dao (v1 MagnetDAO) was retired in favor of /vote (UVote).
    return [
      { source: "/earn", destination: "/pools", permanent: true },
      { source: "/api/earn/pools", destination: "/api/pools", permanent: true },
      { source: "/dao", destination: "/vote", permanent: true },
      { source: "/dao/:path*", destination: "/vote", permanent: true },
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
