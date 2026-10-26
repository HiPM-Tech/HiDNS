import { TokenOperations } from '../db/bal/business-adapter';
import { readAllowedServices } from './token-permissions';

/** Idempotent on every DSM initialization, not just pre-DSM legacy installations. */
export async function migrateTokenServicePermissions(): Promise<void> {
  let afterId = 0;
  for (;;) {
    const rows = await TokenOperations.getServicePermissionBatch(afterId);
    if (rows.length === 0) return;
    for (const row of rows) {
      afterId = Number(row.id);
      let value: unknown;
      try {
        value = typeof row.allowed_services === 'string' ? JSON.parse(row.allowed_services) : row.allowed_services;
      } catch {
        // A corrupt credential must fail authentication, not prevent the entire database from starting.
        continue;
      }
      if (Array.isArray(value)) {
        await TokenOperations.updateByUser(Number(row.id), Number(row.user_id), {
          allowed_services: JSON.stringify(readAllowedServices(value)),
        });
      }
    }
  }
}
