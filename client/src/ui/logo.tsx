import type { SVGProps } from 'react';
import { cn } from './cn';

/**
 * HiDNS 标识：H + 中心胶囊。
 *
 * 只有两个元素：字母 H（品牌）与正中一枚横向胶囊（那条「被解析出来的记录」）。
 * 胶囊独立居中、不与竖线相接——大尺寸下它是清晰的焦点，16px 下与竖线自然并成加粗的 H，
 * 缩小过程里不会出现「多余的小零件」。
 */
export function LogoMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn('h-5 w-5', className)} aria-hidden {...props}>
      <path d="M7.2 4.6v14.8" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
      <path d="M16.8 4.6v14.8" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
      <rect x="8.8" y="9.7" width="6.4" height="4.6" rx="2.3" fill="currentColor" />
    </svg>
  );
}

/** 带底色的图标块：壳层品牌位、登录页、落地页共用；内部标记按 0.64 缩放 */
export function LogoBadge({ className, size = 32 }: { className?: string; size?: number }) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center rounded-[0.625rem] bg-primary text-primary-foreground', className)}
      style={{ width: size, height: size }}
    >
      <LogoMark style={{ width: Math.round(size * 0.64), height: Math.round(size * 0.64) }} />
    </span>
  );
}
