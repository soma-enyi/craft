import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    esbuild: {
        // Skip tsconfig extends resolution issues in the monorepo
        tsconfigRaw: {
            compilerOptions: {
                target: 'ES2020',
                module: 'ESNext',
                moduleResolution: 'bundler',
                resolveJsonModule: true,
                allowJs: true,
                strict: true,
                esModuleInterop: true,
                skipLibCheck: true,
                jsx: 'preserve',
                paths: {
                    '@/*': ['./apps/frontend/src/*'],
                    '@craft/types': ['./packages/types/src'],
                },
            },
        },
    },
    resolve: {
        alias: {
            '@': resolve(__dirname, 'apps/frontend/src'),
            '@craft/types': resolve(__dirname, 'packages/types/src'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        env: {
            ARTIFACT_SIGNING_SECRET: 'test-artifact-signing-secret-32b!!',
        },
        // Shard safety: tests must not share mutable module-level state.
        // Each worker receives an isolated module graph, so top-level vi.mock()
        // and beforeEach resets are sufficient. Do not use global singletons
        // that persist across describe blocks without a beforeEach reset.
        //
        // Sharding is configured via CLI:  --shard=<index>/<total>
        // Example (4 shards):
        //   vitest run --shard=1/4
        //   vitest run --shard=2/4
        //   vitest run --shard=3/4
        //   vitest run --shard=4/4
        //
        // The CI matrix in .github/workflows/test-sharding.yml orchestrates
        // these in parallel. Shard count is set to 4 — balancing worker
        // spin-up cost against suite size. Revisit when the suite grows past
        // ~30 s per shard.
        sequence: {
            // Deterministic file order within each shard prevents flaky results
            // caused by import-order side effects when only a slice is executed.
            shuffle: false,
        },
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
        },
    },
});
