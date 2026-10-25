import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BatchImportDialog, parseBatchLine } from '../batch-import-dialog';
import * as api from '../api';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, batchCreateRecords: vi.fn() };
});

describe('BatchImportDialog 与后端逐条结果契约', () => {
  beforeEach(() => vi.clearAllMocks());

  it('按服务端 results 逐条展示失败行，并指回原始行号', async () => {
    const user = userEvent.setup();
    vi.mocked(api.batchCreateRecords).mockResolvedValue({
      total: 2,
      addedIds: ['r1'],
      results: [
        { line: 1, ok: true, recordId: 'r1' },
        { line: 2, ok: false, error: 'TXT 值过长' },
      ],
    });
    const onImported = vi.fn();

    render(<BatchImportDialog open onOpenChange={() => undefined} domainId={1} onImported={onImported} />);
    await user.type(screen.getByRole('textbox'), 'www A 1.2.3.4\n@ TXT abc');
    await user.click(screen.getByRole('button', { name: /导入/ }));

    await waitFor(() => expect(api.batchCreateRecords).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/成功 1 条，失败 1 条/)).toBeTruthy();
    expect(screen.getByText(/原第 2 行：TXT 值过长/)).toBeTruthy();
    expect(onImported).toHaveBeenCalled();
  });

  it('解析器仍按列数校验', () => {
    expect(parseBatchLine('www A', 0).error).toBeTruthy();
    expect(parseBatchLine('# comment', 1).payload).toBeUndefined();
  });
});
