import type { NextConfig } from "next";

// Security headers sent with every response (MVP-001 D-5). They are the same
// in every environment: nothing here depends on how the app is run.
//
// The Content-Security-Policy loads scripts, styles, images, fonts and
// connections from this origin only, and nothing may frame the app, embed a
// plugin, change the base URL, or post a form elsewhere. The browser never
// calls the identity provider itself, so connections stay on this origin.
// The App Router streams each page's hydration data in inline scripts whose
// content changes with every request, so they cannot be allowed by hash;
// 'unsafe-inline' for scripts is the minimal policy that hydrates without a
// per-request nonce, which would require every page to render dynamically.
// No 'unsafe-eval' and no inline style is allowed.
//
// Referrer-Policy is same-origin: no referrer ever leaves this origin. With
// no-referrer, browsers send "Origin: null" on a same-origin form post made
// before hydration, and Next.js refuses that as a cross-site Server Action.
//
// A header set here replaces the same header set by a route handler. The
// email confirmation handler sends its own stricter policy, framing,
// referrer and sniffing headers on every response, so it receives only the
// transport security header from here and keeps its own.
//
// MVP-001 S3: a voice memo plays through a short-lived signed URL that the
// server issues on the configured Supabase origin, so media loads only on
// exactly that origin: the public project URL the build already inlines,
// when it is a hosted project's HTTPS origin or the local stack's loopback
// origin. Any other value, or none, admits no media source at all.
const SUPABASE_ORIGIN =
  /^(?:https:\/\/[a-z]{20}\.supabase\.co|http:\/\/(?:127\.0\.0\.1|localhost):54321)$/;

function mediaSource(url: string | undefined): string {
  const origin = typeof url === "string" ? url.replace(/\/$/, "") : "";
  return SUPABASE_ORIGIN.test(origin) ? origin : "'none'";
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  `media-src ${mediaSource(process.env.NEXT_PUBLIC_SUPABASE_URL)}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const TRANSPORT_SECURITY = {
  key: "Strict-Transport-Security",
  value: "max-age=31536000; includeSubDomains",
};

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  TRANSPORT_SECURITY,
];

const nextConfig: NextConfig = {
  // next dev writes AGENTS.md and CLAUDE.md into the app whenever it detects a
  // coding agent, and Replit's REPL_ID counts as one. Keep that generation off
  // so generated files never become repository state.
  agentRules: false,
  // Build and dev output goes to dist/, which the root .gitignore already
  // ignores. Prettier reads that file too, so format:check never scans output.
  distDir: "dist",
  async headers() {
    return [
      { source: "/((?!auth/confirm$).*)", headers: SECURITY_HEADERS },
      { source: "/auth/confirm", headers: [TRANSPORT_SECURITY] },
    ];
  },
};

export default nextConfig;
