import pleaseai from '@pleaseai/eslint-config'

export default pleaseai({
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
})
