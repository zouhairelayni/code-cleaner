# Code Cleaner — replacement protocol

## Change contract

Before coding, define:

- **Current behavior:** what exists and why it fails.
- **Desired behavior:** observable acceptance criteria, including error and empty states.
- **Owner:** canonical module/component/route/state location.
- **Consumers:** every known caller, import, route, test, script, native registration, deployed API client.
- **Retirement list:** names, files, flags and branches to disappear.
- **Protected contracts:** user data, security checks, public interfaces, migrations, platform support, deliberate availability failover.

### In-place checklist

1. Confirm baseline tests and relevant behavior; note failures already present.
2. Edit the existing owner. Do not create `*V2*`, `*_new*`, `*-fixed*`, or wrapper files as an intermediate permanent solution.
3. Update all consumers to the same new interface.
4. Remove old implementation, stale exports/imports, flags, registrations, asset references, unused dependencies, and obsolete comments.
5. Check docs and tests; replace outdated tests with equivalent coverage, don't simply delete the last test of the behavior.
6. Search for old names/paths with exact and case-insensitive searches; check dynamic paths separately.
7. Run validation and smoke paths. Fix failures at the owner; do not hide them via an old-code fallback.
8. Review changed files for accidental overengineering. Remove redundant adapters and abstractions introduced during the fix.
9. Summarize evidence for closure and any deliberately preserved compatibility contract.

## When a parallel version is legitimate

Only for a **verified, explicit** need: externally versioned API with existing clients, data migration needing staged cutover, running two live schemas during a bounded rollout, contractual backwards compatibility, or safety-critical operation with a documented recovery path. If truly needed, document **consumer, owner, retirement condition and test**. Do not invent that need from uncertainty.

## No hand-wavy success

- A rename without updating callers is not replacement.
- A new implementation hidden behind a feature flag while the old path stays active is not replacement unless the rollout contract explicitly requires dual paths.
- A green test suite doesn't prove that an untested route is functional.
- A `try/catch` returning fake success is not resilience.
- Removing error handling, offline support, rate limiting, auth checks, or user data to meet “zero fallback” violates the user's goal.
- A large abstraction to eliminate five lines of duplication is often worse than leaving the clear lines alone.

## Example

**Bad:** Add `saveTaskV2`, route new callers there, leave `saveTask`, keep `saveTaskLegacyFallback` and duplicate persistence. Future fixes hit one of three paths.

**Good:** Make `saveTask` correct in its original module, update its callers, remove abandoned extra paths, keep one validation and error flow, and run create/update/offline/error tests. Preserve deliberately required data migration separately if needed.
