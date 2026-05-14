// Portfolio Manager — per-tenant CRUD for the three Intelligence Matrix
// entity tables (products, personas, competitors). All endpoints sit behind
// authMiddleware in index.js; every query is scoped by req.tenantId.
//
// Known limitation (Phase 1): the entity `id` is a global TEXT primary key,
// so two tenants can't both create an entity with the same id (the second
// gets a 409 "already exists" rather than a clean per-tenant insert). Phase 1
// onboarding doesn't let trial tenants create entities, so this isn't
// reachable yet. Fixing it properly = UUID PKs + composite junction keys.

const express = require('express');
const db = require('./db');

const TABLES = {
  products:    { table: 'products',    junction: 'kb_document_products',    column: 'product_id' },
  personas:    { table: 'personas',    junction: 'kb_document_personas',    column: 'persona_id' },
  competitors: { table: 'competitors', junction: 'kb_document_competitors', column: 'competitor_id' },
};

const router = express.Router();
router.use(express.json());

for (const [resource, conf] of Object.entries(TABLES)) {
  // LIST — only this tenant's entities. Doc counts are scoped via a join on
  // kb_documents.tenant_id so a shared junction row from another tenant
  // (impossible today, but defensive) doesn't inflate the count.
  router.get(`/${resource}`, async (req, res, next) => {
    try {
      const r = await db.query(
        `SELECT e.id, e.name, e.description, e.created_at,
                COALESCE(j.doc_count, 0)::int AS doc_count
           FROM ${conf.table} e
           LEFT JOIN LATERAL (
             SELECT COUNT(*) AS doc_count
               FROM ${conf.junction} jt
               JOIN kb_documents d ON d.id = jt.document_id
              WHERE jt.${conf.column} = e.id AND d.tenant_id = $1
           ) j ON TRUE
          WHERE e.tenant_id = $1
          ORDER BY lower(e.name)`,
        [req.tenantId]
      );
      res.json({ [resource]: r.rows });
    } catch (err) { next(err); }
  });

  // CREATE
  router.post(`/${resource}`, async (req, res, next) => {
    try {
      const { id, name, description } = req.body || {};
      if (!id || !name) return res.status(400).json({ error: 'id and name required' });
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
        return res.status(400).json({ error: 'id must be slug-shaped: [a-z0-9_-], 1-64 chars' });
      }
      const r = await db.query(
        `INSERT INTO ${conf.table} (id, tenant_id, name, description)
              VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, req.tenantId, name, description || null]
      );
      res.status(201).json({ [resource.replace(/s$/, '')]: r.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: `${resource.replace(/s$/, '')} with this id already exists` });
      }
      next(err);
    }
  });

  // PATCH — name/description only; id is immutable.
  router.patch(`/${resource}/:id`, async (req, res, next) => {
    try {
      const { name, description } = req.body || {};
      const sets = [];
      const params = [];
      if (name !== undefined)        { params.push(name);        sets.push(`name = $${params.length}`); }
      if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
      if (sets.length === 0) return res.status(400).json({ error: 'nothing to update; pass name and/or description' });
      params.push(req.params.id);
      params.push(req.tenantId);
      const r = await db.query(
        `UPDATE ${conf.table} SET ${sets.join(', ')}
          WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`,
        params
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
      res.json({ [resource.replace(/s$/, '')]: r.rows[0] });
    } catch (err) { next(err); }
  });

  // DELETE — RESTRICTed by FK if any document is still tagged.
  router.delete(`/${resource}/:id`, async (req, res, next) => {
    try {
      const r = await db.query(
        `DELETE FROM ${conf.table} WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, req.tenantId]
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true });
    } catch (err) {
      if (err.code === '23503') {
        const count = await db.query(
          `SELECT COUNT(*)::int AS n
             FROM ${conf.junction} jt JOIN kb_documents d ON d.id = jt.document_id
            WHERE jt.${conf.column} = $1 AND d.tenant_id = $2`,
          [req.params.id, req.tenantId]
        );
        return res.status(409).json({
          error: `cannot delete: ${count.rows[0].n} document(s) still tagged with this ${resource.replace(/s$/, '')}. Untag them first.`,
        });
      }
      next(err);
    }
  });
}

module.exports = { router };
