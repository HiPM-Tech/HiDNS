import { describe, it, expect } from 'vitest';
import { looksPrivateOrigin } from './origin';

describe('looksPrivateOrigin（与服务端 isPrivateAddress 对齐）', () => {
  it('识别 IPv4 私网与保留段', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.1.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '100.64.0.1']) {
      expect(looksPrivateOrigin(ip), ip).toBe(true);
    }
  });

  it('公网 IPv4 不误报', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1']) {
      expect(looksPrivateOrigin(ip), ip).toBe(false);
    }
  });

  it('识别 IPv6 回环与唯一本地', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1']) {
      expect(looksPrivateOrigin(ip), ip).toBe(true);
    }
    expect(looksPrivateOrigin('2001:db8::1')).toBe(false);
  });

  it('识别本地主机名', () => {
    expect(looksPrivateOrigin('localhost')).toBe(true);
    expect(looksPrivateOrigin('printer.local')).toBe(true);
    expect(looksPrivateOrigin('example.com')).toBe(false);
  });

  it('空值与非地址不误报', () => {
    expect(looksPrivateOrigin('')).toBe(false);
    expect(looksPrivateOrigin('origin.example.com')).toBe(false);
  });
});
