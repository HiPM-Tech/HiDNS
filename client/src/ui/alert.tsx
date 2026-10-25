import * as React from 'react';
import { cn } from './cn';

/**
 * 提示条（错误 / 成功 / 警告）。
 *
 * 全站此前有 42 处把同一串 class 复制在 `role="alert"` / `role="status"` 上，
 * 改配色要改 42 个地方，且不同页面会慢慢漂移。这里收成一份：
 * 新代码用 <Alert variant="error">…</Alert>；历史 JSX 可以只把 className 换成
 * `alertVariants('error', 'mb-3')`（保留原有标签与 role）。
 */
const BASE: Record<'error' | 'success' | 'warning', string> = {
  error: 'rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive',
  success:
    'rounded-md border border-success-200 bg-success-50 px-3 py-2 text-sm text-success-700 dark:border-success-900 dark:bg-success-900/30 dark:text-success-300',
  warning:
    'rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700 dark:border-warning-900 dark:bg-warning-900/30 dark:text-warning-300',
};

export function alertVariants(variant: 'error' | 'success' | 'warning' = 'error', className?: string): string {
  return cn(BASE[variant], className);
}

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'error' | 'success' | 'warning';
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ variant = 'error', className, ...props }, ref) => (
    <div ref={ref} role={variant === 'success' ? 'status' : 'alert'} className={alertVariants(variant, className)} {...props} />
  ),
);
Alert.displayName = 'Alert';
