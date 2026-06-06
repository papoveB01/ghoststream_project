// Public website contact / demo-request form → email to the sales inbox.
// Mounted UNAUTHENTICATED at /api/contact. Honeypot + validation + length caps
// guard against bot spam. Sends via SendGrid (api/src/email.js) with a branded
// HTML template; Reply-To is set to the submitter so the team can reply directly.

const express = require('express');
const email = require('./email');

const TO = process.env.CONTACT_FORM_TO || 'contact@dealscope.io';
const CAP = { name: 120, email: 200, company: 200, industry: 120, size: 60, reason: 80, message: 4000 };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

function buildHtml(d) {
  const row = (label, val) => val
    ? `<tr><td style="padding:9px 0;color:#5b616e;font-size:13px;width:130px;vertical-align:top">${esc(label)}</td><td style="padding:9px 0;color:#16181d;font-size:14px;font-weight:600">${esc(val)}</td></tr>`
    : '';
  const message = d.message
    ? `<div style="margin-top:18px"><div style="color:#5b616e;font-size:13px;margin-bottom:6px">Message</div><div style="background:#f6f6f3;border:1px solid #e4e7ec;border-radius:8px;padding:14px;color:#16181d;font-size:14px;line-height:1.6;white-space:pre-wrap">${esc(d.message)}</div></div>`
    : '';
  const kind = d.type === 'demo' ? 'Demo request' : 'New inquiry';
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border:1px solid #e4e7ec;border-radius:14px;overflow:hidden">
    <div style="background:#12141a;padding:18px 24px">
      <span style="display:inline-block;width:26px;height:26px;border-radius:7px;background:#c2f24a;color:#12141a;font-weight:800;text-align:center;line-height:26px;font-size:15px;vertical-align:middle">D</span>
      <span style="color:#ffffff;font-weight:800;font-size:16px;vertical-align:middle;margin-left:8px">DealScope</span>
      <span style="float:right;color:#8a8f99;font-size:11px;text-transform:uppercase;letter-spacing:.1em;line-height:26px">${kind}</span>
    </div>
    <div style="padding:24px">
      <h1 style="margin:0 0 4px;font-size:18px;color:#16181d">${d.type === 'demo' ? 'New demo request' : 'New contact submission'}</h1>
      <p style="margin:0 0 18px;color:#5b616e;font-size:13px">From the dealscope.io website${d.reason ? ' &middot; ' + esc(d.reason) : ''}</p>
      <table style="width:100%;border-collapse:collapse">
        ${row('Name', `${d.firstName} ${d.lastName}`.trim())}
        ${row('Email', d.email)}
        ${row('Company', d.company)}
        ${row('Industry', d.industry)}
        ${row('Company size', d.companySize)}
      </table>
      ${message}
      <a href="mailto:${esc(d.email)}" style="display:inline-block;margin-top:22px;background:#3c7d13;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:8px">Reply to ${esc(d.firstName) || 'them'}</a>
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e4e7ec;color:#8a8f99;font-size:11px">Sent automatically from the DealScope website form &middot; ${esc(new Date().toUTCString())}</div>
  </div></body></html>`;
}

function buildText(d) {
  return [
    `New ${d.type === 'demo' ? 'demo request' : 'contact submission'} from dealscope.io`,
    '',
    `Name: ${d.firstName} ${d.lastName}`,
    `Email: ${d.email}`,
    `Company: ${d.company}`,
    d.industry ? `Industry: ${d.industry}` : null,
    d.companySize ? `Company size: ${d.companySize}` : null,
    d.reason ? `Reason: ${d.reason}` : null,
    '',
    d.message ? `Message:\n${d.message}` : '(no message)',
  ].filter((x) => x !== null).join('\n');
}

const router = express.Router();
router.use(express.json());

router.post('/', async (req, res) => {
  const b = req.body || {};
  // Honeypot: real users never fill the hidden "website" field. Pretend success.
  if (b.website) return res.json({ ok: true });

  const d = {
    type: b.type === 'demo' ? 'demo' : 'contact',
    firstName: String(b.firstName || '').trim().slice(0, CAP.name),
    lastName: String(b.lastName || '').trim().slice(0, CAP.name),
    email: String(b.email || '').trim().slice(0, CAP.email),
    company: String(b.company || '').trim().slice(0, CAP.company),
    industry: String(b.industry || '').trim().slice(0, CAP.industry),
    companySize: String(b.companySize || '').trim().slice(0, CAP.size),
    reason: String(b.reason || '').trim().slice(0, CAP.reason),
    message: String(b.message || '').trim().slice(0, CAP.message),
  };

  if (!d.firstName || !d.lastName || !d.email || !d.company) {
    return res.status(400).json({ error: 'First name, last name, work email and company are required.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    await email.send({
      to: TO,
      subject: `${d.type === 'demo' ? 'Demo request' : 'Contact'} — ${d.company} (${d.firstName} ${d.lastName})`,
      html: buildHtml(d),
      text: buildText(d),
      replyTo: d.email,
      categories: ['website-' + d.type],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[contact] send failed:', (err && err.message) || err);
    const configIssue = err && err.status === 503;
    res.status(configIssue ? 503 : 500).json({
      error: configIssue
        ? 'Email isn’t configured yet — please write to contact@dealscope.io directly.'
        : 'Something went wrong sending your message. Please try again, or email contact@dealscope.io.',
    });
  }
});

module.exports = { router };
