import { cn } from '../../ui/cn';

/**
 * 提供商图标：服务端下发 icon 地址时用图片，否则用首字母色块兜底。
 * 图标文件由构建脚本复制到 dist，路由见 /api/accounts/providers/:type/icon。
 */
export function ProviderIcon({
  type,
  icon,
  size = 16,
  className,
}: {
  type?: string;
  icon?: string;
  size?: number;
  className?: string;
}) {
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className={cn('shrink-0 rounded-sm object-contain', className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const initial = (type ?? '?').slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center rounded-sm bg-muted text-[10px] font-medium text-muted-foreground', className)}
      style={{ width: size, height: size }}
    >
      {initial}
    </span>
  );
}