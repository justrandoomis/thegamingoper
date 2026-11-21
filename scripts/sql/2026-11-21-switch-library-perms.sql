-- 2026-11-21 — the Switch game library's permission, catalog.switch_library.manage (app/server/permissions.ts;
-- the admin pages /admin/catalog/switch-library, docs/switch-builder.md §7).
--
-- Production roles are rows (roles, role_permissions). seedRoles() never adds a new permission to a role that already
-- exists (an owner's edits are kept), so a new install gets it from DEFAULT_ROLES and production gets it here, the way
-- the code's defaults give it: to the built-in MANAGER and CONTENT roles — and only while that role still holds
-- catalog.product.update (a role the owner took the catalogue away from is left as it is). The owner role holds "*"
-- and needs nothing. Custom roles are not touched: the owner ticks the permission in Security → Roles if wanted.
--
-- Each grant is written to the audit log first (security.role.update, the shape the role editor writes, actor
-- "system"), for the roles that do not hold the permission yet and have never had it from this file; then the grant
-- itself, ONLY for the roles step 1 has just audited: their audit event is less than five minutes old and nothing has
-- been audited after it (D1 runs a file as one unit, so nothing comes between the two steps).
--
-- So the file gives each role the permission at most once. A second run changes nothing, and neither does a run after
-- the owner has taken the permission away again: through Security → Roles (which writes its own audit event), or by
-- hand once five minutes have passed since the file first ran. (A hand edit within those minutes, with nothing audited
-- in between, leaves the tables exactly as they are between this file's two steps: no SQL can tell the two apart.)
--
-- No BEGIN/COMMIT (D1 runs a file as one unit). Deploy the code that knows the permission FIRST (an unknown permission
-- string is ignored by expandPermissions), then:
--   npx wrangler d1 execute DB --remote --file scripts/sql/2026-11-21-switch-library-perms.sql
-- Check afterwards:
--   SELECT r.key FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE p.permission = 'catalog.switch_library.manage';

-- 1. the audit events (one per role that gains the permission now) ──────────────────────────────────────────────────

INSERT INTO audit_events (id, at, actor_kind, actor_id, actor_label, action, entity_type, entity_id, summary, before, after, reason)
SELECT
  'aud_20261121_switch_library_perm_' || r.key,
  unixepoch() * 1000,
  'system',
  'deploy:2026-11-21-switch-library-perms',
  'deploy:2026-11-21-switch-library-perms',
  'security.role.update',
  'role',
  r.id,
  r.key,
  json_object('permissions', (SELECT json_group_array(permission) FROM (SELECT permission FROM role_permissions WHERE role_id = r.id ORDER BY permission))),
  json_object(
    'permissions', (SELECT json_group_array(permission) FROM (SELECT permission FROM role_permissions WHERE role_id = r.id UNION SELECT 'catalog.switch_library.manage' ORDER BY 1)),
    'added', json_array('catalog.switch_library.manage'),
    'removed', json_array(),
    'fieldAdded', json_array(),
    'fieldRemoved', json_array(),
    'members', (SELECT count(*) FROM employee_roles er WHERE er.role_id = r.id)
  ),
  'New permission for the Switch game library (sizes, eShop prices, trailers, pictures, descriptions, CSV), given to the built-in roles that manage the catalogue — deploy 2026-11-21.'
FROM roles r
WHERE r.key IN ('manager', 'content')
  AND EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.permission = 'catalog.product.update')
  AND NOT EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.permission = 'catalog.switch_library.manage')
  AND NOT EXISTS (SELECT 1 FROM audit_events a WHERE a.id = 'aud_20261121_switch_library_perm_' || r.key);

-- 2. the grants: only the roles step 1 has just audited ─────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO role_permissions (role_id, permission)
SELECT r.id, 'catalog.switch_library.manage'
FROM roles r
JOIN audit_events a ON a.id = 'aud_20261121_switch_library_perm_' || r.key
WHERE r.key IN ('manager', 'content')
  AND EXISTS (SELECT 1 FROM role_permissions p WHERE p.role_id = r.id AND p.permission = 'catalog.product.update')
  AND a.at >= (unixepoch() - 300) * 1000
  AND NOT EXISTS (
    SELECT 1 FROM audit_events later
    WHERE later.seq > a.seq
      AND later.id NOT IN ('aud_20261121_switch_library_perm_manager', 'aud_20261121_switch_library_perm_content')
  );
