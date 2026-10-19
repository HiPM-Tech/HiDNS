/** 触发器类型集合（保存期校验与运行期组合裁决共用同一份，避免口径漂移） */
export const ALLOWED_TRIGGERS = ['record.changed', 'domain.changed', 'ns.changed', 'whois.expiring'] as const;
export type AllowedTrigger = typeof ALLOWED_TRIGGERS[number];

/** 域名变动类触发器：禁止触发写动作（§4.0） */
export const DOMAIN_TRIGGERS: ReadonlySet<string> = new Set(['domain.changed']);

/** 域名事件允许携带的字段（与 domain-event-bus 的白名单保持一致） */
export const DOMAIN_FIELDS = ['remark', 'is_hidden', 'enabled'] as const;

export const NS_STATUSES = ['ok', 'mismatch', 'missing', 'poisoned'] as const;