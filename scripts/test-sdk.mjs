import { spawnSync } from 'node:child_process';
for (const args of [['cargo','build','--locked','-p','authzflow-native','--bin','authzflow-native-json'], ['pnpm', 'build:sdk'], ['node', '--test', 'packages/core/test/runtime.test.mjs', 'packages/core/test/resource-authority.test.mjs', 'packages/core/test/resource-change-tracker.test.mjs', 'packages/core/test/checked-reader.test.mjs', 'packages/core/test/native-reader.test.mjs', 'packages/core/test/change-consumer.test.mjs', 'packages/core/test/cache.test.mjs', 'packages/core/test/sqlite.test.mjs', 'packages/core/test/sqlite-runtime.test.mjs', 'packages/core/test/content-hash.test.mjs', 'packages/core/test/content-hash-conformance.test.mjs', 'packages/core/test/replica-conformance.test.mjs', 'packages/core/src/replica-eligibility.test.ts']]) {
  const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
