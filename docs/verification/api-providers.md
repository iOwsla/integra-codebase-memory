# API provider verification

Date: 2026-09-14. Local development changes based on published alpha.29.
No provider release or live account configuration was performed by this work.

## Recorded checks

- Full regression suite: 221 tests across 41 files passed in 86.87 seconds.
- After correcting workflow status model labels: 25 focused tests across four files passed.
- Three additional budget/concurrency/response-limit cases were then added; all 16 HTTP-provider unit tests passed.
- Lint, typecheck, build and whitespace checks passed.
- The CLI setup/routing smoke runs in a temporary directory without PostgreSQL.
- History and conversation integration uses a disposable PostgreSQL database and controlled HTTP responses. Real evidence validation and explicit approval remain in the application path.

The configured API transport is tested for DeepSeek request shape, generic compatible
request shape, project/workflow isolation, immutable profiles, missing credentials,
HTTP error redaction, input/output limits, incomplete JSON, cancellation before
dispatch, persisted request/dollar allowances and competing reservations.
Failed or unaccounted requests retain an estimated reservation; tests do not claim
that local cost estimates match the external invoice exactly.

## Not yet verified

No real API credential was provided, no paid DeepSeek request was made and no
source was sent to a model provider. Consequently, live model quality, real billing,
provider availability, and cross-platform native credential-store behavior are not
certified. OS key storage uses Bun's native secret API with no plaintext fallback.
Windows/macOS CI is configured to exercise HTTP-unit and CLI-routing tests on the
next workflow run; those remote runs have not been executed for this local change.

[Setup and operating limits](../api-providers.md)

## Bounded dead-code and CLI review

The graph recorded no references to the legacy internal `changedRange` export.
A source search across application, package, script and test files confirmed only
its declaration; the history package entrypoint did not expose it. The obsolete
helper was removed; active history diffing uses the existing bounded diff module.
Graph references and source inspection confirmed configured providers are used by
both history and conversation services. This is not a whole-repository dead-code
certification; dynamic entrypoints and external consumers require separate review.

Typecheck now enforces noUnusedLocals and noUnusedParameters across the existing
TypeScript project. Exported/dynamic dead code still requires evidence review.
The cleanup passed 27 focused history/provider tests. Compact help passed six
CLI integration tests, including full-help discovery, explicit maintenance help,
provider routing and existing memory/history workflows. Lint, typecheck and build
also passed. Default root help now shows nine everyday commands; full help retains
all 26. Default history help shows five commands; all 15 remain callable.

## Alpha.30 release preparation

The final versioned tree passed frozen dependency installation, lint, typecheck,
all 226 tests across 42 files (84.35 seconds), build and macOS upgrade verification.
All 15 manifests match alpha.30. GitHub Actions for the tagged commit records
the platform and publication results; local checks do not predeclare them.
No paid provider call was made.
