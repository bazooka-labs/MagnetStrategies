/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    // /earn was renamed to /pools, since folded into /tokens — keep old links/bookmarks working.
    // /dao (v1 MagnetDAO) was retired in favor of /vote (UVote).
    // /token and /musd were consolidated into /tokens (toggle between $U and mUSD).
    // /pools was folded into the $U side of /tokens.
    return [
      { source: "/earn", destination: "/tokens", permanent: true },
      { source: "/api/earn/pools", destination: "/api/pools", permanent: true },
      { source: "/dao", destination: "/vote", permanent: true },
      { source: "/dao/:path*", destination: "/vote", permanent: true },
      { source: "/token", destination: "/tokens", permanent: true },
      { source: "/musd", destination: "/tokens?tab=musd", permanent: true },
      { source: "/pools", destination: "/tokens", permanent: true },
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
