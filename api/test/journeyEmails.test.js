// Regression test for the 2026-07-29 fix to api/src/journeyEmails.js (tick()):
// the per-tenant loop had no INNER try/catch — only one try/catch wrapping the
// whole "load candidates + loop" block. A single SendGrid rejection (bounce,
// invalid owner domain, whatever) thrown from email.send() propagated straight
// out of the for-loop and was caught only by the outer catch, which aborts the
// entire tick. Because the candidate SELECT has no ORDER BY and Postgres
// returns rows in a stable order run-to-run, the SAME tenant threw on every
// hourly tick — so every tenant ordered AFTER it in that stable order never
// got a day2/day7 email again, silently, with one console.error as the only
// signal.
//
// This test drives tick() with three candidate tenants and makes the email
// stub throw on the SECOND call. If the inner try/catch (the fix) is reverted,
// tenant three is never reached and this test fails.
//
// No Postgres/Redis available — db and email are stubbed via require.cache
// before journeyEmails.js is loaded. journeyEmails.js only pulls in './db' and
// './email' (no redis in its require chain), so that's all that needs stubbing.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

function stubModule(relFromSrc, exportsObj) {
  const full = require.resolve(path.join(__dirname, '..', 'src', relFromSrc));
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
}

const TENANTS = [
  { id: 'tenant-1', name: 'Acme Co', created_at: new Date(Date.now() - 3 * 86400000).toISOString() },
  { id: 'tenant-2', name: 'Beta Inc', created_at: new Date(Date.now() - 3 * 86400000).toISOString() },
  { id: 'tenant-3', name: 'Gamma LLC', created_at: new Date(Date.now() - 3 * 86400000).toISOString() },
];

const OWNER_EMAILS = {
  'tenant-1': ['owner1@acme.test'],
  'tenant-2': ['owner2@beta.test'],
  'tenant-3': ['owner3@gamma.test'],
};

// --- db stub: routes on the SQL text, same style as the other stubbed tests
// in this suite. All three candidate tenants come back in one fixed
// (stable) order every time tick() queries for them, mirroring the real
// no-ORDER-BY query's real-world stability that made the original bug
// deterministic per-tenant. ---------------------------------------------
function makeDbStub() {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push({ text, params });
      if (text.includes('INSERT INTO journey_emails')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM journey_emails')) {
        // Nothing has been sent yet in this test — every kind check proceeds.
        return { rows: [] };
      }
      if (text.includes('FROM tenants')) {
        return { rows: TENANTS };
      }
      if (text.includes('FROM tenant_profiles')) {
        // No positioning on file — foundation reads as sparse.
        return { rows: [] };
      }
      if (text.includes('FROM products')) {
        return { rows: [{ n: 0 }] };
      }
      if (text.includes('FROM users')) {
        const tenantId = params[0];
        return { rows: (OWNER_EMAILS[tenantId] || []).map((e) => ({ email: e })) };
      }
      if (text.includes('FROM prospect_research') || text.includes('FROM scheduled_meetings')) {
        return { rows: [{ n: 0 }] };
      }
      return { rows: [] };
    },
  };
}

// --- email stub: throws on the SECOND send() call (tenant-2's), exactly the
// regression scenario. Tracks every `to` that actually got sent to. ------
function makeEmailStub() {
  let calls = 0;
  const sentTo = [];
  return {
    isConfigured: () => true,
    async send({ to }) {
      calls += 1;
      if (calls === 2) {
        throw new Error('550 5.1.1 recipient rejected (simulated SendGrid bounce)');
      }
      sentTo.push(...(Array.isArray(to) ? to : [to]));
      return { ok: true, statusCode: 202 };
    },
    get callCount() { return calls; },
    sentTo,
  };
}

const dbStub = makeDbStub();
const emailStub = makeEmailStub();
stubModule('db', dbStub);
stubModule('email', emailStub);

const journeyEmails = require('../src/journeyEmails');

test('a SendGrid rejection for one tenant does not stop later tenants from being emailed', async () => {
  await journeyEmails.tick();

  assert.strictEqual(emailStub.callCount, 3,
    'tick() must attempt email.send() for all three candidate tenants — if it stops at 2, ' +
    'the per-tenant try/catch was removed and the loop is aborting on the first failure again');

  assert.ok(emailStub.sentTo.includes('owner1@acme.test'),
    'tenant-1 (before the failing tenant) should have been emailed');
  assert.ok(emailStub.sentTo.includes('owner3@gamma.test'),
    'tenant-3 (ordered AFTER the failing tenant-2) must still receive its email — ' +
    'this is the exact regression: without the inner try/catch, tenant-2\'s thrown ' +
    'rejection propagates out of the for-loop and tenant-3 is never reached');

  assert.ok(!emailStub.sentTo.includes('owner2@beta.test'),
    'tenant-2 itself should NOT show up as sent, since its send() call is the one that threw');
});
