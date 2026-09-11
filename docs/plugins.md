# Plugins

`LanguagePlugin` is an injected analyzer with an ID/version, extensions and `analyze(context, files, configs)`. It returns symbols, edges, unresolved references and diagnostics. It must honor the selected context and must not infer structural edges using LLMs. Parser versions participate in invalidation. An optional `configurationReferences` hook proposes metadata paths to the scanner, which may read only previously discovered, eligible in-scope JSON files. The hook cannot expand traversal scope.

`FrameworkPlugin` describes future augmentation. No framework plugin or dynamic third-party plugin loader is exposed yet. Core contains no NestJS, Express, Elysia, Next.js, React or Socket.IO inference. TSX syntax support belongs to the TypeScript language plugin, not a React framework plugin.

`EmbeddingProvider` is an optional future interface; no provider is configured or called.

Prisma schema parsing and delegate provenance are integrated with the TypeScript analyzer. See [Prisma coverage](prisma.md). The scanner adds `.prisma`; the compiler workspace receives only JS/TS sources.
