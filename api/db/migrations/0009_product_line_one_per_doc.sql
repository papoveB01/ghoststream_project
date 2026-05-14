-- Product lines become a 0-or-1 relationship per KB document.
--
-- Decision (2026-05-11): a KB document is either filed under exactly ONE of
-- the tenant's product lines ("Fraud Solution", "Payment Gateway", …) or it is
-- left untagged = company-wide ("global" — matches every product line at
-- retrieval time, exactly as before). Personas and competitors keep their
-- many-to-many semantics; only the product dimension is constrained to ≤1.
--
-- We deliberately keep the kb_document_products junction table: retrieval, the
-- Library tag filters, and the TAG_AGG_JOIN aggregation all keep working
-- against it unchanged. We just stop a document from carrying more than one
-- product_id row.

-- Defensive: if any document somehow already has 2+ product tags, keep the
-- one with the lexicographically-smallest product_id and drop the rest, so the
-- unique index below can be created. (No such rows exist in the current data,
-- but a migration must be safe against any historical state.)
DELETE FROM kb_document_products kdp
 WHERE EXISTS (
   SELECT 1 FROM kb_document_products keep
    WHERE keep.document_id = kdp.document_id
      AND keep.product_id  < kdp.product_id
 );

-- At most one product line per document.
CREATE UNIQUE INDEX kb_document_products_one_per_doc
  ON kb_document_products (document_id);
