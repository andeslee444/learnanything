import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Tells Turbopack the monorepo root so it can resolve files above the Next.js
  // app directory (e.g. workspace packages). Silences the multi-lockfile warning.
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
};

export default withWorkflow(nextConfig);
