# Architecture Decision Records

We use a lightweight ADR format (Michael Nygard style). Each record is one
markdown file, named `NNNN-short-slug.md` where `NNNN` is a zero-padded,
monotonically increasing number.

## Index

| #    | Title                                                  | Status   |
| ---- | ------------------------------------------------------ | -------- |
| 0001 | [Multi-tenant knowledge isolation](./0001-multi-tenant-knowledge-isolation.md) | Proposed |
| 0002 | [Direct Microsoft Graph integration](./0002-microsoft-graph-direct.md) | Amended |
| 0003 | [Subscription feature packaging](./0003-subscription-feature-packaging.md) | Accepted |
| 0004 | [Seat-scaled pricing & cost model](./0004-seat-based-pricing-cost-model.md) | Proposed |

## Template

Copy `0001-multi-tenant-knowledge-isolation.md` as a starting point and
strip it back to the section headings. The required sections are:

1. **Status** — Proposed / Accepted / Superseded by NNNN.
2. **Context** — what is true today; why are we deciding now.
3. **Decision drivers** — the constraints the choice has to satisfy.
4. **Alternatives considered** — at least three for any non-trivial call,
   each with a one-line pro and a one-line con.
5. **Decision** — the chosen option and the reasoning that selected it.
6. **Consequences** — what this makes easy, what it makes hard, what we
   accept as residual risk.
7. **Builder hand-off** — concrete files / modules / migrations the
   follow-on PRs will touch. This is the bridge from "we decided" to
   "someone is going to implement it".

Optional, but encouraged when relevant:

- **Threat model** — for security-affecting decisions.
- **Migration plan** — when the decision changes existing data shape.
- **Open questions** — things we punted and need to revisit.

## Workflow

1. Open a PR with `Status: Proposed`.
2. Iterate in review comments. Once the team agrees, flip to `Accepted`
   in the same or a follow-up PR.
3. Don't edit an `Accepted` ADR substantively — write a new one that
   supersedes it. Typo fixes and clarifications are fine.
