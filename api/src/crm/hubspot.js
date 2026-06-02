// HubSpot connector (live reference). Token auth = a HubSpot "private app" access
// token (Bearer). Pulls Companies + Contacts via CRM v3 and returns them in the
// normalized shape the importer expects.
//
//   verify(creds)              → throws on a bad token, else true
//   pullProspects(creds, opts) → { companies:[{name,domain}],
//                                  contacts:[{name,email,role,title,
//                                             companyName,companyDomain}] }

const HUBSPOT_BASE = 'https://api.hubapi.com';
const PAGE = 100;

async function hsGet(token, path) {
  const res = await fetch(`${HUBSPOT_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    const e = new Error('HubSpot rejected the token — make sure it\'s a private-app token with the crm.objects.contacts.read and crm.objects.companies.read scopes.');
    e.status = 401; throw e;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`HubSpot API error ${res.status}: ${body.slice(0, 160)}`);
    e.status = 502; throw e;
  }
  return res.json();
}

async function verify(creds) {
  const token = creds && creds.token;
  if (!token) { const e = new Error('token required'); e.status = 400; throw e; }
  await hsGet(token, '/crm/v3/objects/contacts?limit=1');
  return true;
}

async function pullProspects(creds, { limit = 200 } = {}) {
  const token = creds.token;

  // 1. Companies → keep a name/domain map keyed by HubSpot id for contact assoc.
  const companies = [];
  const companyById = new Map();
  let after = null, fetched = 0;
  do {
    const qs = new URLSearchParams({ limit: String(PAGE), properties: 'name,domain' });
    if (after) qs.set('after', after);
    const data = await hsGet(token, `/crm/v3/objects/companies?${qs.toString()}`);
    for (const c of (data.results || [])) {
      const name = String((c.properties && c.properties.name) || '').trim();
      const domain = String((c.properties && c.properties.domain) || '').trim().toLowerCase() || null;
      if (name) { companies.push({ name, domain }); companyById.set(c.id, { name, domain }); }
      fetched++;
    }
    after = data.paging && data.paging.next && data.paging.next.after;
  } while (after && fetched < limit);

  // 2. Contacts (+ associated company) → normalized rows.
  const contacts = [];
  after = null; fetched = 0;
  do {
    const qs = new URLSearchParams({
      limit: String(PAGE),
      properties: 'firstname,lastname,email,jobtitle,company',
      associations: 'companies',
    });
    if (after) qs.set('after', after);
    const data = await hsGet(token, `/crm/v3/objects/contacts?${qs.toString()}`);
    for (const ct of (data.results || [])) {
      const p = ct.properties || {};
      const email = String(p.email || '').trim();
      if (!email) continue;
      const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim() || null;
      let companyName = String(p.company || '').trim() || null;
      let companyDomain = null;
      const assoc = ct.associations && ct.associations.companies && ct.associations.companies.results;
      if (assoc && assoc[0] && companyById.has(assoc[0].id)) {
        const co = companyById.get(assoc[0].id);
        companyName = co.name; companyDomain = co.domain;
      }
      const jobtitle = String(p.jobtitle || '').trim() || null;
      contacts.push({ name, email, role: jobtitle, title: jobtitle, companyName, companyDomain });
      fetched++;
    }
    after = data.paging && data.paging.next && data.paging.next.after;
  } while (after && fetched < limit);

  return { companies, contacts };
}

module.exports = { verify, pullProspects };
