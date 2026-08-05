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

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
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
function asDispatchReady(task, fn) {
  models.DISPATCH_READY.add(task);
  try { return fn(); } finally { models.DISPATCH_READY.delete(task); }
}

test('a task that cannot dispatch yet stays on gemini and says so', () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    withEnv({ AI_PROVIDER_RELEVANCE: 'anthropic' }, () => {
      assert.strictEqual(models.resolve('relevance').provider, 'gemini',
        'no call site reads resolve().provider yet — honouring this would 404 every call');
      assert.match(models.resolve('relevance').model, /^gemini-/);
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

test('an unknown provider falls back to gemini instead of failing boot', () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    withEnv({ AI_PROVIDER: 'antropic' }, () => {   // deliberate typo
      assert.strictEqual(models.resolve('discovery').provider, 'gemini');
    });
  } finally { console.warn = realWarn; }
  assert.ok(warnings.some((w) => w.includes('antropic')),
    'a silent fallback would hide the typo — it must warn');
});

// ── tiering ─────────────────────────────────────────────────────────────────

test('claude tiers follow ADR-0006 §4.1', () => {
  for (const k of Object.keys(models.TASKS)) models.DISPATCH_READY.add(k);
  try {
  withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('callAnalysis').model, 'claude-opus-5', 'pro tier');
    assert.strictEqual(models.resolve('proposal').model, 'claude-opus-5');
    assert.strictEqual(models.resolve('discovery').model, 'claude-sonnet-5', 'flash tier');
    assert.strictEqual(models.resolve('content').model, 'claude-sonnet-5', 'content tier');
    assert.strictEqual(models.resolve('relevance').model, 'claude-haiku-4-5', 'lite tier');
  });
  } finally { models.DISPATCH_READY.clear(); }
});

test('keypoints is re-tiered for claude only, leaving gemini untouched', () => {
  // COMPANY_ANALYSIS_SCHEMA asks for judgment, not extraction; Haiku regresses
  // it. Correcting the Gemini tier here too would be a silent cost/quality
  // change in a PR that is meant to change nothing.
  assert.strictEqual(models.resolve('keypoints').model, 'gemini-2.5-flash-lite',
    'the gemini path must be byte-identical to before');
  asDispatchReady('keypoints', () => withEnv({ AI_PROVIDER: 'anthropic' }, () => {
    assert.strictEqual(models.resolve('keypoints').model, 'claude-sonnet-5',
      'on claude it takes the flash tier, not lite');
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
