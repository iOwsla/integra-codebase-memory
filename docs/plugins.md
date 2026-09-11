# Plugins

`LanguagePlugin` is an injected analyzer with an ID/version, extensions and `analyze(context, files, configs)`. It returns symbols, edges, unresolved references and diagnostics. It must honor the selected context and must not infer structural edges using LLMs. Parser versions participate in invalidation.

`FrameworkPlugin` describes future augmentation. No framework plugin or dynamic third-party plugin loader is exposed yet. Core contains no NestJS, Express, Elysia, Next.js, Prisma, React or Socket.IO inference. TSX syntax support belongs to the TypeScript language plugin, not a React framework plugin.

`EmbeddingProvider` is an optional future interface; no provider is configured or called.
