const {
  createTenantId,
  isValidTenantId,
  TENANT_ROLES
} = require("../tenant-context");

const TENANT_OWNED_COLLECTIONS = Object.freeze([
  "customers",
  "orders",
  "lineMessages",
  "followUpRules",
  "tags",
  "customerTags",
  "contactLogs",
  "notificationReads"
]);

const TENANT_SCOPED_SETTINGS_KEYS = Object.freeze([
  "businessName",
  "defaultJarPrice",
  "lineChannelAccessToken",
  "lineChannelId",
  "lineChannelSecret",
  "lineWebhookEnabled",
  "messageTemplates",
  "staffCanExport",
  "vipThresholds"
]);

const TENANT_PERMISSION_ROLES = Object.freeze(["Owner", "Admin", "Staff"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function defaultTenantNameFromSettings(settings = {}) {
  const candidates = [
    settings.businessName,
    settings.business_name,
    settings.business?.name,
    settings.companyName,
    settings.company_name
  ];
  const name = candidates.map(value => String(value || "").trim()).find(Boolean);
  return name || "Growup Pilot";
}

function roleFromUser(user = {}) {
  return TENANT_ROLES.includes(user.role) ? user.role : "Staff";
}

function buildDefaultTenantBackfillPlan(db = {}, options = {}) {
  const tenantId = options.tenantId || createTenantId();
  if (!isValidTenantId(tenantId)) {
    throw new Error("Default tenant backfill plan requires a valid opaque UUID tenant id.");
  }
  const tenantName = String(options.tenantName || defaultTenantNameFromSettings(db.settings || "")).trim() || "Growup Pilot";
  const users = asArray(db.users);
  const memberships = users.map(user => ({
    id: options.membershipIdForUser ? options.membershipIdForUser(user) : createTenantId(),
    tenantId,
    userId: user.id,
    role: roleFromUser(user),
    isActive: user.isActive !== false && user.is_active !== false
  }));
  const tenantSettings = TENANT_SCOPED_SETTINGS_KEYS
    .filter(key => Object.prototype.hasOwnProperty.call(db.settings || {}, key))
    .map(key => ({
      tenantId,
      key,
      value: db.settings[key]
    }));
  const tenantRolePermissions = TENANT_PERMISSION_ROLES.map(role => ({
    tenantId,
    role,
    permissions: Object.freeze({})
  }));

  return Object.freeze({
    execute: false,
    tenant: Object.freeze({
      id: tenantId,
      name: tenantName,
      status: "active"
    }),
    memberships: Object.freeze(memberships),
    tenantSettings: Object.freeze(tenantSettings),
    tenantRolePermissions: Object.freeze(tenantRolePermissions),
    counts: Object.freeze({
      users: users.length,
      customers: asArray(db.customers).length,
      orders: asArray(db.orders).length,
      lineMessages: asArray(db.lineMessages).length,
      followUpRules: asArray(db.followUpRules).length,
      tags: asArray(db.tags).length,
      customerTags: asArray(db.customerTags).length,
      contactLogs: asArray(db.contactLogs).length,
      notificationReads: asArray(db.notificationReads).length
    })
  });
}

function duplicateValues(rows, keyFn) {
  const counts = new Map();
  for (const row of asArray(rows)) {
    const key = keyFn(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));
}

function collectOrphanRecordIssues(db = {}) {
  const issues = [];
  const customerIds = new Set(asArray(db.customers).map(customer => customer.id).filter(Boolean));
  const userIds = new Set(asArray(db.users).map(user => user.id).filter(Boolean));
  for (const order of asArray(db.orders)) {
    if (!customerIds.has(order.customerId)) {
      issues.push({ collection: "orders", id: order.id, field: "customerId", value: order.customerId });
    }
    if (order.createdBy && !userIds.has(order.createdBy)) {
      issues.push({ collection: "orders", id: order.id, field: "createdBy", value: order.createdBy });
    }
  }
  for (const customer of asArray(db.customers)) {
    if (customer.assignedTo && !userIds.has(customer.assignedTo)) {
      issues.push({ collection: "customers", id: customer.id, field: "assignedTo", value: customer.assignedTo });
    }
  }
  for (const link of asArray(db.customerTags)) {
    if (!customerIds.has(link.customerId)) {
      issues.push({ collection: "customerTags", id: link.id, field: "customerId", value: link.customerId });
    }
  }
  for (const log of asArray(db.contactLogs)) {
    if (!customerIds.has(log.customerId)) {
      issues.push({ collection: "contactLogs", id: log.id, field: "customerId", value: log.customerId });
    }
  }
  return issues;
}

function collectIncompleteBackfillIssues(db = {}) {
  const issues = [];
  for (const collection of TENANT_OWNED_COLLECTIONS) {
    for (const row of asArray(db[collection])) {
      if (!row.tenantId && !row.tenant_id) {
        issues.push({ collection, id: row.id || row.notificationId || row.notification_id || "" });
      }
    }
  }
  return issues;
}

function collectUnsupportedSingletonWarnings(db = {}) {
  const warnings = [];
  const settings = db.settings || {};
  const importJobs = asArray(db.importJobs);
  const activeImportJobs = importJobs.filter(job => !["completed", "failed", "cancelled"].includes(String(job.status || "").toLowerCase()));
  if (activeImportJobs.length) {
    warnings.push({
      code: "ACTIVE_IMPORT_JOBS",
      message: "Active import jobs must be completed or cancelled before tenant backfill."
    });
  }
  for (const key of Object.keys(settings)) {
    if (/^import_active_|^import_job_/.test(key)) {
      warnings.push({
        code: "SETTINGS_IMPORT_JOB_SINGLETON",
        key,
        message: "Import job settings need tenant ownership before enforcement."
      });
    }
  }
  return warnings;
}

function validateTenantBackfillReadiness(db = {}, options = {}) {
  const errors = [];
  const warnings = [];
  const duplicateCustomerPhones = duplicateValues(db.customers, customer => normalizeKey(customer.phone));
  const duplicateTagNames = duplicateValues(db.tags, tag => normalizeKey(tag.name));
  const duplicateFollowUpJars = duplicateValues(db.followUpRules, rule => rule.jars === undefined || rule.jars === null ? "" : String(rule.jars));
  const duplicateUsernames = duplicateValues(db.users, user => normalizeKey(user.username));
  const duplicateNotificationReads = duplicateValues(db.notificationReads, read => `${read.userId || read.user_id || ""}:${read.notificationId || read.notification_id || ""}`);

  if (duplicateUsernames.length) {
    errors.push({ code: "DUPLICATE_GLOBAL_USERNAMES", rows: duplicateUsernames });
  }
  if (duplicateCustomerPhones.length) {
    errors.push({ code: "DUPLICATE_CUSTOMER_PHONES", rows: duplicateCustomerPhones });
  }
  if (duplicateTagNames.length) {
    errors.push({ code: "DUPLICATE_TAG_NAMES", rows: duplicateTagNames });
  }
  if (duplicateFollowUpJars.length) {
    errors.push({ code: "DUPLICATE_FOLLOW_UP_RULE_JARS", rows: duplicateFollowUpJars });
  }
  if (duplicateNotificationReads.length) {
    errors.push({ code: "DUPLICATE_NOTIFICATION_READS", rows: duplicateNotificationReads });
  }

  const orphanRecords = collectOrphanRecordIssues(db);
  if (orphanRecords.length) {
    errors.push({ code: "ORPHAN_TENANT_RECORDS", rows: orphanRecords });
  }

  const unsupportedSingletons = collectUnsupportedSingletonWarnings(db);
  warnings.push(...unsupportedSingletons);
  if (options.strictUnsupportedSingletons && unsupportedSingletons.length) {
    errors.push({ code: "UNSUPPORTED_SINGLETON_DATA", rows: unsupportedSingletons });
  }

  if (options.requireActiveOwner) {
    const activeOwners = asArray(db.users).filter(user => roleFromUser(user) === "Owner" && user.isActive !== false && user.is_active !== false);
    if (!activeOwners.length) {
      errors.push({ code: "NO_ACTIVE_OWNER_USER", rows: [] });
    }
  }

  const incompleteBackfills = options.requireCompleteBackfill ? collectIncompleteBackfillIssues(db) : [];
  if (incompleteBackfills.length) {
    errors.push({ code: "INCOMPLETE_TENANT_BACKFILL", rows: incompleteBackfills });
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings)
  });
}

function tenantScopedStoragePath(tenantId, objectPath = "") {
  if (!isValidTenantId(tenantId)) {
    throw new Error("Tenant-scoped storage paths require a valid tenant id.");
  }
  const cleanPath = String(objectPath || "").replace(/^\/+/, "");
  if (!cleanPath || cleanPath.includes("..")) {
    throw new Error("Tenant-scoped storage paths require a safe object path.");
  }
  return `tenants/${tenantId}/${cleanPath}`;
}

module.exports = {
  TENANT_OWNED_COLLECTIONS,
  TENANT_PERMISSION_ROLES,
  TENANT_SCOPED_SETTINGS_KEYS,
  buildDefaultTenantBackfillPlan,
  collectIncompleteBackfillIssues,
  collectOrphanRecordIssues,
  collectUnsupportedSingletonWarnings,
  createTenantId,
  defaultTenantNameFromSettings,
  isValidTenantId,
  tenantScopedStoragePath,
  validateTenantBackfillReadiness
};
