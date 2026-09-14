# API model providers

Available starting with alpha.30. Update the shared CLI and reconnect MCP first.

CodeMemory can route document/history and conversation memory through a shared
HTTP provider instead of the default Spark/Haiku CLIs. DeepSeek is the first
provider adapter. An explicit OpenAI-compatible profile supports the common
Chat Completions JSON contract; compatibility with every vendor is not implied.
Provider-specific options remain in adapters, not in evidence handling.

Collection, parsing, hashes and diffs remain local. Existing workflow permissions,
exact evidence validation and explicit promotion remain in force. No API profile
or key automatically enables collection or sends a repository to a model.

## Configure once, select per project

Run these with the installed `codememory` command. For source development, use
`bun apps/cli/src/index.ts` from its checkout.
On Windows the installed command is `codememory.cmd`.

```text
codememory providers add deepseek --daily-usd 1 --daily-requests 100 --yes
codememory providers login deepseek
codememory providers test deepseek --yes
```

Login reads a hidden key from the terminal, never a command-line argument.
The synthetic test makes one paid request with no project source. It validates
connectivity and JSON protocol behavior, not real-project extraction quality.

From the selected registered project's directory:

```text
codememory providers use deepseek --workflow history --yes
codememory history configure --documents --git --providers --yes
codememory history scan --all
codememory providers status
```

Scanning collects evidence. Use the existing history submit/worker/review flow
(or its MCP equivalents) to interpret selected evidence; scans do not automatically
submit every document. `--workflow both` selects the same profile for conversation
memory too; its existing `memory configure --enable --yes` opt-in remains separate.
Do not enter keys in chat, AGENTS.md, CLAUDE.md or MCP configuration.

Profiles persist outside repositories and versioned installations. Selecting a
profile is explicit per canonical project and workflow. Queued jobs use the
selection when their extraction starts; an extraction/verification pair keeps the
same provider. Existing correction passes remain bounded by workflow policy and
count toward API usage. Changing selection does not rewrite approved memories.

```text
codememory providers use cli --workflow both --yes
codememory providers logout deepseek
```

`use cli` explicitly restores CLI routing. Logout removes the stored key; it does
not silently select a different provider. Existing in-flight HTTP requests may
finish after selection or credential changes.

## Credentials

Bun's native Secrets API uses macOS Keychain, Windows Credential Manager or Linux
libsecret. Linux needs an available secret service. CodeMemory fails with a fixed
credential diagnostic if the store cannot be used; there is no plaintext fallback.
An alternative for headless environments is an explicitly named environment variable:

```text
codememory providers add server --env DEEPSEEK_API_KEY --yes
```

Provide that variable through the host's secret-management environment. CodeMemory
never persists its value. It must be available to the actual CLI/MCP process.
Keys are retrieved only for requests, excluded from provider state and job telemetry,
and never returned through MCP. `logout` applies only to OS-managed credentials.

## Budgets and request behavior

Default limits are 100 attempts per profile per UTC day, an estimated $1 daily
allowance, 65,536 input bytes including instructions/schema, 2,048 output tokens,
a 120-second timeout and 2 MiB response body. The same profile shares its allowance
across projects and local processes. State is persisted before dispatch using an
exclusive lock and atomic replacement. A crash lock is not automatically stolen;
inspect running operations before removing a stale state.lock directory.

Before each call, input bytes and maximum output tokens reserve estimated cost.
Reported usage replaces that reservation. Missing usage, network failures or
process termination retain the conservative reservation. Usage counters include
failed attempts. `providers status` reports uncertain requests and estimates.
This is a local guardrail, not a guaranteed provider billing ceiling: tokenization,
price changes, other applications, machines and separately created profiles can
change actual account spend. Check the provider dashboard as the billing authority.

The initial DeepSeek rates use $0.30 input and $1.20 output per million tokens,
without assuming cache/off-peak discounts. Profiles are immutable: to change rates,
limits, model or destination, create a new profile and explicitly reselect it.
HTTP errors are classified without raw response bodies. There are no transport
retries, cross-provider fallback, redirects or model tool execution.

DeepSeek disables thinking for this bounded extraction workload. Extraction and
verification are separate calls to the same configured model; this does not provide
independent-model agreement. Model identity is provider-reported, not independently
verified. Human approval and server evidence checks remain necessary.

## Other compatible APIs

```text
codememory providers add alternative --provider openai-compatible --base-url https://api.example.com/v1 --model MODEL_ID --input-rate 0.30 --output-rate 1.20 --yes
```

This is a template, not a tested provider. Explicit HTTPS endpoints must accept
`messages`, `max_tokens`, `response_format: {type: json_object}` and non-streaming
Chat Completions responses. Providers needing a different schema/thinking or
response format require an adapter and regression tests. Never substitute a new
endpoint automatically or send a credential intended for another provider.

## Verification

Controlled HTTP tests cover provider routing, exact schema handling, truncation,
missing credentials, shared persistent allowances, classified HTTP failures and
no fallback. Database integration tests exercise both history and conversation
candidate workflows with synthetic HTTP responses, including explicit approval.
Real CLI tests cover setup without PostgreSQL and selection by current directory.
These tests do not establish live DeepSeek quality or native credential-store
availability on every operating system. Run the synthetic test after supplying a
key, then evaluate approved sample evidence before enabling routine processing.

Sources: [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/),
[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/),
[Bun Secrets](https://bun.sh/docs/runtime/secrets).
