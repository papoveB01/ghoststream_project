// Provider-aware task router + the Anthropic wrapper's guard rails (ADR-0006 §4.5).
//
// This is the switch the whole migration turns on: one env var moves one task
// to Claude. The properties that matter are therefore (a) the default is
// unchanged Gemini behaviour, (b) the env var names the router reads are the
// ones an operator would actually set, and (c) an operator typo degrades to the
// provider we were already on rather than taking the api down on boot.
//
// Timing note: models.js snapshots the TIER DEFAULTS at require time and reads
// the provider + per-task override vars at CALL time. So withEnv works for
// AI_PROVIDER*/`*_MODEL` overrides but would silently do nothing for
// ANTHROPIC_MODEL_FLASH and friends — don't add a test that assumes otherwise.
//
// withEnv is synchronous-only: it restores right after the callback returns, so
// an async callback would restore mid-flight. Every use below is synchronous
// except one, which is marked.

'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src');
const models = require(path.join(SRC, 'models.js'));

// The set as models.js actually ships it, captured before any test mutates it.
// Tests below temporarily add tasks to the real Set — there is no seam for a
// fake one — so anything asserting on its CONTENTS has to compare against this,
// or against a set that has been restored to it.
const SHIPPED_DISPATCH_READY = new Set(models.DISPATCH_READY);
// Same reasoning for the flip gate: helpers below lift entries out of it.
const SHIPPED_FLIP_BLOCKED = new Set(models.FLIP_BLOCKED.keys());

// ANTHROPIC_API_KEY defaults to a placeholder, and a caller that names it wins.
//
// The router fails CLOSED on an unconfigured provider (models.js), so every
// "this task moves to anthropic" assertion below silently became "it stayed on
// gemini" wherever no key is present. The dev container has one via compose
// `env_file`; CI does not — ci.yml sets only REDIS_HOST / JWT_SECRET /
// ENCRYPTION_KEY / NODE_ENV — which is precisely the local-green / CI-red split
// this file produced. Spreading `vars` LAST is what keeps the two tests that
// pass `ANTHROPIC_API_KEY: undefined` deliberately (the missing-key wrapper
// error, and isConfigured) doing exactly what they say.
function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY: 'sk-ant-test', ...vars })) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ── defaults: nothing changes until told ────────────────────────────────────

test('every task defaults to gemini', () => {
  withEnv({ AI_PROVIDER: undefined }, () => {
    for (const task of Object.keys(models.TASKS)) {
      assert.strictEqual(models.resolve(task).provider, 'gemini', `${task} should default to gemini`);
    }
  });
});

test('modelFor still returns a bare model id for the ~20 existing call sites', () => {
  const m = models.modelFor('discovery');
  assert.strictEqual(typeof m, 'string');
  assert.match(m, /^gemini-/);
  assert.strictEqual(m, models.resolve('discovery').model);
});

// ── the switch ──────────────────────────────────────────────────────────────

// A task can only actually move once its call site can dispatch. Until then the
// router must refuse to hand a Claude model id to the Gemini SDK — on
// `relevance` that would fail OPEN and silently skip the competitor quarantine
// for every tenant.
// Also carries the key, for the same fail-closed reason as withEnv: a future
// test that makes a task dispatch-ready without going through withEnv would
// otherwise assert Gemini behaviour while claiming to test Claude's. An inner
// withEnv that names ANTHROPIC_API_KEY still wins, and restores to this value.
function asDispatchReady(task, fn) {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const wasReady = models.DISPATCH_READY.has(task);
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  models.DISPATCH_READY.add(task);
  try { return fn(); } finally {
    if (!wasReady) models.DISPATCH_READY.delete(task);
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  }
}

// Lift a FLIP_BLOCKED entry for the duration of a test.
//
// Needed because two facts now gate a flip and most tests below are about only
// one of them. A tiering assertion ("battlecard is FLASH on claude") is about
// the TIER TABLE; it must not silently become an assertion about the block, and
// it must not be deleted because the block exists. Restores the reason string,
// not just membership, so a test cannot quietly rewrite why a key is blocked.
function asFlipUnblocked(task, fn) {
  const had = models.FLIP_BLOCKED.has(task);
  const reason = models.FLIP_BLOCKED.get(task);
  models.FLIP_BLOCKED.delete(task);
  try { return fn(); } finally { if (had) models.FLIP_BLOCKED.set(task, reason); }
}

test('a task that cannot dispatch yet stays on gemini and says so', () => {
  // `discovery`, not `relevance`: group 1 migrated relevance/preview/companyBrief
  // and they are dispatch-ready now (ADR-0006 §9 item 5). This test is about the
  // UNMIGRATED case, so it has to name a task that is genuinely still unmigrated
  // — otherwise it would keep passing for the wrong reason as the migration
  // proceeds, and stop testing anything on the last cutover.
  assert.ok(!models.DISPATCH_READY.has('discovery'),
    'pick another unmigrated task — this one has been cut over');
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    withEnv({ AI_PROVIDER_DISCOVERY: 'anthropic' }, () => {
      assert.strictEqual(models.resolve('discovery').provider, 'gemini',
        'that call site does not read resolve().provider yet — honouring this would 404 every call');
      assert.match(models.resolve('discovery').model, /^gemini-/);
    });
  } finally { console.warn = realWarn; }
  assert.ok(warnings.some((w) => w.includes('cannot dispatch yet')),
    'a silent no-op would leave the operator thinking the flip landed');
});

test('a per-task override moves exactly one dispatch-ready task', () => {
  asDispatchReady('relevance', () => {
    withEnv({ AI_PROVIDER_RELEVANCE: 'anthropic' }, () => {
      assert.strictEqual(models.resolve('relevance').provider, 'anthropic');
      assert.strictEqual(models.resolve('relevance').model, 'claude-haiku-4-5');
      // Its neighbours must not move with it — that is the whole point.
      assert.strictEqual(models.resolve('discovery').provider, 'gemini');
      assert.strictEqual(models.resolve('preview').provider, 'gemini');
    });
  });
});

test('a per-task override beats the global default in both directions', () => {
  asDispatchReady('research', () => {
    withEnv({ AI_PROVIDER: 'anthropic', AI_PROVIDER_DISCOVERY: 'gemini' }, () => {
      assert.strictEqual(models.resolve('research').provider, 'anthropic');
      assert.strictEqual(models.resolve('discovery').provider, 'gemini',
        'a task must be able to stay behind, not just move ahead');
    });
  });
});

test('the env var names the router reads are the ones compose passes', () => {
  // A mismatch here is silent: the operator sets a variable and nothing happens.
  const cases = {
    marketWatch: 'AI_PROVIDER_MARKET_WATCH',
    callAnalysis: 'AI_PROVIDER_CALL_ANALYSIS',
    callEntities: 'AI_PROVIDER_CALL_ENTITIES',
    companyBrief: 'AI_PROVIDER_COMPANY_BRIEF',
    relevance: 'AI_PROVIDER_RELEVANCE',
  };
  for (const [task, envName] of Object.entries(cases)) {
    asDispatchReady(task, () => {
      withEnv({ [envName]: 'anthropic' }, () => {
        assert.strictEqual(models.resolve(task).provider, 'anthropic',
          `${task} should be switchable via ${envName}`);
      });
    });
  }
});

test('an unknown provider falls back to gemini instead of failing boot, and warns ONCE', () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    withEnv({ AI_PROVIDER: 'antropic' }, () => {   // deliberate typo
      // Twenty resolves, because that is what this path now looks like. Before
      // ADR-0006 §9 item 4 these three tasks resolved their model ONCE at
      // require time, so a raw console.warn printed one line per process;
      // resolving per call put it on the hot path, and `relevance` alone runs
      // twice per ingested document. A typo'd env var must not become a log
      // flood — the two branches below it in models.js already use warnOnce for
      // exactly this reason, and this one had been left behind.
      for (let i = 0; i < 20; i++) assert.strictEqual(models.resolve('discovery').provider, 'gemini');
    });
  } finally { console.warn = realWarn; }
  const typos = warnings.filter((w) => w.includes('antropic'));
  assert.strictEqual(typos.length, 1,
    `a silent fallback hides the typo, and one line per call buries it — got ${typos.length} lines`);
});

// ── tiering ─────────────────────────────────────────────────────────────────

test('claude tiers follow ADR-0006 §4.1', () => {
  // Snapshot and restore, never clear(). DISPATCH_READY is a LIVE EXPORTED SET
  // — clear() wiped relevance/preview/companyBrief out of the module for every
  // test that ran after this one in the same process, so the group-1 defaults
  // test below would have been asserting an empty set's behaviour. It passed
  // only because it happens to run earlier.
  const snapshot = [...models.DISPATCH_READY];
  for (const k of Object.keys(models.TASKS)) models.DISPATCH_READY.add(k);
  try {
  withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('callAnalysis').model, 'claude-opus-5', 'pro tier');
    assert.strictEqual(models.resolve('proposal').model, 'claude-opus-5');
    assert.strictEqual(models.resolve('discovery').model, 'claude-sonnet-5', 'flash tier');
    assert.strictEqual(models.resolve('content').model, 'claude-sonnet-5', 'content tier');
    assert.strictEqual(models.resolve('relevance').model, 'claude-haiku-4-5', 'lite tier');
  });
  // RESTORE, not clear. `clear()` left the module's real set empty for every
  // test that ran after this one, so an assertion about what ships in
  // DISPATCH_READY passed no matter what models.js said — which is also how the
  // battlecard non-goal further down was briefly unfalsifiable.
  } finally {
    models.DISPATCH_READY.clear();
    for (const k of snapshot) models.DISPATCH_READY.add(k);
  }
});

test('the shipped set survives the only test that rewrites the whole set', () => {
  // Placed immediately after that test on purpose: it is the tripwire for a
  // helper that mutates the exported Set without restoring it. `clear()` in the
  // tiering test above used to make this fail.
  //
  // It is also the forcing function for the PROSE. Pinning the exact contents
  // means no cutover PR can change the set without opening this file, so the
  // failure message is where the list of comments that go stale WITH the set
  // lives — that is the only thing here that would have caught #52's four
  // expired premises before #54 went looking for them. Anchors, not line
  // numbers, since those go stale the same way. aiCall.test.js pins the same
  // contents and deliberately does not repeat this list: one copy, so the
  // reminder cannot drift the way its subject did.
  assert.deepStrictEqual([...models.DISPATCH_READY].sort(),
    ['assessment', 'battlecard', 'companyBrief', 'keypoints', 'preview', 'relevance'],
    'changing this set also invalidates prose that asserts what is in it: ' +
    'anthropic.js (header), aiCall.js (header), gemini.js (assertGeminiModel), ' +
    'aiContext.js ("It does not flip any task"), test/live/contextSeam.js ' +
    '(prepareVia) and .env.example\'s "Provider ' +
    'routing" section — SIX, and .env.example is the one an OPERATOR reads, the ' +
    'one no code review naturally opens, and the one already listed as a P1 fix in ' +
    "group 1's review round (e69eb88) that drifted again anyway. PR #54 existed " +
    'because #52 changed the set and left the code-side four stale.');
});

// ── the flip gate (FLIP_BLOCKED) ────────────────────────────────────────────
//
// A SECOND gate, deliberately not folded into DISPATCH_READY. That set is a
// claim about the code — "this call site reads resolve().provider and branches"
// — verifiable by reading the file and pinned above. This one is a claim about a
// MEASUREMENT against a live provider, which can stop being true with no code
// change at all. Merging them would make membership mean two things and leave
// neither statable.

test('a migrated but BLOCKED task refuses the flip instead of merely warning', () => {
  // The distinction that matters: an operator who follows the runbook sets the
  // variable and moves on. A warning they never read is not a gate, so the
  // router has to actually not do it.
  assert.ok(models.DISPATCH_READY.has('battlecard'),
    'this test is about a task whose call site IS migrated — otherwise it is just the ' +
    'dispatch-readiness test again, and would keep passing for the wrong reason');
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    withEnv({ AI_PROVIDER_BATTLECARD: 'anthropic' }, () => {
      assert.strictEqual(models.resolve('battlecard').provider, 'gemini',
        '2 of 80 live responses at this call site were unparseable, on the one call site with no retry');
      assert.match(models.resolve('battlecard').model, /^gemini-/,
        'and the model must match the provider it fell back to');
    });
  } finally { console.warn = realWarn; }
  const line = warnings.find((w) => w.includes('battlecard'));
  assert.ok(line, 'a silent refusal is worse than the flip — the operator would think it landed');
  assert.match(line, /BLOCKED/);
  // The measurement, not just the verdict — a bare "blocked" gets argued with.
  // Re-pointed from /3 of 10/ in round 3: that figure was three probes pooled
  // against a 302-char synthetic prompt and did not reproduce. This assertion is
  // the reason the number cannot be corrected in a comment and forgotten in the
  // operator-facing string, so it is deliberately literal.
  assert.match(line, /2 of 80/, 'carry the measurement, not just the verdict');
  assert.ok(!/migrate the call site/.test(line),
    'that is the OTHER gate\'s advice and is wrong here: this call site is migrated, so ' +
    'following it would send someone to re-do work that is already done');
});

test('both blocked keys are blocked, and each carries a reason', () => {
  // keypoints is the one nothing else in this file would catch: its call sites
  // are migrated, its schemas pass the smoke check, and the defect is an output
  // BUDGET that truncates on Sonnet — where a truncated answer deletes the
  // stored analysis rather than erroring.
  assert.deepStrictEqual([...models.FLIP_BLOCKED.keys()].sort(), ['battlecard', 'keypoints']);
  for (const [task, reason] of models.FLIP_BLOCKED) {
    assert.ok(models.DISPATCH_READY.has(task),
      `${task} is blocked from flipping but not migrated — that is DISPATCH_READY's job, not this set's`);
    assert.ok(reason && reason.length > 40, `${task} needs a reason an operator can act on`);
    assert.match(reason, /ADR-0006/, `${task}'s reason must name where the measurement lives`);
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (m) => warnings.push(String(m));
    try {
      withEnv({ [models.providerEnvName(task)]: 'anthropic' }, () => {
        assert.strictEqual(models.resolve(task).provider, 'gemini', task);
      });
    } finally { console.warn = realWarn; }
  }
});

test('blocking is per key — an unblocked sibling still flips', () => {
  // Otherwise the gate would be indistinguishable from "group 2 cannot flip",
  // which is not what was measured: `assessment` is migrated, unblocked, and its
  // schema came back 0/10 malformed.
  assert.ok(!models.FLIP_BLOCKED.has('assessment'));
  withEnv({ AI_PROVIDER_ASSESSMENT: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('assessment').provider, 'anthropic');
    assert.strictEqual(models.resolve('assessment').model, 'claude-haiku-4-5');
  });
});

test('the flip gate is SILENT on the default path', () => {
  // A gate that changes behaviour for anyone who has NOT asked to flip is a
  // regression on 100% of traffic — and the resolved provider cannot detect it,
  // which is the trap. Dropping the `p !== DEFAULT_PROVIDER` guard makes the
  // branch fire on every ordinary gemini resolve and STILL RETURN gemini,
  // because that is what fallbackToDefault returns. The only observable is the
  // log line.
  //
  // IN A FRESH PROCESS, and that part is not incidental. warnOnce dedupes on
  // task+provider for the life of the process, and the very first test in this
  // file resolves every task on the gemini path — so in-process the mutant's
  // extra warning is emitted long before this test runs and asserting on
  // console.warn here sees silence either way. Measured: the in-process version
  // of this test passed against the mutation it was written for. A guard whose
  // subject is "warns once" cannot be tested by a second observer in the same
  // process.
  const child = execFileSync(process.execPath, ['-e', `
    const models = require(${JSON.stringify(path.join(SRC, 'models.js'))});
    const out = [];
    console.warn = (m) => out.push(String(m));
    for (const task of models.FLIP_BLOCKED.keys()) {
      const r = models.resolve(task);
      if (r.provider !== 'gemini') out.push('RESOLVED_WRONG:' + task + ':' + r.provider);
      if (!/^gemini-/.test(r.model)) out.push('MODEL_WRONG:' + task + ':' + r.model);
    }
    process.stdout.write(JSON.stringify(out));
  `], {
    encoding: 'utf8',
    // Scrubbed, so an ambient AI_PROVIDER_* in a developer's shell cannot turn
    // this into a test of the flip path by accident.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AI_PROVIDER'))),
  });
  assert.deepStrictEqual(JSON.parse(child), [],
    'nobody asked to flip anything, so the gate must resolve gemini and say NOTHING — ' +
    'a blocked key is still the default path for every tenant');
});

test('the fail-closed fallback escalates when the fallback provider is unconfigured too', () => {
  // isProviderConfigured('gemini') was defined and never called. With an
  // Anthropic key and no Gemini key the router "stayed on gemini" into a client
  // that throws on every call — and assessment.js / keypoints.js swallow that
  // into null, which is the same silent fail-open the guard exists to prevent.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    // `personas` rather than a task another test touches: warnOnce is keyed on
    // task+provider, so reusing one would let an earlier warning swallow this
    // one and the assertion would pass or fail on test ORDER.
    withEnv({ GEMINI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, AI_PROVIDER_PERSONAS: 'anthropic' }, () => {
      assert.strictEqual(models.resolve('personas').provider, 'gemini',
        'still fails closed — the escalation is about the message, not the routing');
    });
  } finally { console.warn = realWarn; }
  assert.ok(warnings.some((w) => /GEMINI_API_KEY IS NOT SET EITHER/.test(w)),
    '"staying on gemini" is a lie when gemini cannot run either — say so');
});

test('keypoints is re-tiered for claude only, leaving gemini untouched', () => {
  // COMPANY_ANALYSIS_SCHEMA asks for judgment, not extraction; Haiku regresses
  // it. Correcting the Gemini tier here too would be a silent cost/quality
  // change in a PR that is meant to change nothing.
  assert.strictEqual(models.resolve('keypoints').model, 'gemini-2.5-flash-lite',
    'the gemini path must still resolve to exactly the model it did before');
  // asFlipUnblocked: `keypoints` is in FLIP_BLOCKED (its 2200-token budgets are
  // Gemini-sized and truncate on Sonnet), and this is a TIER assertion. The two
  // gates are separate on purpose, so a tier stays testable while a flip is
  // barred — see the flip-gate block above.
  asFlipUnblocked('keypoints', () => asDispatchReady('keypoints', () => withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('keypoints').model, 'claude-sonnet-5',
      'on claude it takes the flash tier, not lite');
  })));
});

// ── the assessment split (ADR-0006 §4.1) ────────────────────────────────────
//
// One key used to serve two call sites of very different difficulty: scoring a
// single competitor document (extraction, LITE) and synthesising a battlecard
// from up to 20 of them (judgment, FLASH). Flipping the shared key would have
// sent battlecard synthesis to Haiku — and a worse battlecard is not an error
// anyone sees, so nothing downstream would have reported it.

// Both tests below assert the DEFAULT gemini model ids, so they have to clear
// the per-task overrides first. `GEMINI_ASSESSMENT_MODEL` and
// `GEMINI_BATTLECARD_MODEL` are both compose-wired and supported — the second
// is the variable this very split tells operators to use — so a developer or
// runner with either set would otherwise get a red suite from a correct tree.
// Ambient env is never a false green here, only a false red; withEnv deletes a
// key whose value is `undefined`, which is what makes this work.
test('battlecard resolves to the same gemini model assessment does', () => {
  withEnv({ GEMINI_ASSESSMENT_MODEL: undefined, GEMINI_BATTLECARD_MODEL: undefined }, () => {
    // This is the whole safety property of the split: it is a router-only change,
    // so the provider serving 100% of today's traffic must not notice it.
    assert.strictEqual(models.resolve('battlecard').provider, 'gemini');
    assert.strictEqual(models.resolve('battlecard').model, models.resolve('assessment').model,
      're-tiering the gemini path here would be a live quality-and-cost change in a PR that is meant to change nothing');
    assert.strictEqual(models.resolve('battlecard').model, 'gemini-2.5-flash-lite');
  });
});

test('battlecard takes the flash tier on claude while assessment stays lite', () => {
  // asFlipUnblocked because this is a TIER assertion, not a gate one: the tier
  // table has to keep being testable while the key is blocked from flipping.
  asFlipUnblocked('battlecard', () => asDispatchReady('battlecard', () => withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('battlecard').model, 'claude-sonnet-5',
      'BATTLECARD_SCHEMA is synthesis over up to 20 dossiers; Haiku regresses it silently');
  })));
  asDispatchReady('assessment', () => withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('assessment').model, 'claude-haiku-4-5',
      'per-document scoring is the genuinely LITE half — the split exists so it can stay there');
  }));
});

// Was "battlecard is not dispatch-ready, so flipping it warns and stays on
// gemini" — the PR #53 invariant, which group 2 is the PR that retires. The
// still-unmigrated case is covered above by `discovery`, which is the right
// place for it: a test that asserts un-readiness about a key being migrated
// keeps passing for the wrong reason right up until it has to be deleted.
test('battlecard flips ALONE — its sibling in the same file does not follow it', () => {
  assert.strictEqual(SHIPPED_DISPATCH_READY.has('battlecard'), true,
    'group 2 migrated extractBattlecard onto the seam, so the key is eligible now');
  asFlipUnblocked('battlecard', () => withEnv({ AI_PROVIDER_BATTLECARD: 'anthropic', GEMINI_ASSESSMENT_MODEL: undefined }, () => {
    const b = models.resolve('battlecard');
    assert.strictEqual(b.provider, 'anthropic');
    assert.strictEqual(b.model, 'claude-sonnet-5', 'FLASH on claude, per the §4.1 split');
    // knowledge/assessment.js holds both call sites. Per-task env vars are the
    // unit of rollback, so one of them moving must not drag the other across —
    // and the scorer is the half that fails into a null scoreboard nobody sees.
    const a = models.resolve('assessment');
    assert.strictEqual(a.provider, 'gemini', 'AI_PROVIDER_BATTLECARD names one key, not one file');
    assert.strictEqual(a.model, 'gemini-2.5-flash-lite');
  }));
});

test('the battlecard env overrides are the names compose passes', () => {
  withEnv({ GEMINI_ASSESSMENT_MODEL: undefined, GEMINI_BATTLECARD_MODEL: undefined }, () => {
    assert.strictEqual(models.providerEnvName('battlecard'), 'AI_PROVIDER_BATTLECARD');
    withEnv({ GEMINI_BATTLECARD_MODEL: 'gemini-battlecard-custom' }, () => {
      assert.strictEqual(models.resolve('battlecard').model, 'gemini-battlecard-custom');
      // The sibling must not move with it — separate keys, separate knobs, is
      // the point of the split.
      assert.strictEqual(models.resolve('assessment').model, 'gemini-2.5-flash-lite');
    });
    asFlipUnblocked('battlecard', () => asDispatchReady('battlecard', () => withEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_BATTLECARD_MODEL: 'claude-battlecard-custom' }, () => {
      assert.strictEqual(models.resolve('battlecard').model, 'claude-battlecard-custom');
    })));
  });
});

test('[HYGIENE] the exported sets are exactly as models.js ships them', () => {
  // Placed AFTER the asDispatchReady / asFlipUnblocked users, as a second
  // checkpoint to the one at the top of the tiering block. Both sets are LIVE
  // EXPORTED collections with no seam for a fake, so every helper here mutates
  // the real thing and restores in a finally. A helper that leaks only the keys
  // it touched would slip past the set pin above — that pin runs earlier — and
  // then silently widen what a later test believes ships.
  assert.deepStrictEqual([...models.DISPATCH_READY].sort(), [...SHIPPED_DISPATCH_READY].sort(),
    'a helper above added a task to DISPATCH_READY and did not restore it');
  assert.deepStrictEqual([...models.FLIP_BLOCKED.keys()].sort(), [...SHIPPED_FLIP_BLOCKED].sort(),
    'a helper above lifted a FLIP_BLOCKED entry and did not restore it — every later ' +
    'assertion about a blocked key would then be testing an unblocked one');
});

test('a per-task model override wins over the tier, per provider', () => {
  withEnv({ GEMINI_DISCOVERY_MODEL: 'gemini-custom' }, () => {
    assert.strictEqual(models.resolve('discovery').model, 'gemini-custom');
  });
  asDispatchReady('discovery', () => withEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_DISCOVERY_MODEL: 'claude-custom' }, () => {
    assert.strictEqual(models.resolve('discovery').model, 'claude-custom');
  }));
  // A Gemini override must not leak into the Claude path.
  asDispatchReady('discovery', () => withEnv({ AI_PROVIDER: 'anthropic', GEMINI_DISCOVERY_MODEL: 'gemini-custom' }, () => {
    assert.strictEqual(models.resolve('discovery').model, 'claude-sonnet-5');
  }));
});

test('an unknown task falls back to the flash tier of its provider', () => {
  assert.strictEqual(models.resolve('nosuchtask').model, 'gemini-2.5-flash');
  asDispatchReady('nosuchtask', () => withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('nosuchtask').model, 'claude-sonnet-5');
  }));
});

// ── wrapper guard rails ─────────────────────────────────────────────────────

const anthropic = require(path.join(SRC, 'anthropic.js'));

test('generate rejects thinking:false above effort high before the API can 400', async () => {
  await assert.rejects(
    () => anthropic.generate({ model: 'claude-opus-5', prompt: 'x', thinking: false, effort: 'max' }),
    /thinking:false is only allowed at effort <= high/,
    'the API returns a 400 the caller cannot interpret; the wrapper must say which knob to move'
  );
  await assert.rejects(
    () => anthropic.generate({ model: 'claude-opus-5', prompt: 'x', thinking: false, effort: 'xhigh' }),
    /effort <= high/
  );
});

test('generate accepts thinking:false at or below effort high', async () => {
  // Reaches the client, which throws for a missing key — past the guard.
  await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => anthropic.generate({ model: 'claude-opus-5', prompt: 'x', thinking: false, effort: 'high' }),
      /ANTHROPIC_API_KEY is not set/
    );
  });
});

test('generate validates its inputs', async () => {
  await assert.rejects(() => anthropic.generate({ prompt: 'x' }), /model required/);
  // `messages` (ADR-0006 §9 item 4) made this an either/or rather than a
  // required `prompt`; the wrapper still refuses a request with neither.
  await assert.rejects(() => anthropic.generate({ model: 'm' }), /prompt or messages required/);
  await assert.rejects(
    () => anthropic.generate({ model: 'm', prompt: 'x', messages: [{ role: 'user', content: 'y' }] }),
    /prompt OR messages, not both/
  );
  await assert.rejects(
    () => anthropic.generate({ model: 'm', prompt: 'x', effort: 'gigantic' }),
    /unknown effort/
  );
});

test('textFrom joins text blocks and ignores thinking and tool blocks', () => {
  const msg = { content: [
    { type: 'thinking', thinking: 'internal reasoning that is not the answer' },
    { type: 'text', text: 'the ' },
    { type: 'tool_use', name: 'x', input: {} },
    { type: 'text', text: 'answer' },
  ] };
  assert.strictEqual(anthropic.textFrom(msg), 'the answer');
  assert.strictEqual(anthropic.textFrom(null), '');
  assert.strictEqual(anthropic.textFrom({}), '');
});

test('isConfigured reflects the key, not the client', () => {
  withEnv({ ANTHROPIC_API_KEY: undefined }, () => assert.strictEqual(anthropic.isConfigured(), false));
  withEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, () => assert.strictEqual(anthropic.isConfigured(), true));
});
