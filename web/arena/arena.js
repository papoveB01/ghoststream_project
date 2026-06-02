(function () {
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('id');
  if (!sessionId) return showError('Missing session id in URL.');

  init();

  async function init() {
    let data;
    try {
      const res = await fetch(`/api/arena/${encodeURIComponent(sessionId)}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        return showError(payload.error || `HTTP ${res.status}`);
      }
      data = (await res.json()).session;
    } catch (err) {
      return showError(err.message);
    }
    renderBrief(data);
    renderChat(data.turns || []);
    wireComposer();
    hide('loading');
    show('session');
    scrollToBottom();
  }

  function showError(msg) {
    hide('loading');
    show('error');
    $('error-msg').textContent = msg;
  }

  function fmtTime(sec) {
    const m = Math.floor((sec || 0) / 60);
    const s = Math.floor((sec || 0) % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function renderBrief(s) {
    const o = s.objection || {};
    $('brief-title').textContent = `Practice · ${o.category || 'objection'}`;
    $('brief-objection').textContent = `"${o.quote || ''}"`;
    $('brief-persona').textContent = (s.persona || '').replace(/-/g, ' ');
    $('brief-ts').textContent = `${fmtTime(o.startSeconds)} – ${fmtTime(o.endSeconds)}`;
    $('brief-resolved').textContent = o.resolved ? 'Yes' : 'No';
    const mode = $('brief-mode');
    mode.textContent = s.cacheMode || 'inline';
    mode.className = `mode-pill ${s.cacheMode || 'inline'}`;
    updateTurnCounter(s.turns || []);

    // Back link to the portal that started this session
    if (s.portalId) {
      $('back-portal').href = `/portal/?id=${encodeURIComponent(s.portalId)}`;
    }
  }

  function renderChat(turns) {
    const chat = $('chat');
    chat.innerHTML = '';
    for (const t of turns) {
      if (t.role === 'system') continue; // grounding is internal
      chat.appendChild(makeBubble(t.role, t.content));
    }
  }

  function makeBubble(role, text, opts = {}) {
    const div = document.createElement('div');
    div.className = `bubble bubble-${role}` + (opts.thinking ? ' bubble-thinking' : '');
    const avatar = document.createElement('div');
    avatar.className = 'bubble-avatar';
    avatar.textContent = role === 'rep' ? 'YOU' : 'SC';
    div.appendChild(avatar);
    const body = document.createElement('div');
    body.className = 'bubble-content';
    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    meta.textContent = role === 'rep' ? 'You' : 'Sara Chen · CFO';
    const content = document.createElement('div');
    content.className = 'bubble-text';
    content.textContent = text;
    body.appendChild(meta);
    body.appendChild(content);
    div.appendChild(body);
    return div;
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  function updateTurnCounter(turns) {
    const userTurns = (turns || []).filter((t) => t.role === 'rep').length;
    $('turn-counter').textContent = `${userTurns} response${userTurns === 1 ? '' : 's'} sent`;
  }

  let ended = false;

  function wireComposer() {
    const form = $('composer-form');
    const input = $('composer-input');
    const sendBtn = $('send-btn');
    const endBtn = $('end-btn');
    const counter = $('counter');

    input.addEventListener('input', () => {
      counter.textContent = `${input.value.length} / 4000`;
    });

    endBtn.addEventListener('click', () => endSession('rep'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      counter.textContent = '0 / 4000';

      const chat = $('chat');
      chat.appendChild(makeBubble('rep', text));
      const thinking = makeBubble('prospect', 'thinking', { thinking: true });
      chat.appendChild(thinking);
      scrollToBottom();
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending…';

      try {
        const res = await fetch(`/api/arena/${encodeURIComponent(sessionId)}/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text }),
        });
        const payload = await res.json();
        thinking.remove();
        if (!res.ok) {
          chat.appendChild(makeBubble('prospect', `[Error: ${payload.error || res.status}]`));
        } else {
          chat.appendChild(makeBubble('prospect', payload.reply || '(no reply)'));
          $('turn-counter').textContent =
            `${payload.repTurns} response${payload.repTurns === 1 ? '' : 's'} sent`;
          // Turn limit reached — auto-finalize into a scorecard.
          if (payload.complete) {
            sendBtn.disabled = false;
            await endSession('limit');
            return;
          }
        }
      } catch (err) {
        thinking.remove();
        chat.appendChild(makeBubble('prospect', `[Network error: ${err.message}]`));
      } finally {
        if (!ended) {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send';
          scrollToBottom();
          input.focus();
        }
      }
    });
  }

  // Finalize the session and render the coaching scorecard. `cause` is 'rep'
  // (clicked End) or 'limit' (hit the turn cap). Locks the composer either way.
  async function endSession(cause) {
    if (ended) return;
    ended = true;
    lockComposer(cause === 'limit'
      ? 'Turn limit reached — scoring your session…'
      : 'Scoring your session…');

    try {
      const res = await fetch(`/api/arena/${encodeURIComponent(sessionId)}/end`, {
        method: 'POST',
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
      renderScorecard(payload.scorecard);
    } catch (err) {
      const sc = $('scorecard');
      sc.innerHTML = `<p class="sc-empty">Could not generate scorecard: ${err.message}</p>`;
      show('scorecard');
    }
    scrollToBottom();
  }

  function lockComposer(infoMsg) {
    $('send-btn').disabled = true;
    $('end-btn').disabled = true;
    $('composer-input').disabled = true;
    $('composer-info').textContent = infoMsg;
  }

  function renderScorecard(sc) {
    const host = $('scorecard');
    if (!sc) { host.innerHTML = '<p class="sc-empty">No scorecard available.</p>'; show('scorecard'); return; }
    if (sc.incomplete) {
      host.innerHTML = '<div class="sc-head"><h3 class="sc-title">Session ended</h3></div>'
        + `<p class="sc-empty">${escapeHtml(sc.feedback || 'Not enough responses to score.')}</p>`;
      show('scorecard'); return;
    }

    const dims = (sc.dimensions || []).map((d) => {
      const pct = d.max ? Math.round((d.score / d.max) * 100) : 0;
      return `
        <div class="sc-dim">
          <div class="sc-dim-top"><span>${escapeHtml(d.name)}</span><span class="pts">${d.score} / ${d.max}</span></div>
          <div class="sc-bar"><i style="width:${pct}%"></i></div>
          ${d.note ? `<div class="sc-dim-note">${escapeHtml(d.note)}</div>` : ''}
        </div>`;
    }).join('');

    const list = (title, items) => (items && items.length)
      ? `<div><h4>${title}</h4><ul>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`
      : '';
    const lists = list('Strengths', sc.strengths) + list('To improve', sc.improvements);

    host.innerHTML = `
      <div class="sc-head">
        <h3 class="sc-title">Coaching scorecard</h3>
        ${typeof sc.overall === 'number'
          ? `<div class="sc-overall"><span class="num">${sc.overall}</span><span class="lbl">/ 100</span></div>`
          : ''}
      </div>
      ${dims}
      ${sc.feedback ? `<p class="sc-feedback">${escapeHtml(sc.feedback)}</p>` : ''}
      ${lists ? `<div class="sc-lists">${lists}</div>` : ''}`;
    show('scorecard');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
})();
