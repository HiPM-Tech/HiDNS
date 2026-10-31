import { Link } from 'react-router-dom';

// 自托管/内网可用 VITE_DEFAULT_BACKGROUND=none 关掉第三方图源（同 lib/theme.tsx）
const SHOW_REMOTE_BG = !['none', 'off', 'false', '0'].includes((import.meta.env.VITE_DEFAULT_BACKGROUND ?? '').toString().trim().toLowerCase());
import { ArrowRight, Globe2, KeyRound, Layers, LineChart, Network, ShieldCheck, Workflow } from 'lucide-react';
import { LogoBadge } from '../../ui/logo';
import { Button } from '../../ui';
import { useThemeMode } from '../../lib/theme';

const FEATURES = [
  { icon: Layers, title: '多提供商聚合', desc: '阿里云、Cloudflare、DNSPod、华为云等统一纳管，一套界面管理所有域名。' },
  { icon: Network, title: '记录与线路', desc: '按域名/线路批量维护记录，支持批量导入、状态切换与变更审计。' },
  { icon: LineChart, title: 'DDNS 与故障转移', desc: '客户端令牌直连更新；主值探测失败自动切换备用值并可回切。' },
  { icon: ShieldCheck, title: '安全与审计', desc: '2FA、通行密钥、登录限制、可信设备与全量操作审计。' },
  { icon: Globe2, title: '证书与监控', desc: 'SSL 证书到期提醒、端点可用性探测、NS 记录一致性巡检。' },
  { icon: Workflow, title: '自动化与 MCP', desc: '工作流按事件触发动作；MCP 服务让 AI 工具直接查询与操作。' },
];

const HIGHLIGHTS = [
  '单二进制 / Docker / 源码三种部署方式',
  'SQLite、MySQL、PostgreSQL 同一适配层',
  '前后端同源构建，无需额外网关',
  '中文界面，开箱即用',
];

/** 公开落地页：不依赖登录态，直接给出进入控制台的入口 */
export function LandingPage() {
  const { mode, cycle } = useThemeMode();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-content-narrow items-center gap-3 px-4">
          <LogoBadge size={28} />
          <span className="font-semibold">HiDNS</span>
          <span className="hidden text-xs text-muted-foreground sm:block">DNS 聚合管理平台</span>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={cycle} title={'主题：' + mode}>主题</Button>
            <Button size="sm" asChild>
              <Link to="/login">进入控制台 <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
        </div>
      </header>

      <main>
        {/* hero 高度锁 61.8dvh，内容按 608 : 376 ≈ φ 分栏：文字列在左，右列只放图像取景框 */}
        <section className="mx-auto grid min-h-[clamp(560px,61.8dvh,880px)] max-w-content-narrow items-center gap-0 px-phi-9 py-phi-11 lg:grid-cols-[608px_376px]">
          <div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
            <KeyRound className="h-3.5 w-3.5" /> 自托管 · 数据留在自己手里
          </span>
          <h1 className="mt-phi-6 text-hero font-semibold leading-tight">
            把散落在各家的 DNS，
            <br className="hidden sm:block" />
            收拢到一个控制台
          </h1>
          <p className="mt-phi-5 max-w-[46ch] text-base leading-relaxed text-muted-foreground">
            HiDNS 统一管理多个 DNS 提供商与账户的域名、记录与线路，提供 DDNS、故障转移、证书监控、
            团队授权与完整审计，适合自建与小型团队使用。
          </p>
          <div className="mt-phi-7 flex flex-wrap gap-phi-4">
            <Button size="lg" asChild>
              <Link to="/login">登录控制台 <ArrowRight className="h-4 w-4" /></Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <a href="#features">了解更多</a>
            </Button>
          </div>
          <ul className="mt-phi-8 grid gap-phi-3 text-sm text-muted-foreground sm:grid-cols-2">
            {HIGHLIGHTS.map((item) => (
              <li key={item} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
          </div>
          {/* 右列：把默认背景图当成构图元素，而不是整页铺满（正文压图必然牺牲可读性） */}
          <div className="hidden aspect-[376/608] overflow-hidden rounded-xl border border-border/60 shadow-lg lg:block" aria-hidden>
            {SHOW_REMOTE_BG && (
              <img src="https://t.hinswu.top/pixiv" alt="" className="h-full w-full object-cover" loading="lazy" />
            )}
          </div>
        </section>

        <section id="features" className="border-t border-border/60 bg-muted/30">
          <div className="mx-auto max-w-content-narrow px-4 py-14">
            <h2 className="text-heading font-semibold">核心能力</h2>
            <p className="mt-1 text-sm text-muted-foreground">覆盖从解析维护到安全审计的日常运维路径。</p>
            <div className="mt-6 grid gap-phi-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => {
                const Icon = feature.icon;
                return (
                  <article key={feature.title} className="rounded-lg border border-border bg-card p-4">
                    <span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="h-4 w-4" />
                    </span>
                    <h3 className="mt-3 text-sm font-medium">{feature.title}</h3>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{feature.desc}</p>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-content-narrow px-4 py-14">
          <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card p-6 sm:flex-row sm:items-center">
            <div>
              <h2 className="text-base font-semibold">准备好了吗？</h2>
              <p className="mt-1 text-sm text-muted-foreground">首次启动会引导创建管理员账户，之后即可添加 DNS 账户与域名。</p>
            </div>
            <Button className="sm:ml-auto" asChild>
              <Link to="/login">开始使用 <ArrowRight className="h-4 w-4" /></Link>
            </Button>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-content-narrow flex-col gap-2 px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <span>HiDNS · 自托管 DNS 聚合管理平台</span>
          <span className="sm:ml-auto">MIT License</span>
        </div>
      </footer>
    </div>
  );
}
