import { EmailTemplateOperations } from '../db/bal/business-adapter';
import { createLogger } from '../lib/logger';

/**
 * 邮件模板（issue #43 C3）。
 *
 * 表 email_templates 此前只有 BAL 方法、没有任何调用方，且表本身没进 schema —— 一调就 no such table。
 * 这里补上 schema、默认模板与渲染；自定义模板优先，缺失/出错时回落到默认。
 */
const log = createLogger('Service').sub('EmailTemplates');

export type EmailTemplateType = 'verification_code' | 'password_reset';

export const DEFAULT_TEMPLATES: Record<EmailTemplateType, { subject: string; body: string }> = {
  verification_code: {
    subject: 'HiDNS 邮箱验证码',
    body: [
      '你的验证码是：{{code}}',
      '',
      '{{ttlMinutes}} 分钟内有效，请勿转发给他人。',
      '如果这不是你本人的操作，请忽略本邮件。',
    ].join('\n'),
  },
  password_reset: {
    subject: 'HiDNS 密码重置',
    body: [
      '你的密码重置验证码是：{{code}}',
      '',
      '{{ttlMinutes}} 分钟内有效。',
      '如果这不是你本人的操作，请立即修改密码。',
    ].join('\n'),
  },
};

/** 变量替换：只认 {{name}}，未知变量渲染成空串 */
export function renderTemplate(
  template: { subject: string; body: string },
  vars: Record<string, string | number>,
): { subject: string; body: string } {
  const apply = (text: string) =>
    text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => String(vars[key] ?? ''));
  return { subject: apply(template.subject), body: apply(template.body) };
}

export async function getEmailTemplate(type: EmailTemplateType): Promise<{ subject: string; body: string }> {
  try {
    const row = await EmailTemplateOperations.getByType(type) as { subject?: string; body?: string } | undefined;
    if (row?.subject && row?.body) {
      return { subject: String(row.subject), body: String(row.body) };
    }
  } catch (error) {
    log.warn('Failed to load email template, falling back to default', { type, error });
  }
  return DEFAULT_TEMPLATES[type];
}

export async function renderEmailTemplate(
  type: EmailTemplateType,
  vars: Record<string, string | number>,
): Promise<{ subject: string; body: string }> {
  return renderTemplate(await getEmailTemplate(type), vars);
}