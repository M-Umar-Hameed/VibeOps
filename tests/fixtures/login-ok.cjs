// Preloaded via NODE_OPTIONS by relay-accounts-api.test.ts: a logged-in `codex login status`.
process.stdout.write(`ok ${process.env.CODEX_HOME ?? ""}\n`);
process.exit(process.env.CODEX_HOME ? 0 : 3);
