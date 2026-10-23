/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    // NOTE: /strategy is NOT here. It redirected to /trade, because that was
    // the Trading Terminal's former name — the terminal now owns /trade only,
    // and /strategy is the liquidity page. Anyone whose browser cached the old
    // PERMANENT redirect will still land on /trade until that cache expires;
    // nothing can be done about that from here, and the population is whoever
    // visited /strategy before 2026-10-20.

    // /earn was renamed to /pools, since folded into /tokens — keep old links/bookmarks working.
    // /dao (v1 MagnetDAO) was retired in favor of /vote (UVote), which has since
    // folded into the $U side of /tokens as a Governance section.
    // /token and /musd were consolidated into /tokens (toggle between $U and mUSD).
    // /pools was folded into the $U side of /tokens.
    return [
      { source: "/earn", destination: "/tokens", permanent: true },
      { source: "/api/earn/pools", destination: "/api/pools", permanent: true },
      // /dao and /vote both land on the $U page: UVote is a section of it now,
      // so these point straight there rather than hopping through a route that
      // itself redirects.
      { source: "/dao", destination: "/tokens#governance", permanent: true },
      { source: "/dao/:path*", destination: "/tokens#governance", permanent: true },
      { source: "/vote", destination: "/tokens#governance", permanent: true },
      { source: "/vote/:path*", destination: "/tokens#governance", permanent: true },
      { source: "/token", destination: "/tokens", permanent: true },
      { source: "/musd", destination: "/tokens?tab=musd", permanent: true },
      { source: "/pools", destination: "/tokens", permanent: true },
    ];
  },
  /**
   * Security headers.
   *
   * ── Why the CSP is REPORT-ONLY ─────────────────────────────────────────
   * An enforcing Content-Security-Policy is the right end state, and this is
   * deliberately not it yet. The app talks to ~23 external origins, and the
   * wallet connectors (Pera, Defly, WalletConnect, Lute) reach relay and
   * verification endpoints resolved at runtime that are not all visible in
   * the source. A `connect-src` that misses one does not degrade gracefully —
   * it breaks wallet connection outright, which is worse than the problem the
   * policy solves, and it would land on launch day.
   *
   * Report-Only blocks nothing. It reports violations to the console, which
   * is enough to find the gaps by using the site normally. Walk ALL of these
   * before flipping it, because each exercises a different directive:
   *   - connect with EVERY connector, and specifically pick Pera Web /
   *     Defly Web over the mobile QR flow                  (connect-src AND
   *     frame-src — the web wallets are IFRAMES, see below)
   *   - open a vault on /magnetfi                          (connect-src)
   *   - /tokens, both the $U and mUSD tabs                 (frame-src: vestige)
   *   - /trade, switch to the Advanced chart               (frame-src + script-src)
   *   - place and cancel a perps order                     (connect-src)
   * When the console is clean, rename the header to `Content-Security-Policy`.
   * Do that as its own change, not bundled with anything else.
   *
   * ── srcdoc frames INHERIT this policy — they are not covered by frame-src ──
   * This block previously claimed the TradingView loader was "governed by
   * frame-src, not script-src" because it runs inside a sandboxed srcdoc
   * iframe. That is wrong in both halves, and wrong in the direction that
   * breaks things only once the policy is enforced:
   *
   *   - An `about:srcdoc` document is created from its parent and receives a
   *     CLONE OF THE PARENT'S POLICY CONTAINER, CSP included. Sandboxing does
   *     not sever that (it was the explicit fix for the old srcdoc-CSP
   *     loophole). So `script-src` below applies INSIDE the frame, and the
   *     frame's `s.src = s3.tradingview.com/...` needs that origin listed —
   *     hence it appears in `script-src`, not just here in prose.
   *   - `frame-src` governs frame NAVIGATIONS. `about:srcdoc` issues no
   *     request, so frame-src never evaluates against it at all. What
   *     frame-src does govern is the iframe the loader then creates, and that
   *     one points at `www.tradingview-widget.com` (with `s.tradingview.com`
   *     as its own CSP fallback) — NOT `www.tradingview.com`, which is never
   *     framed. The loader literally ships the string "Please update your CSP
   *     rules to allow the tradingview-widget.com origin for frame-src."
   *
   * `vestige.fi` is here because /tokens frames a Vestige price widget on both
   * the $U and mUSD tabs (VestigeChart.tsx). The earlier version of this
   * comment said frame-src was "the sandboxed TradingView frame, and nothing
   * else", which was simply not an enumeration of the app's frames.
   *
   * ⚠️ AND IT STILL IS NOT COMPLETE. Pera Connect's desktop path FRAMES the
   * Pera Web Wallet (`PERA_WALLET_IFRAME_ID`), and its host comes from Pera's
   * API at runtime (`web_wallet_url`), not from the bundle — so it cannot be
   * enumerated from source at all. Defly ships the same modal shape. The
   * wildcards below are a best guess; the checklist above is what actually
   * resolves it. The "incomplete on purpose" caveat written against
   * connect-src applies here too.
   *
   * Wildcard syntax: `https://*.example.com` does NOT match bare
   * `example.com`, and redirects are re-checked against the policy, so hosts
   * reachable either way are listed both ways.
   *
   * ── What is actually enforced today ────────────────────────────────────
   * Only the three plain headers below. `frame-ancestors` is inside the
   * Report-Only value, so despite being the modern anti-framing directive it
   * enforces NOTHING here — the clickjacking protection comes entirely from
   * `X-Frame-Options: DENY`. It stays in the policy so it is correct on the
   * day this is flipped.
   *
   * There is no `report-to`/`report-uri`, so violations only reach a console
   * someone has open. That is adequate for a deliberate walkthrough and
   * useless for catching real users' failures; wire a collector if this stays
   * Report-Only for long.
   */
  async headers() {
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      /**
       * s3.tradingview.com was here because a `srcdoc` frame inherits this
       * policy and that frame loaded TradingView's loader script. Removed
       * 2026-10-23: the chart now frames their widget page directly, so no
       * TradingView script is ever requested from OUR document and no
       * third-party script origin needs allowing here at all.
       *
       * The scripts their page loads are governed by THEIR policy in THEIR
       * document — a real cross-origin frame has its own. `frame-src` below
       * still lists the widget hosts, which is what governs the frame itself.
       */
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      "img-src 'self' data: blob: https:",
      // The widget frame the loader creates, its CSP fallback host, and the
      // Vestige price widget on /tokens.
      [
        "frame-src",
        "https://www.tradingview-widget.com https://s.tradingview.com",
        "https://vestige.fi https://*.vestige.fi",
        // Wallet web-wallet iframes. Runtime-resolved hosts — see above.
        "https://perawallet.app https://*.perawallet.app",
        "https://defly.app https://*.defly.app",
      ].join(" "),
      [
        "connect-src 'self'",
        "https://mainnet-api.algonode.cloud https://mainnet-idx.algonode.cloud",
        "https://testnet-api.algonode.cloud https://testnet-idx.algonode.cloud",
        "https://mainnet-api.4160.nodely.dev",
        "https://pub-1e72beea87f04ebfafce248132310425.r2.dev",
        "https://api.exchange.coinbase.com https://api.coingecko.com",
        "https://mainnet.analytics.tinyman.org https://api.pact.fi",
        "https://api.vestigelabs.org https://hogswap-v1.liquihog.dev",
        "https://allo.info",
        // Wallet connectors. Incomplete on purpose — this list is what
        // Report-Only exists to finish.
        "https://*.walletconnect.com https://*.walletconnect.org",
        "wss://*.walletconnect.com wss://*.walletconnect.org",
        "https://perawallet.app https://*.perawallet.app",
        "https://defly.app https://*.defly.app",
      ].join(" "),
    ].join("; ");

    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy-Report-Only", value: csp },
        // The only genuinely enforced headers here. None has a compatibility
        // surface: nothing in this app is meant to be embedded.
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ],
    }];
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
