// CRM provider registry. The market leaders with REST APIs; `live` marks which
// connectors are wired end-to-end today. The others are present so the UI lists
// them and stores a connection, but importing returns 501 until their connector
// lands.
//
// OAuth providers are BYO-app: the tenant registers an app/client in THEIR CRM
// account and pastes its credentials here — we never hold platform-level CRM
// creds. The shape that drives the guided UI + generic routes (crm/index.js):
//   authType: 'oauth'  — guided card with `fields`, callback URL + Connect flow
//   fields             — credential inputs ({key,label,type}); `select` types
//                        carry `options:[{value,label}]`; the field keys land
//                        in POST /crm/:provider/app
//   environments: true — Production/Sandbox login-host toggle (Salesforce)
//   callbackPath       — the redirect URI tenants register in their app

const PROVIDERS = [
  {
    id: 'hubspot', label: 'HubSpot', authType: 'token', live: true,
    tokenLabel: 'Private app access token',
    tokenHelp: 'In HubSpot: Settings → Integrations → Private Apps → create an app with the crm.objects.contacts.read and crm.objects.companies.read scopes, then copy its token (starts with "pat-").',
    docsUrl: 'https://developers.hubspot.com/docs/api/private-apps',
  },
  {
    id: 'salesforce', label: 'Salesforce', authType: 'oauth', live: true,
    // BYO Connected App: the tenant supplies their org's app credentials, then
    // we run the OAuth handshake (crm/index.js). `environments` toggles the
    // Production/Sandbox login host; `callbackPath` is shown so they can add it
    // to their Connected App's callback URLs.
    environments: true,
    callbackPath: '/api/crm/salesforce/callback',
    fields: [
      { key: 'clientId',     label: 'Consumer Key',    type: 'text' },
      { key: 'clientSecret', label: 'Consumer Secret', type: 'password' },
    ],
    tokenHelp: 'In your Salesforce org: Setup → App Manager → New Connected App → enable OAuth Settings, add the Callback URL shown below, and select the scopes "Manage user data via APIs (api)" and "Perform requests at any time (refresh_token, offline_access)". Save, then copy the app\'s Consumer Key + Consumer Secret here.',
    docsUrl: 'https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm',
  },
  {
    id: 'zoho', label: 'Zoho CRM', authType: 'oauth', live: true,
    // BYO API client: the tenant creates a Server-based Application in the
    // Zoho API Console and picks the data center their account lives in (Zoho
    // is multi-DC; the OAuth host depends on it — see crm/zoho.js).
    callbackPath: '/api/crm/zoho/callback',
    fields: [
      { key: 'clientId',     label: 'Client ID',     type: 'text' },
      { key: 'clientSecret', label: 'Client Secret', type: 'password' },
      { key: 'region',       label: 'Data center',   type: 'select', options: [
        { value: 'us', label: 'United States (zoho.com)' },
        { value: 'eu', label: 'Europe (zoho.eu)' },
        { value: 'in', label: 'India (zoho.in)' },
        { value: 'au', label: 'Australia (zoho.com.au)' },
        { value: 'jp', label: 'Japan (zoho.jp)' },
        { value: 'ca', label: 'Canada (zohocloud.ca)' },
        { value: 'sa', label: 'Saudi Arabia (zoho.sa)' },
        { value: 'cn', label: 'China (zoho.com.cn)' },
      ] },
    ],
    tokenHelp: 'In the Zoho API Console (api-console.zoho.com): Add Client → Server-based Applications. Set the Authorized Redirect URI to the Callback URL shown below, then copy the Client ID + Client Secret here and pick the data center your Zoho account is hosted on.',
    docsUrl: 'https://www.zoho.com/crm/developer/docs/api/v8/oauth-overview.html',
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
