import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // next dev writes AGENTS.md and CLAUDE.md into the app whenever it detects a
  // coding agent, and Replit's REPL_ID counts as one. Keep that generation off
  // so generated files never become repository state.
  agentRules: false,
  // Build and dev output goes to dist/, which the root .gitignore already
  // ignores. Prettier reads that file too, so format:check never scans output.
  distDir: "dist",
};

export default nextConfig;
