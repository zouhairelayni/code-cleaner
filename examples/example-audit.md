# Example: Code Cleaner audit finding (illustrative, NOT from a real app)

Mode: AUDIT (read-only). Nothing deleted.

| ID | Category | Location | Evidence | Why unnecessary | Impact | Risk | Confidence | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CC-001 | Parallel implementations | `src/services/saveTaskV2.ts:12` | UI now imports `saveTaskV2`, but `saveTask.ts` remains referenced by a background job | Two task-save paths encode the same business rule and can diverge | Medium maintenance savings (estimate); size savings not measured | High: background job might still require old payload | Probable | Trace background job and payload contract. Choose one owner, update caller, add tests, remove old path after verification. |
| CC-002 | Unused UI | `src/components/OldCard.tsx:1` | No static imports found; route registry not yet checked | May be a replaced card | Low maintenance improvement (estimate) | Medium | Needs runtime verification | Inspect route/discovery mechanisms and UI smoke test before deletion. |
| CC-003 | Redundant network calls | `src/screens/Dashboard.tsx:67` | Data fetched by both screen and hook on navigation; captured two identical calls | Duplicate data retrieval with no proven freshness need | Potential network reduction, unmeasured | Medium | Confirmed in one observed flow | Consolidate into existing hook and verify refresh/authorization behavior. |

## Proposed sequence

1. Confirm external/runtime consumers before touching CC-001 or CC-002.
2. Simplify CC-003 using existing hook; measure request counts and run screen tests.
3. Replace the canonical task saver in place; update background job and UI together; remove the redundant implementation and all stale references.
4. Re-run tests, inspect affected screens and background task, then run `gate.mjs --word` for retired symbols.

The audit makes evidence and uncertainty visible. It does not authorize blind deletion or claim measured gains without measurement.
