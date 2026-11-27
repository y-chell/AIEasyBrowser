import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { switchTabTool } from './common';
import { focusTabAndVerify } from '@/utils/page-visibility';
vi.mock('@/utils/page-visibility', () => ({ focusTabAndVerify: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('chrome', {
    tabs: {
      get: vi.fn(async (id) => ({ id, windowId: 9, active: true, url: 'https://fixture.test/' })),
    },
    runtime: {},
  });
});
afterEach(() => vi.unstubAllGlobals());
describe('verified tab activation response', () => {
  test.each([true, false])(
    'reports actual renderingReady=%s after an activation request',
    async (ready) => {
      vi.mocked(focusTabAndVerify).mockResolvedValue({
        activationRequested: true,
        focusRequested: true,
        renderingReady: ready,
        pageVisibility: {
          visibilityState: ready ? 'visible' : 'hidden',
          hidden: !ready,
          hasFocus: true,
        },
        ...(!ready ? { code: 'PAGE_HIDDEN' as const } : {}),
      });
      const result = await switchTabTool.execute({ tabId: 7 });
      expect(result.isError).toBe(false);
      expect(focusTabAndVerify).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7, windowId: 9 }),
      );
      const data = JSON.parse((result.content[0] as any).text);
      expect(data).toMatchObject({
        tabId: 7,
        active: true,
        focusVerification: { renderingReady: ready, pageVisibility: { hidden: !ready } },
      });
      if (!ready) expect(data.message).toContain('not confirmed');
    },
  );
  test('rejects a mismatched window before requesting focus', async () => {
    expect((await switchTabTool.execute({ tabId: 7, windowId: 8 })).isError).toBe(true);
    expect(focusTabAndVerify).not.toHaveBeenCalled();
  });
});
