/**
 * Permission catalog. Roles are sets of permissions stored in the database
 * (role_permissions) so custom roles can be added later without code changes.
 * Code must check permissions — never role names.
 */
export const PERMISSIONS = {
  ORG_SETTINGS_MANAGE: "org.settings.manage",
  USERS_VIEW: "org.users.view",
  USERS_MANAGE: "org.users.manage",
  TEAMS_MANAGE: "org.teams.manage",
  ROLES_MANAGE: "org.roles.manage",
  BILLING_VIEW: "org.billing.view",
  HUBSPOT_MANAGE: "hubspot.manage",
  TEMPLATES_VIEW: "templates.view",
  TEMPLATES_MANAGE: "templates.manage",
  EMAIL_TEMPLATES_MANAGE: "email_templates.manage",
  CUSTOM_FIELDS_MANAGE: "custom_fields.manage",
  DOCUMENTS_VIEW_OWN: "documents.view.own",
  DOCUMENTS_VIEW_TEAM: "documents.view.team",
  DOCUMENTS_VIEW_ALL: "documents.view.all",
  DOCUMENTS_CREATE: "documents.create",
  DOCUMENTS_EDIT_OWN: "documents.edit.own",
  DOCUMENTS_EDIT_TEAM: "documents.edit.team",
  DOCUMENTS_EDIT_ALL: "documents.edit.all",
  DOCUMENTS_PUBLISH: "documents.publish",
  DOCUMENTS_SEND: "documents.send",
  DOCUMENTS_ARCHIVE: "documents.archive",
  DOCUMENTS_REVISE_COMPLETED: "documents.revise_completed",
  DOCUMENTS_REASSIGN: "documents.reassign",
  ANALYTICS_VIEW_TEAM: "analytics.view.team",
  ANALYTICS_VIEW_ALL: "analytics.view.all",
  AUDIT_VIEW: "audit.view",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

export const PERMISSION_LABELS: Record<Permission, string> = {
  "org.settings.manage": "Manage company settings",
  "org.users.view": "View users",
  "org.users.manage": "Invite and disable users",
  "org.teams.manage": "Manage teams",
  "org.roles.manage": "Manage roles & permissions",
  "org.billing.view": "View plan & usage",
  "hubspot.manage": "Manage HubSpot integration",
  "templates.view": "Use templates",
  "templates.manage": "Create and edit templates",
  "email_templates.manage": "Manage email templates",
  "custom_fields.manage": "Manage custom variables",
  "documents.view.own": "View own documents",
  "documents.view.team": "View team documents",
  "documents.view.all": "View all company documents",
  "documents.create": "Create documents",
  "documents.edit.own": "Edit own documents",
  "documents.edit.team": "Edit team documents",
  "documents.edit.all": "Edit all company documents",
  "documents.publish": "Publish documents",
  "documents.send": "Send documents",
  "documents.archive": "Archive documents",
  "documents.revise_completed": "Revise accepted / signed documents",
  "documents.reassign": "Reassign document owner",
  "analytics.view.team": "View team statistics",
  "analytics.view.all": "View company statistics",
  "audit.view": "View audit logs",
};

export type SystemRoleKey = "admin" | "manager" | "user" | "viewer";

export const SYSTEM_ROLES: Record<SystemRoleKey, { name: string; rank: number; description: string; permissions: Permission[] }> = {
  admin: {
    name: "Company Admin",
    rank: 10,
    description: "Full access to company settings, integrations, templates and all documents.",
    permissions: ALL_PERMISSIONS,
  },
  manager: {
    name: "Manager",
    rank: 20,
    description: "Manages team documents and views team statistics.",
    permissions: [
      "org.users.view",
      "templates.view",
      "documents.view.own",
      "documents.view.team",
      "documents.create",
      "documents.edit.own",
      "documents.edit.team",
      "documents.publish",
      "documents.send",
      "documents.archive",
      "analytics.view.team",
    ],
  },
  user: {
    name: "User",
    rank: 30,
    description: "Creates, publishes and sends their own documents.",
    permissions: [
      "templates.view",
      "documents.view.own",
      "documents.create",
      "documents.edit.own",
      "documents.publish",
      "documents.send",
    ],
  },
  viewer: {
    name: "Viewer",
    rank: 40,
    description: "Read-only access to documents and dashboards.",
    permissions: ["documents.view.all", "analytics.view.all"],
  },
};

export type AccessScope = "all" | "team" | "own" | "none";

export function viewScope(perms: ReadonlySet<string>): AccessScope {
  if (perms.has(PERMISSIONS.DOCUMENTS_VIEW_ALL)) return "all";
  if (perms.has(PERMISSIONS.DOCUMENTS_VIEW_TEAM)) return "team";
  if (perms.has(PERMISSIONS.DOCUMENTS_VIEW_OWN)) return "own";
  return "none";
}

export function editScope(perms: ReadonlySet<string>): AccessScope {
  if (perms.has(PERMISSIONS.DOCUMENTS_EDIT_ALL)) return "all";
  if (perms.has(PERMISSIONS.DOCUMENTS_EDIT_TEAM)) return "team";
  if (perms.has(PERMISSIONS.DOCUMENTS_EDIT_OWN)) return "own";
  return "none";
}

export function analyticsScope(perms: ReadonlySet<string>): AccessScope {
  if (perms.has(PERMISSIONS.ANALYTICS_VIEW_ALL)) return "all";
  if (perms.has(PERMISSIONS.ANALYTICS_VIEW_TEAM)) return "team";
  return "own";
}
