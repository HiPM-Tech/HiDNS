import { describe, it, expect, vi } from 'vitest';
import { createFacade, flattenFacadeActions } from '../facade';
import { ALL_ACTIONS } from '../actions/registry';
import type { Principal } from '../auth';

const principal: Principal = { kind: 'user', id: 'u1', role: 'admin', services: [], allowedDomains: '*' };

describe('静态 facade', () => {
  it('A7：facade 覆盖集合与注册表双向一致', () => {
    const facade = createFacade(vi.fn() as never);
    const facadeActions = flattenFacadeActions(facade as unknown as Record<string, unknown>).sort();
    const registryActions = ALL_ACTIONS.map((a) => a.name).sort();
    expect(facadeActions).toEqual(registryActions);
  });

  it('每个入口都经 dispatch，动作名精确', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const facade = createFacade(dispatch as never);
    await facade.dns.record.update(principal, { value: '1.1.1.1' });
    expect(dispatch).toHaveBeenCalledWith('dns.record.update', principal, { value: '1.1.1.1' }, undefined);
    await facade.ext.tencenteo.originGroup.replace(principal, { groupId: 'g' });
    expect(dispatch).toHaveBeenLastCalledWith('ext.tencenteo.originGroup.replace', principal, { groupId: 'g' }, undefined);
  });

  it('透传 options（trigger / triggerType / resource）', async () => {
    const dispatch = vi.fn(async () => 'ok');
    const facade = createFacade(dispatch as never);
    await facade.dns.record.update(principal, {}, { trigger: 'api', resource: { domainName: 'a.com' } });
    expect(dispatch).toHaveBeenLastCalledWith(
      'dns.record.update',
      principal,
      {},
      expect.objectContaining({ trigger: 'api', resource: { domainName: 'a.com' } }),
    );
  });
});