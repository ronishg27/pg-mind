import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        exclude: ["node_modules", "dist", ".git"],
        setupFiles: ["src/test-setup.ts"],
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov", "html"],
            include: ["src/**/*.ts"],
            exclude: [
                "node_modules",
                "dist",
                ".git",
                "**/*.test.ts",
                "**/*.d.ts",
                "src/index.ts",
            ],
        },
    },
});
