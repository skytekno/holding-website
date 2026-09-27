import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";
import path from "node:path";

export default defineConfig([
  globalIgnores(["**/.next/**", "**/next-env.d.ts", "playwright-report/**", "test-results/**"]),
  {
    files: ["web/**/*.{ts,tsx}", "dashboard/**/*.{ts,tsx}"],
    extends: [...nextVitals],
    settings: { next: { rootDir: [path.join(import.meta.dirname, "web"), path.join(import.meta.dirname, "dashboard")] } },
  },
  {
    files: ["web/**/*.{ts,tsx}", "dashboard/**/*.{ts,tsx}", "tests/**/*.ts", "playwright.config.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ["./web/tsconfig.json", "./dashboard/tsconfig.json", "./tsconfig.tests.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/ban-ts-comment": ["error", {
        "ts-ignore": true,
        "ts-nocheck": true,
        "ts-expect-error": "allow-with-description",
        minimumDescriptionLength: 12,
      }],
    },
  },
]);
