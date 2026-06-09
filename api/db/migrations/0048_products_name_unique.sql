-- Prevent duplicate products within a tenant.
--
-- Two onboarding paths populate the catalog: the background foundation
-- enrichment (enrichment.js, ids shaped "<slug>-<tenant8>") and the client
-- product-create (POST /portfolio/products, plain "<slug>" ids). Because the
-- only uniqueness was the id PK and the two paths mint different ids for the
-- same product, a tenant could end up with two rows for one product (e.g.
-- "branchwise" + "branchwise-f68489a9"). Guard it at the DB level so neither
-- path — nor a race between them — can create a name-duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS products_tenant_lname_uniq
  ON products (tenant_id, lower(name));
