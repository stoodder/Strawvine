import { defineConfig } from "vitest/config";

/**
 * Two projects:
 * - node: domain logic, data layer and API tests (`*.test.ts`). The API tests share one test
 *   database, so files run one at a time.
 * - web:  component tests (`src/web/**\/*.test.tsx`) in jsdom with Testing Library.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        define: { __BUILD_ID__: JSON.stringify("test") },
        test: {
          name: "web",
          include: ["src/web/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./scripts/vitest-dom-setup.ts"],
        },
      },
    ],
  },
});
