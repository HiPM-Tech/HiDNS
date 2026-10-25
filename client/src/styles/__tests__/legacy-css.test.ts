import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const cssPath = path.resolve(__dirname, '../globals.css');

describe('legacy 样式门禁（2.3.0 目标 1）', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  // 注释里可以说明历史，不算残留
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('不再包含 TDesign 选择器或变量', () => {
    expect(code).not.toMatch(/\.t-[a-z0-9_-]/i);
    expect(code).not.toMatch(/--td-/);
  });

  it('不再包含 !important', () => {
    expect(code).not.toContain('!important');
  });

  it('体积受控（旧文件曾 3080 行）', () => {
    expect(css.split('\n').length).toBeLessThan(600);
  });
});
