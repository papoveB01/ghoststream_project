-- Reverses 0012_microsoft_tenant_consent.sql. The premise behind that table
-- — that a per-(GhostStream tenant) Microsoft admin-consent record unlocks
-- a Recall.ai Teams bot credential registration — turned out to be wrong on
-- the underlying Recall API: there is no programmatic /teams-bot-credentials/
-- endpoint, and Recall's signed-in Teams bot uses a Microsoft *user account*
-- (email + password) configured once via Recall's dashboard, not an Azure AD
-- application credential. See docs/adr/0002-microsoft-graph-direct.md §8 for
-- the full correction.
--
-- The table is dropped; no row in it ever fed dispatch, so there is no data
-- migration. If Recall later ships a real Teams bot credential API the table
-- shape from 0012 is a reasonable starting point to reintroduce.

DROP TABLE IF EXISTS tenant_microsoft_consent;
