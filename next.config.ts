import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Explicit root: this is a standalone app; without this Next infers the parent dir (which has an unrelated lockfile).
  turbopack: {
    root: __dirname,
  },
};

export default withWorkflow(nextConfig);
