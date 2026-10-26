import { DNS_TOKEN_PERMISSIONS, type AllowedServices } from '../types/token';

/** Strict validation for both API writes and persisted credentials. Never default malformed data to '*'. */
export function parseAllowedServices(input: unknown): AllowedServices {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('allowed_services must be an object mapping dns/mcp to permission arrays');
  }
  const result: AllowedServices = {};
  for (const [service, permissions] of Object.entries(input)) {
    if (service !== 'dns' && service !== 'mcp') {
      throw new Error(`Unknown token service: ${service}`);
    }
    if (!Array.isArray(permissions) || permissions.some(permission =>
      typeof permission !== 'string' || (permission !== '*' &&
        (service === 'mcp' || !(DNS_TOKEN_PERMISSIONS as readonly string[]).includes(permission))))) {
      throw new Error(`Invalid permissions for ${service}`);
    }
    // MCP has no operation-level permissions yet; use omission to disable it.
    if (service === 'mcp' && (permissions.length !== 1 || permissions[0] !== '*')) {
      throw new Error('mcp permissions must be ["*"]');
    }
    Object.assign(result, { [service]: [...new Set(permissions)] });
  }
  return result;
}

/** Historical service arrays are accepted only when reading existing database rows. */
export function readAllowedServices(value: unknown): AllowedServices {
  const input: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (Array.isArray(input)) {
    const result: AllowedServices = {};
    if (input.includes('*') || input.includes('dns')) result.dns = ['*'];
    if (input.includes('*') || input.includes('mcp')) result.mcp = ['*'];
    return result;
  }
  return parseAllowedServices(input);
}

export function allTokenServices(): AllowedServices {
  return { dns: ['*'], mcp: ['*'] };
}
