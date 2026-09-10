console.error(
  "Local release builds are retired. Use .github/workflows/release.yml (v* tag) and its GitHub Actions artifacts.",
);
process.exitCode = 1;
