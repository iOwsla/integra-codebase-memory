# Parser performance investigation

## Scope and evidence

The local host has 8 GiB of physical memory. The private full-project scan selected
4,266 source files (45,588,516 bytes). Its scanner/workspace/declaration profile
completed workspace preparation in about 0.81 seconds and declarations in about
16 seconds. Subsequent time accumulated across per-file semantic processing,
rather than one permanently stalled file. A 150-second diagnostic was deliberately
stopped; it was not a completed index.

For CPU attribution, the same scanner/compiler code was bundled and run under
Node 24.11.1's V8 profiler, stopping after 1,000 semantic files. The profile sampled
62.48 seconds including setup, with 11.85 seconds in garbage collection. Parser
symbol creation, AST classification, declaration lookup and path operations were
also visible costs. These are **Node profiling observations**, not Bun CPU
percentages or a complete-project throughput measurement. Bun 1.3.3's CPU-profile
export did not complete in this local investigation, including a small control
program; those diagnostic processes were terminated.

The host also showed active memory pressure: one five-second system-wide sample
recorded roughly 80 MiB of swap-in, 104 MiB of swap-out and more than 6 GiB each of
compression/decompression activity. These counters include all applications and
do not attribute all pressure to the parser. They make uncontrolled wall-time
comparisons unsuitable for a speedup claim.

## Changes and correctness checks

- Declaration lookup uses one table per canonical file, indexed by numeric source
  position, instead of constructing repeated combined path/position strings.
- AST nodes that cannot declare a supported symbol skip declaration-specific text
  extraction and classification checks.
- Symbol text is extracted once per declaration. Relationship line numbers are
  calculated when needed, and unresolved expressions read only their bounded span.
- Edge deduplication preserves the previous last-value/first-insertion behavior
  without allocating an intermediate array of key/value pairs for every edge.
- Optional phase profiling makes future investigations reproducible; see
  `hardening.md` for the command and its explicit partial-analysis behavior.

For the 943-file private application scope, the original and optimized lookup
implementations produced identical sorted record fingerprints for all 110,256
symbols, 261,190 edges, 46,155 unresolved records and zero diagnostics. This checks
record contents, not just counts. The first original run took 42.14 seconds of
parser time and the optimized run 64.89 seconds under varying host pressure;
a repeated original run took 105.41 seconds and again matched every fingerprint.
This original/optimized/original sequence (42.14 / 64.89 / 105.41 seconds) shows
substantial host variability and establishes no end-to-end speedup. Raw source paths, CPU profiles
and graph records are kept outside the public repository.

## Open acceptance gate

A low-memory Bun diagnostic of the full project still exceeded 300 seconds.
A separate bounded-heap Node experiment was stopped without a complete graph.
Neither runtime change is enabled by this release. Full-project worker acceptance,
large-graph publication, peak-memory control and sustained load remain Phase 9
work. Reducing transient allocations is not proof that these gates are closed.

The final normal isolated-worker check on this host still hit the default
120-second deadline (120.46 seconds including termination) for all 4,266 inputs.
No complete graph was returned or published. This confirms that the default
full-project acceptance gate remains open after these changes.
