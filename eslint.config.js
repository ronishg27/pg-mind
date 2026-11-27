import tseslint from "typescript-eslint";
import eslint from "@eslint/js";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    prettierConfig,
    {
        ignores: [
            "dist/**",
            "node_modules/**",
            "coverage/**",
            ".env",
            ".env.local",
            "pg-mind.config.yaml",
            "vitest.config.ts",
        ],
    },
    {
        files: ["src/**/*.ts"],
        languageOptions: {
            parserOptions: {
                project: ["./tsconfig.json"],
            },
        },
        rules: {
            // The codebase already uses explicit `import type` for type-only imports.
            "@typescript-eslint/consistent-type-imports": [
                "error",
                { prefer: "type-imports", fixStyle: "separate-type-imports" },
            ],
        },
    }
);
