-- The direct HubSpot connection was replaced by the Zapier bridge:
-- roles that could manage HubSpot now manage integrations.
INSERT INTO "role_permissions" ("roleId", "permission")
SELECT "roleId", 'integrations.manage' FROM "role_permissions" WHERE "permission" = 'hubspot.manage'
ON CONFLICT DO NOTHING;
DELETE FROM "role_permissions" WHERE "permission" = 'hubspot.manage';
