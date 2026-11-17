---
type: llm
focus: trace
weight: 1
---

The report identifies packages/core/src/deadA.ts and deadB.ts as a mutually-importing dead pair, and chain/top.ts with chain/leaf.ts as dead, rather than treating them as in use just because they have importers.
