import { useState, useMemo, useEffect, useCallback, type ReactNode } from 'react';
import { Alert, Button, Input, Select, Space } from 'tdesign-react';
import type { SelectValue } from 'tdesign-react/es/select';
import type { DnsRecord, DnsLine, Provider } from '../api';
import { useToast } from '../hooks/useToast';
import { useI18n } from '../contexts/I18nContext';
import type { RecordType, RecordTypeDef } from '../types/record-types';
import { DOMAIN_VALUE_TYPES, PROXIABLE_RECORD_TYPES, validateRecordValue, getRecordTypeDef } from '../types/record-types';
import type { ExtraFieldDef } from '../types/record-types';
import './RecordForm.css';

function FormItem({ label, status, tips, children }: { label?: ReactNode; status?: 'error' | 'warning' | 'success'; tips?: ReactNode; children: ReactNode }) {
  return (
    <div className={`record-form__item${status === 'error' ? ' record-form__item--error' : ''}`}>
      {label && <div className="record-form__item-label">{label}</div>}
      <div className="record-form__item-content">
        {children}
        {tips && <div className={`record-form__item-tips${status === 'error' ? ' record-form__item-tips--error' : ''}`}>{tips}</div>}
      </div>
    </div>
  );
}

export interface RecordFormProps {
  domainId: number;
  lines: DnsLine[];
  recordTypes: RecordType[];
  provider?: Provider;
  initial?: DnsRecord;
  existingRecords?: DnsRecord[];
  onSubmit: (data: Partial<DnsRecord>) => void;
  isLoading: boolean;
}

interface SrvFields {
  priority: number;
  weight: number;
  port: string;
  target: string;
}

const PREFIX_SKIP_KEYS = new Set(['mx', 'value', 'port']);

function getPrefixKeys(typeDef: RecordTypeDef | undefined): string[] {
  if (!typeDef?.extraFields) return [];
  return typeDef.extraFields.filter(f => !PREFIX_SKIP_KEYS.has(f.key)).map(f => f.key);
}

function composeValue(typeDef: RecordTypeDef | undefined, mainValue: string, mx: number, weight: number, extraValues: Record<string, string | number>): string {
  const keys = getPrefixKeys(typeDef);
  if (!keys.length) return mainValue;
  const prefix = keys.map(k => {
    if (k === 'priority' || k === 'mx') return mx;
    if (k === 'weight') return weight;
    return extraValues[k] ?? 0;
  }).join(' ');
  return `${prefix} ${mainValue}`.trim();
}

function parseInitialValue(initial: DnsRecord | undefined, typeDef: RecordTypeDef | undefined): { mainValue: string; extraValues: Record<string, string | number> } {
  const result: Record<string, string | number> = {};
  const keys = getPrefixKeys(typeDef);
  if (!keys.length || !initial?.value) return { mainValue: initial?.value ?? '', extraValues: result };

  const parts = initial.value.trim().split(/\s+/);
  for (let i = 0; i < keys.length && i < parts.length; i++) {
    const n = Number(parts[i]);
    result[keys[i]] = Number.isFinite(n) ? n : parts[i];
  }
  return { mainValue: parts.slice(keys.length).join(' '), extraValues: result };
}

function isRecordHost(value: string): boolean {
  const normalized = value.trim();
  if (normalized === '@') return true;
  if (normalized === '*') return true;

  const labels = normalized.split('.');

  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    
    if (label.length === 0 || label.length > 63) {
      return false;
    }

    if (label === '*') {
      if (i !== 0) return false;
      continue;
    }

    if (/[^\x00-\x7F]/.test(label)) {
      try {
        const url = new URL(`http://${label}.example.com`);
        const punycodeLabel = url.hostname.replace('.example.com', '');

        if (punycodeLabel.startsWith('xn--')) {
          if (!/^xn--[a-z0-9-]+$/i.test(punycodeLabel)) {
            return false;
          }
        }
      } catch {
        return false;
      }
    } else {
      if (!/^[a-zA-Z0-9_]([a-zA-Z0-9-_]{0,61}[a-zA-Z0-9_])?$/i.test(label)) {
        return false;
      }
    }
  }

  return true;
}

function parseSrvValue(initial?: DnsRecord): SrvFields {
  const raw = (initial?.value ?? '').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  
  if (parts.length === 4 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) {
    return {
      priority: parseInt(parts[0], 10),
      weight: parseInt(parts[1], 10),
      port: parts[2],
      target: parts[3],
    };
  }

  return {
    priority: initial?.mx ?? 10,
    weight: initial?.weight ?? 10,
    port: parts[0] ?? '',
    target: parts.slice(1).join(' ') ?? '',
  };
}

export function RecordForm({ lines, recordTypes, provider, initial, existingRecords = [], onSubmit, isLoading }: RecordFormProps) {
  const toast = useToast();
  const { t } = useI18n();
  
  const isVPS8 = provider?.type === 'vps8';
  const providerType = provider?.type ?? '';
  const proxiable = provider?.capabilities?.dns?.proxiable === true;
  const hasMultiLine = lines.length > 1 && !proxiable;
  
  const defaultLine = useMemo(() => {
    if (proxiable) return '0';
    if (hasMultiLine && lines.length > 0) return String(lines[0]?.id ?? '0');
    return '0';
  }, [proxiable, hasMultiLine, lines]);

  const formKey = initial?.id ?? 'create';

  const [name, setName] = useState(initial?.name ?? '@');
  const [type, setType] = useState(initial?.type ?? 'A');
  const [value, setValue] = useState(initial?.value ?? '');
  const [ttl, setTtl] = useState(initial?.ttl ?? 600);
  const [mx, setMx] = useState(initial?.mx ?? 10);
  const [weight, setWeight] = useState(initial?.weight ?? 10);
  const [line, setLine] = useState(initial?.line ?? defaultLine);
  const [remark, setRemark] = useState(initial?.remark ?? '');
  const [srv, setSrv] = useState<SrvFields>(() => parseSrvValue(initial));
  const [extraValues, setExtraValues] = useState<Record<string, string | number>>({});
  const [errors, setErrors] = useState<Partial<Record<'name' | 'value' | 'ttl' | 'mx' | 'weight' | 'srvPort' | 'srvTarget', string>>>({});

  useEffect(() => {
    if (initial) {
      setName(initial.name ?? '@');
      setType(initial.type ?? 'A');
      setTtl(initial.ttl ?? 600);
      setMx(initial.mx ?? 10);
      setWeight(initial.weight ?? 10);
      setLine(initial.line ?? defaultLine);
      setRemark(initial.remark ?? '');
      setSrv(parseSrvValue(initial));
      setErrors({});
      const parsed = parseInitialValue(initial, getRecordTypeDef(initial.type));
      setValue(parsed.mainValue);
      setExtraValues(parsed.extraValues);
    }
  }, [formKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!initial) {
      setLine(prev => prev === '0' ? defaultLine : prev);
    }
  }, [defaultLine, initial]);

  // Initialize dynamic extra field defaults when type changes
  useEffect(() => {
    setExtraValues((prev) => {
      const next = { ...prev };
      for (const f of typeDef?.extraFields ?? []) {
        if (!PREFIX_SKIP_KEYS.has(f.key) && !(f.key in next) && f.defaultValue !== undefined) {
          next[f.key] = f.defaultValue;
        }
      }
      return next;
    });
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = useCallback((k: string, v: unknown) => {
    switch (k) {
      case 'name': setName(v as string); break;
      case 'type': setType(v as RecordType); break;
      case 'value': setValue(v as string); break;
      case 'ttl': setTtl(v as number); break;
      case 'mx': setMx(v as number); break;
      case 'weight': setWeight(v as number); break;
      case 'line': setLine(v as string); break;
      case 'remark': setRemark(v as string); break;
    }
    setErrors((current) => ({ ...current, [k as keyof typeof current]: undefined }));
  }, []);

  const toSelectString = useCallback((value: SelectValue) => String(Array.isArray(value) ? value[0] ?? '' : value), []);

  const currentType = type ?? 'A';
  const typeDef = getRecordTypeDef(currentType);
  const isSrv = currentType === 'SRV';

  const handleTypeChange = useCallback((value: SelectValue) => {
    const nextType = toSelectString(value);
    set('type', nextType);
    if (nextType !== 'SRV') {
      setErrors((current) => ({ ...current, srvPort: undefined, srvTarget: undefined, weight: undefined }));
    }
  }, [toSelectString, set]);

  const handleLineChange = useCallback((value: SelectValue) => {
    set('line', toSelectString(value));
  }, [set, toSelectString]);
  
  const canSelectProxy = proxiable
    ? (providerType === 'cloudflare'
      ? (initial && initial.type === currentType && initial.cloudflare?.proxiable !== undefined
        ? Boolean(initial.cloudflare.proxiable)
        : initial && initial.type === currentType && initial.proxiable !== null && initial.proxiable !== undefined
          ? Boolean(initial.proxiable)
        : PROXIABLE_RECORD_TYPES.has(currentType))
      : true)
    : true;

  const normalizedSrvValue = useMemo(() => {
    const priority = Number(mx ?? srv.priority);
    const recordWeight = Number(weight ?? srv.weight);
    const port = srv.port.trim();
    const target = srv.target.trim();
    if (!port || !target) return '';
    return `${priority} ${recordWeight} ${port} ${target}`;
  }, [mx, weight, srv.port, srv.target, srv.priority, srv.weight]);

  const validate = () => {
    const nextErrors: typeof errors = {};
    const nameVal = (name ?? '').toString().trim();
    const valueVal = (value ?? '').toString().trim();
    const ttlVal = Number(ttl ?? 0);

    if (!nameVal) nextErrors.name = t('records.hostRequired');
    else if (!isRecordHost(nameVal)) nextErrors.name = t('records.hostInvalid');
    else if (currentType === 'CNAME') {
      const hasConflict = existingRecords.some((r) => r.name === nameVal && r.id !== initial?.id);
      const isRoot = nameVal === '@';
      if ((isRoot || hasConflict) && !provider?.capabilities?.dns?.cnameFlattening) {
        nextErrors.name = t('records.cnameConflict');
      }
    } else {
      const hasCname = existingRecords.some((r) => r.name === nameVal && r.id !== initial?.id && r.type === 'CNAME');
      if (hasCname && !provider?.capabilities?.dns?.cnameFlattening) {
        nextErrors.name = t('records.cnameConflict');
      }
    }

    if (!Number.isFinite(ttlVal) || ttlVal < 1) nextErrors.ttl = t('records.invalidTtl');

    if (currentType === 'MX' || currentType === 'SRV') {
      const priority = Number(mx ?? 0);
      if (!Number.isFinite(priority) || priority < 0) nextErrors.mx = t('records.invalidPriority');
    }

    if (currentType === 'SRV') {
      const weightVal = Number(weight ?? 0);
      if (!Number.isFinite(weightVal) || weightVal < 0) nextErrors.weight = t('records.invalidWeight');
      if (!srv.port.trim()) nextErrors.srvPort = t('records.invalidSrvPortRequired');
      else if (!/^\d+$/.test(srv.port.trim()) || Number(srv.port.trim()) < 1 || Number(srv.port.trim()) > 65535) {
        nextErrors.srvPort = t('records.invalidSrvPort');
      }
      if (!srv.target.trim()) nextErrors.srvTarget = t('records.invalidSrvTargetRequired');
      else {
        const srvErr = validateRecordValue('CNAME', srv.target.trim());
        if (srvErr) nextErrors.srvTarget = srvErr;
      }
    }

    // Validate prefix extra fields
    const prefixKeys = getPrefixKeys(typeDef);
    for (const k of prefixKeys) {
      const f = typeDef?.extraFields?.find(ef => ef.key === k);
      if (!f) continue;
      let val: string | number;
      if (k === 'priority' || k === 'mx') val = mx;
      else if (k === 'weight') val = weight;
      else val = extraValues[k] ?? '';
      if (!val || (typeof val === 'number' && !Number.isFinite(val))) {
        const errKey = k === 'priority' ? 'mx' : k;
        (nextErrors as Record<string, string>)[errKey] = `${f.label} is required`;
      }
    }

    // Validate main value
    let submitValue: string;
    if (isSrv) {
      if (!srv.port.trim() || !srv.target.trim()) submitValue = '';
      else submitValue = normalizedSrvValue;
    } else {
      submitValue = composeValue(typeDef, valueVal, mx, weight, extraValues);
    }
    const valueErr = submitValue ? validateRecordValue(currentType, submitValue) : 'Value is required';
    if (valueErr) nextErrors.value = valueErr;

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const submitRecord = () => {
    if (!validate()) {
      toast.error(t('records.fixErrors'));
      return;
    }

    const lineValue = canSelectProxy ? line : undefined;
    const valueVal = (value ?? '').toString().trim();
    const payload: Partial<DnsRecord> = {
      name: (name ?? '').toString().trim(),
      type,
      value: isSrv ? normalizedSrvValue : composeValue(typeDef, valueVal, mx, weight, extraValues),
      ttl: Number(ttl ?? 600),
      mx: (currentType === 'MX' || currentType === 'SRV') ? Number(mx ?? 0) : undefined,
      weight: currentType === 'SRV' ? Number(weight ?? 0) : undefined,
      line: lineValue,
      cloudflare: (providerType === 'cloudflare' && canSelectProxy && lineValue !== undefined) ? { proxied: lineValue === '1' } : undefined,
      aliyunesa: (providerType === 'aliyunesa' && canSelectProxy && lineValue !== undefined) ? { proxied: lineValue === '1' } : undefined,
      remark: (remark ?? '').toString() ?? '',
    };

    onSubmit(payload);
  };

  const recordTypeOptions = useMemo(
    () => recordTypes.map((type) => ({ label: type, value: type })),
    [recordTypes],
  );

  // 华为云不支持修改线路
  const isLineDisabled = providerType === 'huawei' && formKey !== 'create';

  // lineOptions 必须缓存，否则每次按键都会让线路下拉重新渲染上千条
  const lineOptions = useMemo(() => {
    if (proxiable) {
      return [
        { label: t('records.dnsOnly'), value: '0' },
        { label: t('records.proxied'), value: '1' },
      ];
    }
    if (hasMultiLine) {
      return lines.map((line) => ({ label: line.name || line.id, value: String(line.id) }));
    }
    return [{ label: t('records.defaultLine') || '默认', value: '0' }];
  }, [proxiable, hasMultiLine, lines, t]);
  const firstLine = lineOptions[0];

  // 线路数较多时启用搜索过滤，避免下拉面板过长导致难以定位
  // 注意：TDesign Select 的 scroll.type='virtual' 不响应滚轮（仅响应滚动条拖动），
  // 会让用户感觉"无法滑动"，故这里不启用虚拟滚动，仅保留 filterable 让用户搜索过滤。
  const lineNeedsFilter = lineOptions.length > 30;

  const valuePlaceholder = typeDef?.valueType === 'ipv4' ? '192.168.1.1'
    : typeDef?.valueType === 'ipv6' ? '2400:3200::1'
    : typeDef?.valueType === 'hostname' ? 'example.com'
    : t('records.valuePlaceholder');

  const valueLabel = t('records.valueLabel');

  function renderNumericField(f: ExtraFieldDef, val: string | number, onChange: (v: unknown) => void) {
    const errKey = f.key === 'priority' ? 'mx' : f.key;
    const labelKey = `records.${errKey}`;
    const translated = t(labelKey);
    const displayLabel = translated.startsWith('records.') ? f.label : translated;
    return (
      <FormItem key={f.key} label={displayLabel} status={(errors as Record<string, string>)[errKey] ? 'error' : undefined} tips={(errors as Record<string, string>)[errKey]}>
        <Input
          type="number"
          value={String(val)}
          onChange={onChange}
          status={(errors as Record<string, string>)[errKey] ? 'error' : undefined}
        />
      </FormItem>
    );
  }

  const extraFieldSections = (typeDef?.extraFields ?? []).filter(f => !PREFIX_SKIP_KEYS.has(f.key));

  return (
    <form
      className="record-form"
      onSubmit={(e: any) => {
        e?.preventDefault();
        submitRecord();
      }}
    >
      <div className="record-form__grid record-form__grid--two">
        <FormItem
          label={(
            <span>
              {t('records.hostName')}
              {isVPS8 && initial && <span className="record-form__label-note">({t('records.cannotModifyHost') || '不可修改'})</span>}
            </span>
          )}
          status={errors.name ? 'error' : undefined}
          tips={errors.name || (isVPS8 && initial ? t('records.vps8HostHint') || 'VPS8 不支持修改主机名' : undefined)}
        >
          <Input
            clearable
            name={initial ? `record-host-${initial.id}` : 'record-host-create'}
            autocomplete="off"
            value={String(name ?? '')}
            onChange={(value: any) => set('name', String(value))}
            placeholder={t('records.hostPlaceholder')}
            disabled={isVPS8 && !!initial}
            status={errors.name ? 'error' : undefined}
          />
        </FormItem>
        <FormItem label={t('common.type')}>
          <Select
            value={String(type ?? 'A')}
            options={recordTypeOptions}
            onChange={handleTypeChange}
          />
        </FormItem>
      </div>

      {isSrv ? (
        <div className="record-form__section">
          <Alert theme="info" message={t('records.srvHelp')} />
          <div className="record-form__grid record-form__grid--two">
            {renderNumericField(
              { key: 'priority', label: t('records.priority'), dataType: 'number', required: true, min: 0, max: 65535, defaultValue: 10 },
              mx, (v: any) => set('mx', Number(v)),
            )}
            {renderNumericField(
              { key: 'weight', label: t('records.weight'), dataType: 'number', required: true, min: 0, max: 65535, defaultValue: 10 },
              weight, (v: any) => set('weight', Number(v)),
            )}
          </div>
          <div className="record-form__grid record-form__grid--two">
            <FormItem label={t('records.port')} status={errors.srvPort ? 'error' : undefined} tips={errors.srvPort}>
              <Input
                type="number"
                value={srv.port}
                onChange={(value: any) => {
                  setSrv((current) => ({ ...current, port: String(value) }));
                  setErrors((current) => ({ ...current, srvPort: undefined, value: undefined }));
                }}
                placeholder="443"
                status={errors.srvPort ? 'error' : undefined}
              />
            </FormItem>
            <FormItem label={t('records.target')} status={errors.srvTarget ? 'error' : undefined} tips={errors.srvTarget}>
              <Input
                clearable
                value={srv.target}
                onChange={(value: any) => {
                  setSrv((current) => ({ ...current, target: String(value) }));
                  setErrors((current) => ({ ...current, srvTarget: undefined, value: undefined }));
                }}
                placeholder="service.example.com"
                status={errors.srvTarget ? 'error' : undefined}
              />
            </FormItem>
          </div>
          <FormItem label={t('records.preview')} status={errors.value ? 'error' : undefined} tips={errors.value}>
            <div className="record-form__preview">
              {normalizedSrvValue || 'port target'}
            </div>
          </FormItem>
        </div>
      ) : (
        <FormItem label={valueLabel} status={errors.value ? 'error' : undefined} tips={errors.value}>
          <Input
            clearable
            name={initial ? `record-value-${initial.id}` : 'record-value-create'}
            autocomplete="off"
            value={String(value ?? '')}
            onChange={(value: any) => set('value', value)}
            placeholder={valuePlaceholder}
            status={errors.value ? 'error' : undefined}
          />
        </FormItem>
      )}

      <div className={`record-form__grid ${extraFieldSections.length > 0 || canSelectProxy ? 'record-form__grid--two' : ''}`}>
        <FormItem label={t('common.ttl')} status={errors.ttl ? 'error' : undefined} tips={errors.ttl}>
          <Input
            type="number"
            value={String(ttl ?? 600)}
            onChange={(value: any) => set('ttl', Number(value))}
            status={errors.ttl ? 'error' : undefined}
          />
        </FormItem>
        {extraFieldSections.map(f => renderNumericField(f,
          f.key === 'priority' || f.key === 'mx' ? mx : f.key === 'weight' ? weight : (extraValues[f.key] ?? f.defaultValue ?? ''),
          (v: any) => {
            if (f.key === 'mx' || f.key === 'priority') { setMx(Number(v)); return; }
            if (f.key === 'weight') { setWeight(Number(v)); return; }
            setExtraValues((prev) => ({ ...prev, [f.key]: Number(v) }));
          },
        ))}
        {canSelectProxy && (
          <FormItem
            label={proxiable ? t('records.proxy') : t('common.line')}
            tips={!proxiable && !hasMultiLine ? t('records.singleLineHint') || '该提供商仅支持默认线路' : undefined}
          >
            <Select
              disabled={isLineDisabled}
              value={String(line ?? firstLine?.value ?? '0')}
              options={lineOptions}
              filterable={lineNeedsFilter}
              onChange={handleLineChange}
            />
          </FormItem>
        )}
      </div>

      <FormItem label={t('common.remark')}>
        <Input
          clearable
          value={String(remark ?? '')}
          onChange={(value: any) => set('remark', value)}
          placeholder={t('common.optionalRemark')}
        />
      </FormItem>

      {currentType === 'A' ? (
        <Alert theme="info" message={t('records.aHelp')} />
      ) : currentType === 'AAAA' ? (
        <Alert theme="info" message={t('records.aaaaHelp')} />
      ) : DOMAIN_VALUE_TYPES.has(currentType) ? (
        <Alert theme="info" message={t('records.hostnameHelp', { type: currentType })} />
      ) : currentType === 'TXT' ? (
        <Alert theme="info" message={t('records.txtHelp')} />
      ) : null}

      <Space className="record-form__actions" align="center">
        <Button type="submit" theme="primary" loading={isLoading}>
          {initial ? t('common.saveChanges') : t('records.addRecord')}
        </Button>
      </Space>
    </form>
  );
}
