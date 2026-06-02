// CRM provider registry. The market leaders with REST APIs; `live` marks which
// connectors are wired end-to-end today (token auth). The others are present so
// the UI lists them and stores a connection, but importing returns 501 until
// their connector lands (OAuth flows mostly).

const PROVIDERS = [
  {
    id: 'hubspot', label: 'HubSpot', authType: 'token', live: true,
    tokenLabel: 'Private app access token',
    tokenHelp: 'In HubSpot: Settings → Integrations → Private Apps → create an app with the crm.objects.contacts.read and crm.objects.companies.read scopes, then copy its token (starts with "pat-").',
    docsUrl: 'https://developers.hubspot.com/docs/api/private-apps',
  },
  {
    id: 'salesforce', label: 'Salesforce', authType: 'token', live: false,
    tokenLabel: 'OAuth access token',
    tokenHelp: 'Salesforce authenticates via OAuth 2.0 — a guided Connect flow is coming soon.',
    docsUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/',
  },
  {
    id: 'zoho', label: 'Zoho CRM', authType: 'token', live: false,
    tokenLabel: 'OAuth access token',
    tokenHelp: 'Zoho CRM uses OAuth 2.0 / self-client tokens (region-specific) — a guided Connect flow is coming soon.',
    docsUrl: 'https://www.zoho.com/crm/developer/docs/api/v2/',
  },
  {
    id: 'pipedrive', label: 'Pipedrive', authType: 'token', live: false,
    tokenLabel: 'API token',
    tokenHelp: 'Pipedrive: Settings → Personal preferences → API → copy your personal API token. Connector coming soon.',
    docsUrl: 'https://developers.pipedrive.com/docs/api/v1',
  },
  {
    id: 'dynamics', label: 'Microsoft Dynamics 365', authType: 'token', live: false,
    tokenLabel: 'OAuth access token',
    tokenHelp: 'Dynamics 365 (Dataverse) authenticates via Azure AD OAuth — a guided Connect flow is coming soon.',
    docsUrl: 'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview',
  },
];

function get(id) { return PROVIDERS.find((p) => p.id === id) || null; }
function list() { return PROVIDERS; }

module.exports = { PROVIDERS, get, list };
