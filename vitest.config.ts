import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["tests/unit/**/*.test.ts"],
					environment: "node",
					setupFiles: ["tests/helpers/setup.ts"],
				},
			},
			{
				test: {
					name: "integration",
					include: ["tests/integration/**/*.test.ts"],
					environment: "node",
					setupFiles: ["tests/helpers/setup.ts"],
					pool: "forks",
					poolOptions: { forks: { singleFork: true } },
					testTimeout: 30_000,
				},
			},
			{
				test: {
					name: "e2e",
					include: ["tests/e2e/**/*.test.ts"],
					environment: "node",
					setupFiles: ["tests/helpers/setup.ts"],
					pool: "forks",
					poolOptions: { forks: { singleFork: true } },
					testTimeout: 60_000,
				},
			},
		],
	},
});
