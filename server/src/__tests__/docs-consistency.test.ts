import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 文档自检：root.ai.md 里引用的 server/src 路径必须真实存在。
 *
 * 第四轮终审的 P1-5 就是这么暴露的——文档列了 6 个早已删除/改名的服务文件，
 * 任何人（包括 AI）按文档找代码都会扑空。这条用例把「文档引用的路径」纳入门禁。
 */
const ROOT = path.resolve(__dirname, '../../..');
const DOC = path.join(ROOT, 'root.ai.md');

/** 文档里出现的 server/src/... 路径（到 .ts 为止） */
function referencedPaths(): string[] {
  const text = fs.readFileSync(DOC, 'utf8');
  const found = new Set<string>();
  for (const match of text.matchAll(/server\/src\/[A-Za-z0-9_./-]+\.ts/g)) {
    found.add(match[0]);
  }
  return [...found];
}

describe('root.ai.md 路径自检', () => {
  it('引用的 server/src 文件都存在', () => {
    const paths = referencedPaths();
    expect(paths.length).toBeGreaterThan(10);

    const missing = paths.filter((relative) => !fs.existsSync(path.join(ROOT, relative)));
    expect(missing, '文档引用了不存在的文件：\n' + missing.join('\n')).toEqual([]);
  });

  it('文档不再引用已废弃的依赖/目录', () => {
    const text = fs.readFileSync(DOC, 'utf8');
    for (const stale of ['speakeasy', 'client/src/pages/', 'client/src/i18n/', 'tdesign']) {
      expect(text.includes(stale), 'root.ai.md 仍提到已废弃的 ' + stale).toBe(false);
    }
  });
});
