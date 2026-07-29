# Code review — severity classification

*Read when: reviewing code, triaging review findings, or deciding whether something
blocks a merge.*

Every finding gets exactly one of four severities. The severity determines whether it
blocks, not how annoying it is. When a finding could sit in two tiers, classify by
**worst realistic production outcome**, not by how hard it is to fix.

| Severity | Blocker? | Focus area | Typical finding |
| --- | --- | --- | --- |
| **Critical** | **Yes** | Security, data loss, system crashing | SQL injection, hardcoded API secrets, data corruption |
| **High** | **Yes** | Core logic, performance, memory leaks | Unbounded queries, broken payments, unhandled null pointers |
| **Medium** | Conditional | Testing, error handling, maintainability | Swallowed exceptions, missing unit tests, duplicate code |
| **Low** | No | Readability, style, naming, typos | Ambiguous variable names, formatting, dead comments |

## 1. Critical

Security vulnerabilities, data loss or corruption, and anything that takes the system
down. **Fix before merge — no exceptions, no deferral ticket.**

```js
// ❌ CRITICAL: user input concatenated into SQL
const rows = await db.query(`SELECT * FROM users WHERE email = '${email}'`);
```

In this codebase the Critical surface is concentrated in: anything bypassing
`tenant_id` scoping (cross-tenant data exposure — ADR-0001), auth/session handling,
secrets reaching logs or git, and the Stripe webhook signature check.

## 2. High

Core logic that is wrong, performance characteristics that fail under real load, and
memory leaks. Works in dev, breaks in production. **Fix before merge.**

```js
// ❌ HIGH: unbounded read — fine with 5 test rows, OOMs the process on a heavy tenant
const logs = await db.query('SELECT * FROM activity_logs WHERE user_id = $1', [userId]);
return logs.map(log => formatLog(log));
```

Why it's High: works fine in staging with 5 test records, but as soon as a heavy user
logs in on production, node memory spikes to 100% and the process dies (OOM).

## 3. Medium

Suboptimal implementation, missing unit/integration coverage, minor logic gaps,
unhandled low-probability edge cases, or violations of core architectural patterns.
Raises technical debt or causes subtle edge-case failures that don't break the primary
user flow. **Should be fixed before merging; deferrable only with a tracking ticket.**

```js
// ❌ MEDIUM: catches without logging or rethrowing
async function fetchExchangeRate(currency) {
  try {
    const response = await api.get(`/rates/${currency}`);
    return response.data.rate;
  } catch (error) {
    return null;   // callers crash later with a cryptic TypeError
  }
}
```

Why it's Medium: returning `null` without throwing or supplying a fallback pushes the
failure downstream, where it surfaces as `cannot read property 'rate' of null` far from
the actual cause.

## 4. Low

Style and formatting, minor code smells, typos in comments or names, non-optimal
naming, small readability refactors. No runtime impact. **Never blocks a merge**;
fix when convenient.

```python
# ❌ LOW: ambiguous name, redundant comparison
def check_status(x):
    if x.is_active == True:
        return "active"
    return "inactive"
```

Why it's Low: it works. `x` should be `user`/`account` and `if x.is_active:` is
cleaner — readability only.

## Reporting

State severity, `file:line`, the defect in one sentence, the concrete failure it
produces, and the fix. A finding without a plausible failure path is not a finding —
say so rather than padding the list. Note explicitly when something looks wrong but is
a deliberate decision recorded in `docs/adr/` or this repo's rule modules.
