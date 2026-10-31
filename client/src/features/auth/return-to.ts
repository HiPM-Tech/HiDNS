/**
 * 登录后的落点：优先 return_to（MCP 授权页等会带），但只接受站内相对路径，
 * 防止被构造成 //evil.com 或 https://… 的外跳。
 *
 * 抽成独立模块：路由守卫（app/redirect-if-authed.tsx）也要用它，
 * 免得 app/ 为了这一个函数去依赖整个登录页组件。
 */
export function resolveReturnTo(search: string): string {
  const raw = new URLSearchParams(search).get('return_to');
  if (!raw) return '/dash';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dash';
  return raw;
}
