import type { NextConfig } from "next";

// Response headers applied to every route. This deployment is public (see
// SECURITY.md), so these are what stands between it and the cheap, generic
// attacks — clickjacking, MIME sniffing, referrer leakage.
//
// There is deliberately no Content-Security-Policy yet: Next's inline bootstrap
// and Recharts' generated styles both need either 'unsafe-inline' or a nonce,
// and a CSP with 'unsafe-inline' is a CSP that does nothing while looking like
// it does something. Adding a real nonce-based policy is a separate change.
const securityHeaders = [
  // No embedding: the app has destructive-ish actions behind buttons, and
  // framing is how those get clicked by someone else.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  // Don't let a browser second-guess a declared content type.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send the origin to third parties, never the full path — the paths here
  // include dates and station identifiers.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Vercel already serves HTTPS only; this makes the browser refuse to try HTTP.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  // The app uses none of these.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
