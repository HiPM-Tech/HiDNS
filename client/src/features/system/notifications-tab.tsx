import { useState } from 'react';
import { alertVariants } from '../../ui/alert';
import { AlertTriangle, Bell, Loader2, Plus, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent,
  DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, Label, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue, Skeleton, Switch,
} from '../../ui';
import { useChannels, useSaveChannels } from './use-network-tab';
import { CHANNEL_TYPE_LABELS, defaultChannelConfig, type NotificationChannel, type NotificationChannelType } from './network-api';

const EMPTY_CHANNEL: NotificationChannel = { id: '', type: 'webhook', name: '', enabled: true, config: {} };

export function SystemNotificationsTab() {
  const channels = useChannels();
  const save = useSaveChannels();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NotificationChannel | null>(null);

  const rows = channels.data ?? [];

  const persist = async (next: NotificationChannel[], success: string) => {
    setError(null);
    try {
      await save.mutateAsync(next);
      setEditing(null);
      return success;
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
      return null;
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2"><Bell className="h-4 w-4" /> 通知渠道</CardTitle>
          <CardDescription>域名到期、异常操作等事件的推送目标；可同时启用多个渠道。</CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing({ ...EMPTY_CHANNEL, config: defaultChannelConfig('webhook') })}>
          <Plus className="h-4 w-4" />新增渠道
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {error && (
          <div role="alert" className={alertVariants('error', 'flex items-center gap-2')}>
            <AlertTriangle className="h-4 w-4" /> {error}
          </div>
        )}

        {channels.isLoading ? <Skeleton className="h-20" /> : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">还没有通知渠道</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((channel) => (
              <li key={channel.id} className="flex items-center gap-3 py-2.5 text-sm">
                <Badge variant="secondary">{CHANNEL_TYPE_LABELS[channel.type] ?? channel.type}</Badge>
                <span className="min-w-0 flex-1 truncate font-medium">{channel.name || '(未命名)'}</span>
                <Switch
                  checked={Boolean(channel.enabled)}
                  aria-label={(channel.name || channel.id) + ' 启用状态'}
                  onCheckedChange={(checked) => {
                    void persist(rows.map((item) => (item.id === channel.id ? { ...item, enabled: checked } : item)), '');
                  }}
                />
                <Button variant="ghost" size="sm" onClick={() => setEditing({ ...channel, config: { ...channel.config } })}>编辑</Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:bg-destructive/10"
                  aria-label={'删除 ' + (channel.name || channel.id)}
                  onClick={() => void persist(rows.filter((item) => item.id !== channel.id), '')}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {editing && (
          <ChannelDialog
            channel={editing}
            onClose={() => setEditing(null)}
            onSubmit={async (next) => {
              const exists = rows.some((item) => item.id === next.id);
              const payload = exists ? rows.map((item) => (item.id === next.id ? next : item)) : [...rows, next];
              await persist(payload, '');
            }}
            pending={save.isPending}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ChannelDialog({ channel, onClose, onSubmit, pending }: {
  channel: NotificationChannel;
  onClose: () => void;
  onSubmit: (channel: NotificationChannel) => Promise<void>;
  pending: boolean;
}) {
  const [draft, setDraft] = useState<NotificationChannel>(channel);

  const setType = (type: NotificationChannelType) => {
    setDraft({ ...draft, type, config: defaultChannelConfig(type) });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{channel.id ? '编辑通知渠道' : '新增通知渠道'}</DialogTitle>
          <DialogDescription>渠道保存后立即用于新事件；测试发送请在对应服务侧验证。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-phi-6 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="channel-type">类型</Label>
              <Select value={draft.type} onValueChange={(value) => setType(value as NotificationChannelType)}>
                <SelectTrigger id="channel-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(CHANNEL_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="channel-name">名称</Label>
              <Input id="channel-name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：运维群" />
            </div>
          </div>

          {Object.keys(draft.config).map((key) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={'channel-' + key}>{key}</Label>
              <Input
                id={'channel-' + key}
                type={key.toLowerCase().includes('token') || key.toLowerCase().includes('secret') ? 'password' : 'text'}
                value={draft.config[key] ?? ''}
                onChange={(event) => setDraft({ ...draft, config: { ...draft.config, [key]: event.target.value } })}
              />
            </div>
          ))}

          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <span className="text-sm">启用该渠道</span>
            <Switch checked={draft.enabled} onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked })} aria-label="启用该渠道" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button
            size="sm"
            disabled={pending || !draft.name.trim()}
            onClick={() => void onSubmit({ ...draft, id: draft.id || ('ch-' + Date.now()) })}
          >
            {pending && <Loader2 className="animate-spin" />}保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
