import pleaseai from '@pleaseai/eslint-config'

export default [
  ...(await pleaseai({
    ignores: [
      'node_modules/**',
      'dist/**',
      'bun.lock',
      'LICENSE',
      // Workspace state and external configs (not authored by this plugin)
      '.please/**',
      '.claude/**',
      '.context/**',
      // Root project documentation (scaffold track is constrained from rewriting these;
      // separate tracks own these files)
      'ARCHITECTURE.md',
      'CLAUDE.md',
      'README.md',
    ],
  })),
  // Library Layer invariant (NFR-1, AC-6 from build-file-detect-20260428):
  // Files under scripts/lib/ must be I/O-free pure functions. Test files are
  // exempt — they read fixtures from disk by design.
  {
    files: ['scripts/lib/**/*.ts'],
    ignores: ['scripts/lib/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'Library Layer is I/O-free — move filesystem access to scripts/detect.ts (orchestrator).' },
            { name: 'fs/promises', message: 'Library Layer is I/O-free — move filesystem access to scripts/detect.ts (orchestrator).' },
            { name: 'node:fs', message: 'Library Layer is I/O-free — move filesystem access to scripts/detect.ts (orchestrator).' },
            { name: 'node:fs/promises', message: 'Library Layer is I/O-free — move filesystem access to scripts/detect.ts (orchestrator).' },
            { name: 'node:net', message: 'Library Layer has no network access.' },
            { name: 'node:http', message: 'Library Layer has no network access.' },
            { name: 'node:https', message: 'Library Layer has no network access.' },
            { name: 'bun', message: 'Library Layer must be runtime-agnostic — avoid importing the bun namespace.' },
          ],
          patterns: [
            { group: ['node:fs/*'], message: 'Library Layer is I/O-free — move filesystem access to scripts/detect.ts (orchestrator).' },
          ],
        },
      ],
    },
  },
]
