/** Provider credentials must never be included in account broadcasts. */
export function accountEventData<T extends Record<string, unknown>>(account: T): Omit<T, 'config'>;
export function accountEventData(account: null): null;
export function accountEventData(account: undefined): undefined;
export function accountEventData<T extends Record<string, unknown>>(account: T | null | undefined): Omit<T, 'config'> | null | undefined;
export function accountEventData<T extends Record<string, unknown>>(account: T | null | undefined): Omit<T, 'config'> | null | undefined {
  if (account == null) return account;
  const { config: _config, ...metadata } = account;
  return metadata;
}
