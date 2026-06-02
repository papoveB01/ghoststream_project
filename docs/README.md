# GhostStream — docs/

Engineering documentation. Lives next to the code so it moves with the
codebase, not on a wiki nobody updates.

## Layout

- `adr/` — Architecture Decision Records. One file per decision; small,
  numbered, immutable once `Accepted`. New decisions that supersede an
  earlier ADR get a fresh number and explicitly link back ("Supersedes
  ADR-NNNN").
- (future) `runbooks/` — on-call playbooks (Recall.ai outage, R2 quota,
  pgvector index rebuild, etc.). Add as we operate.
- (future) `diagrams/` — Mermaid or PNG topology / sequence diagrams
  referenced from ADRs.

## When to write an ADR

Write one when you're making a choice that:

- Touches more than one module (storage layout, retrieval contract, auth
  shape, queue topology, …).
- Has at least two plausible alternatives and you want to remember why you
  ruled them out.
- A future engineer (or you in six months) would otherwise have to reverse-
  engineer from the code.

If the decision is contained to a single function, a comment is enough.
