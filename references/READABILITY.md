# Code Cleaner — human-readable code contract

Optimize for the engineer reading the file, not for lowest line count or cleverness.

## Prefer

- Names that reveal behavior: `loadActivityHistory`, not `run`, `process2`, or `smartHandler`.
- Top-to-bottom flow: validate → compute → persist → return/handle error.
- Early returns for invalid states, with real errors, not silent fallback results.
- Cohesive functions that answer one question each; extract helpers when they improve understanding or reuse.
- Plain language and established framework patterns.
- Explicit, stable types and domain objects rather than chains of optional dynamic properties.
- One state owner and one clear function per responsibility.
- Reuse existing simple helpers; eliminate duplicate algorithms when genuinely equivalent.
- Clear tests describing normal, boundary, and failure behavior.

## Avoid

- Multi-level generic factories, policy engines or dependency injection for one fixed use case.
- Chained ternaries, nested callbacks and undocumented magic switches.
- A redundant `utils2`, `v3`, `_final`, or `_old` file.
- `catch { return defaultValue; }` hiding the failure that caused the bug.
- Comments describing syntactic steps; prefer rationale and non-obvious invariants.
- Unused parameters, stale TODOs, compatibility wrappers with no consumer.
- Splitting a short understandable function into six files simply to appear modular.
- Replacing readable domain names with abbreviations or 1-letter symbols.

## Review questions

Can a newcomer find the feature's actual entry point? Can they trace data through the feature without switching between two implementations? Does the error path make sense? Are names and ownership obvious? Did the change introduce more abstractions than it removed? Is there any old implementation that can still run? If so, which real contract justifies it?
