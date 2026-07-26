const crypto = require("crypto");

const TENANT_CONTEXT_ERROR_CODES = Object.freeze({
  REQUIRED: "TENANT_CONTEXT_REQUIRED",
  INVALID: "TENANT_CONTEXT_INVALID",
  INACTIVE: "TENANT_CONTEXT_INACTIVE",
  AMBIGUOUS: "TENANT_CONTEXT_AMBIGUOUS"
});

const TENANT_ROLES = Object.freeze(["Owner", "Admin", "Staff"]);
const ACTIVE_TENANT_STATUS = "active";

function createTenantId() {
  return crypto.randomUUID();
}

function isValidTenantId(value) {
  if (typeof value !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function tenantContextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeTenantStatus(status = "") {
  return String(status || ACTIVE_TENANT_STATUS).trim().toLowerCase();
}

function normalizeMembershipRole(role = "") {
  const normalized = String(role || "").trim();
  return TENANT_ROLES.includes(normalized) ? normalized : "";
}

function assertTenantContext(context) {
  if (!context || typeof context !== "object") {
    throw tenantContextError(TENANT_CONTEXT_ERROR_CODES.REQUIRED, "Tenant context is required.");
  }
  if (!isValidTenantId(context.tenantId)) {
    throw tenantContextError(TENANT_CONTEXT_ERROR_CODES.INVALID, "Tenant context has an invalid tenant id.");
  }
  if (!context.userId || typeof context.userId !== "string") {
    throw tenantContextError(TENANT_CONTEXT_ERROR_CODES.INVALID, "Tenant context has an invalid user id.");
  }
  if (normalizeTenantStatus(context.tenantStatus) !== ACTIVE_TENANT_STATUS) {
    throw tenantContextError(TENANT_CONTEXT_ERROR_CODES.INACTIVE, "Tenant is not active.");
  }
  if (!context.membershipId || typeof context.membershipId !== "string") {
    throw tenantContextError(TENANT_CONTEXT_ERROR_CODES.INVALID, "Tenant membership is required.");
  }
  if (context.membershipActive !== true) {
    throw tenantContextError(TENANT_CONTEXT_ERROR_CODES.INACTIVE, "Tenant membership is not active.");
  }
  if (!normalizeMembershipRole(context.role)) {
    throw tenantContextError(TENANT_CONTEXT_ERROR_CODES.INVALID, "Tenant membership role is invalid.");
  }
  return context;
}

function createTenantContext({ tenant, membership, user, permissions = {} } = {}) {
  if (!tenant || !membership || !user) {
    return assertTenantContext(null);
  }
  const context = {
    tenantId: tenant.id,
    tenantStatus: normalizeTenantStatus(tenant.status),
    userId: user.id,
    membershipId: membership.id,
    membershipActive: membership.isActive === true || membership.is_active === true,
    role: normalizeMembershipRole(membership.role),
    permissions: Object.freeze({ ...(permissions || {}) })
  };
  assertTenantContext(context);
  return Object.freeze(context);
}

function resolveSingleActiveMembership(memberships = []) {
  const activeMemberships = (Array.isArray(memberships) ? memberships : [])
    .filter(membership => membership && (membership.isActive === true || membership.is_active === true));
  if (activeMemberships.length === 0) {
    throw tenantContextError(TENANT_CONTEXT_ERROR_CODES.REQUIRED, "No active tenant membership is available.");
  }
  if (activeMemberships.length > 1) {
    throw tenantContextError(TENANT_CONTEXT_ERROR_CODES.AMBIGUOUS, "Tenant context is ambiguous.");
  }
  return activeMemberships[0];
}

module.exports = {
  ACTIVE_TENANT_STATUS,
  TENANT_CONTEXT_ERROR_CODES,
  TENANT_ROLES,
  assertTenantContext,
  createTenantContext,
  createTenantId,
  isValidTenantId,
  resolveSingleActiveMembership,
  tenantContextError
};
