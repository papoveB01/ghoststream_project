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

const SRC = path.join(__dirname, '..', 'src');
const models = require(path.join(SRC, 'models.js'));

// The set as models.js actually ships it, captured before any test mutates it.
// Tests below temporarily add tasks to the real Set — there is no seam for a
// fake one — so anything asserting on its CONTENTS has to compare against this,
// or against a set that has been restored to it.
const SHIPPED_DISPATCH_READY = new Set(models.DISPATCH_READY);

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

test('group 1 survives the only test that rewrites the whole set', () => {
  // Placed immediately after that test on purpose: it is the tripwire for a
  // helper that mutates the exported Set without restoring it. `clear()` in the
  // tiering test above used to make this fail.
  assert.deepStrictEqual([...models.DISPATCH_READY].sort(),
    ['companyBrief', 'preview', 'relevance']);
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
  asDispatchReady('keypoints', () => withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('keypoints').model, 'claude-sonnet-5',
      'on claude it takes the flash tier, not lite');
  }));
});

// ── the assessment split (ADR-0006 §4.1) ────────────────────────────────────
//
// One key used to serve two call sites of very different difficulty: scoring a
// single competitor document (extraction, LITE) and synthesising a battlecard
// from up to 20 of them (judgment, FLASH). Flipping the shared key would have
// sent battlecard synthesis to Haiku — and a worse battlecard is not an error
// anyone sees, so nothing downstream would have reported it.

test('battlecard resolves to the same gemini model assessment does', () => {
  // This is the whole safety property of the split: it is a router-only change,
  // so the provider serving 100% of today's traffic must not notice it.
  assert.strictEqual(models.resolve('battlecard').provider, 'gemini');
  assert.strictEqual(models.resolve('battlecard').model, models.resolve('assessment').model,
    're-tiering the gemini path here would be a live quality-and-cost change in a PR that is meant to change nothing');
  assert.strictEqual(models.resolve('battlecard').model, 'gemini-2.5-flash-lite');
});

test('battlecard takes the flash tier on claude while assessment stays lite', () => {
  asDispatchReady('battlecard', () => withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('battlecard').model, 'claude-sonnet-5',
      'BATTLECARD_SCHEMA is synthesis over up to 20 dossiers; Haiku regresses it silently');
  }));
  asDispatchReady('assessment', () => withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('assessment').model, 'claude-haiku-4-5',
      'per-document scoring is the genuinely LITE half — the split exists so it can stay there');
  }));
});

test('battlecard is not dispatch-ready, so flipping it warns and stays on gemini', () => {
  assert.strictEqual(SHIPPED_DISPATCH_READY.has('battlecard'), false,
    'this PR splits the key; the call site still speaks only to the Gemini SDK');
  assert.strictEqual(models.DISPATCH_READY.has('battlecard'), false,
    'and no earlier test may have left it in the live set');
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    withEnv({ AI_PROVIDER_BATTLECARD: 'anthropic' }, () => {
      assert.strictEqual(models.resolve('battlecard').provider, 'gemini');
      assert.match(models.resolve('battlecard').model, /^gemini-/);
    });
  } finally { console.warn = realWarn; }
  assert.ok(warnings.some((w) => w.includes('battlecard') && w.includes('cannot dispatch yet')),
    'an operator following the runbook early must get a loud no-op, not silence');
});

test('the battlecard env overrides are the names compose passes', () => {
  assert.strictEqual(models.providerEnvName('battlecard'), 'AI_PROVIDER_BATTLECARD');
  withEnv({ GEMINI_BATTLECARD_MODEL: 'gemini-battlecard-custom' }, () => {
    assert.strictEqual(models.resolve('battlecard').model, 'gemini-battlecard-custom');
    // The sibling must not move with it — one key, one call site, is the point.
    assert.strictEqual(models.resolve('assessment').model, 'gemini-2.5-flash-lite');
  });
  asDispatchReady('battlecard', () => withEnv({ AI_PROVIDER: 'anthropic', ANTHROPIC_BATTLECARD_MODEL: 'claude-battlecard-custom' }, () => {
    assert.strictEqual(models.resolve('battlecard').model, 'claude-battlecard-custom');
  }));
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
