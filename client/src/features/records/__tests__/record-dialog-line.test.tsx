import { describe, expect, it } from 'vitest';
import { displayLine } from '../line-options';

describe('编辑态线路展示（列表归一已下沉到服务端中间层）', () => {
  it('默认线路记录展示为「默认线路」', () => {
    expect(displayLine('0', '0')).toBe('');
    expect(displayLine('默认', '默认')).toBe('');
  });

  it('非默认线路原样展示', () => {
    expect(displayLine('电信', '默认')).toBe('电信');
    expect(displayLine(null, '默认')).toBe('');
  });
});
