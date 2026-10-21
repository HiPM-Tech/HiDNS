import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Space, TagInput } from 'tdesign-react';
import { InternetIcon } from 'tdesign-icons-react';
import { settingsApi } from '../../api';
import { useToast } from '../../hooks/useToast';
import { useI18n } from '../../contexts/I18nContext';

/**
 * 工作流出站白名单（设计 §5.5.1）
 *
 * 这一项此前只有后端接口、没有任何界面：管理员找不到入口，
 * 白名单恒为空，`http.outbound.fetch` 永远被判 NOT_ALLOWLISTED。
 * 这里补上维护入口，并把「空白名单 = 禁止一切出站」这类容易踩的语义直接写在界面上。
 */
export function WorkflowTab() {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);

  const query = useQuery({
    queryKey: ['workflow-http-allowlist'],
    queryFn: () => settingsApi.getWorkflowHttpAllowlist(),
  });

  // 必须 memo：`?? []` 每次渲染都会产生新数组，
  // 直接放进 effect 依赖会形成 setState → 重渲染 → 新数组 → setState 的死循环。
  const remote = useMemo(
    () => (query.data?.data?.data as { allowlist?: string[] } | undefined)?.allowlist ?? [],
    [query.data],
  );

  useEffect(() => {
    if (!dirty) setDraft(remote);
  }, [remote, dirty]);

  const mutation = useMutation({
    mutationFn: (allowlist: string[]) => settingsApi.updateWorkflowHttpAllowlist(allowlist),
    onSuccess: () => {
      setDirty(false);
      toast.success(t('system.workflow.saved'));
      queryClient.invalidateQueries({ queryKey: ['workflow-http-allowlist'] });
      queryClient.invalidateQueries({ queryKey: ['workflow-allowlist'] });
    },
    onError: (error: any) => {
      const message = error?.response?.data?.msg || error?.message || t('system.workflow.saveFailed');
      toast.error(message);
    },
  });

  const handleChange = (value: any) => {
    const next = Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
    setDraft(next);
    setDirty(true);
  };

  return (
    <Card
      bordered={false}
      shadow={false}
      title={<Space align="center"><InternetIcon />{t('system.workflow.allowlistTitle')}</Space>}
      loading={query.isLoading}
    >
      <Alert theme="info" message={t('system.workflow.allowlistHint')} />

      <div style={{ marginTop: 16 }}>
        <TagInput
          value={draft}
          onChange={handleChange}
          placeholder={t('system.workflow.allowlistPlaceholder')}
          clearable
          excessTagsDisplayType="break-line"
        />
      </div>

      <Alert
        theme="warning"
        style={{ marginTop: 16 }}
        message={t('system.workflow.allowlistFailClosed')}
      />

      <Space style={{ marginTop: 16 }}>
        <Button
          theme="primary"
          loading={mutation.isPending}
          disabled={!dirty}
          onClick={() => mutation.mutate(draft)}
        >
          {t('common.save')}
        </Button>
        <Button
          variant="outline"
          disabled={!dirty || mutation.isPending}
          onClick={() => { setDraft(remote); setDirty(false); }}
        >
          {t('common.cancel')}
        </Button>
      </Space>
    </Card>
  );
}
