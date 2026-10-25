import type { ReactNode } from 'react';
import { formatDate } from '../../lib/format';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, ExternalLink, Github, Info, MessageCircle, Package, Tag, Users } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from '../../ui';
import { systemApi } from '../system/api';

const REPO_URL = 'https://github.com/HiPM-Tech/HiDNS';
const TELEGRAM_URL = 'https://t.me/hidns_group';
const LICENSE = 'MIT';

interface Contributor {
  login: string;
  avatar_url: string;
  html_url: string;
  contributions: number;
}

interface Release {
  tag_name: string;
  name?: string;
  html_url: string;
  published_at: string;
}

interface TechStackItem {
  name: string;
  role: string;
  url: string;
}

const TECH_STACK: TechStackItem[] = [
  { name: 'React 19', role: 'UI 框架', url: 'https://react.dev' },
  { name: 'Vite 8', role: '构建与开发服务器', url: 'https://vite.dev' },
  { name: 'TanStack Query', role: '服务端状态与缓存', url: 'https://tanstack.com/query' },
  { name: 'React Router 7', role: '路由', url: 'https://reactrouter.com' },
  { name: 'Tailwind CSS 3.4', role: '样式系统', url: 'https://tailwindcss.com' },
  { name: 'Radix UI / shadcn 风格', role: '无样式可访问组件', url: 'https://www.radix-ui.com' },
  { name: 'Express 4 + TypeScript', role: '后端服务', url: 'https://expressjs.com' },
  { name: 'SQLite / MySQL / PostgreSQL', role: '存储（适配层统一）', url: REPO_URL + '#readme' },
];

async function fetchGithub<T>(path: string): Promise<T> {
  const response = await fetch('https://api.github.com' + path, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) throw new Error('GitHub API ' + response.status);
  return (await response.json()) as T;
}

export function AboutPage() {
  const version = useQuery({ queryKey: ['system-version'], queryFn: systemApi.version, staleTime: 5 * 60_000 });
  const release = useQuery({
    queryKey: ['about-latest-release'],
    queryFn: () => fetchGithub<Release>('/repos/HiPM-Tech/HiDNS/releases/latest'),
    staleTime: 30 * 60_000,
    retry: 0,
  });
  const contributors = useQuery({
    queryKey: ['about-contributors'],
    queryFn: () => fetchGithub<Contributor[]>('/repos/HiPM-Tech/HiDNS/contributors?per_page=100'),
    staleTime: 30 * 60_000,
    retry: 0,
  });

  return (
    <div className="grid gap-phi-6 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Info className="h-4 w-4" /> 关于 HiDNS</CardTitle>
          <CardDescription>DNS 聚合管理平台：多提供商、多账户、域名与记录统一管理，支持 DDNS、故障转移与审计。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          {version.isLoading ? <Skeleton className="h-6 w-40" /> : (
            <>
              <Badge variant="secondary">v{version.data?.version ?? '—'}</Badge>
              <Badge variant="outline">部署模式：{version.data?.deployMode ?? '—'}</Badge>
              <Badge variant="outline">Node {version.data?.node ?? '—'}</Badge>
              <Badge variant="outline">{LICENSE} License</Badge>
            </>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer"><Github className="h-4 w-4" /> 代码仓库</a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={REPO_URL + '/releases'} target="_blank" rel="noopener noreferrer"><Tag className="h-4 w-4" /> 版本发布</a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Package className="h-4 w-4" /> 最新版本</CardTitle>
          <CardDescription>取自 GitHub Releases（未发版或超出限流时显示不可用）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {release.isLoading ? <Skeleton className="h-10" /> : release.isError ? (
            <p className="text-xs text-muted-foreground">暂时无法获取（GitHub 限流或离线环境）</p>
          ) : (
            <>
              <a className="flex items-center gap-2 font-medium text-primary hover:underline" href={release.data?.html_url} target="_blank" rel="noopener noreferrer">
                {release.data?.tag_name} <ExternalLink className="h-3.5 w-3.5" />
              </a>
              {release.data?.published_at && (
                <p className="text-xs text-muted-foreground">发布于 {formatDate(release.data.published_at)}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BookOpen className="h-4 w-4" /> 社区与文档</CardTitle>
          <CardDescription>问题反馈、使用文档与交流群</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <LinkRow href={REPO_URL + '/blob/main/README.md'} icon={<BookOpen className="h-4 w-4" />} label="使用文档（README）" />
          <LinkRow href={REPO_URL + '/issues'} icon={<MessageCircle className="h-4 w-4" />} label="问题反馈（Issues）" />
          <LinkRow href={TELEGRAM_URL} icon={<Users className="h-4 w-4" />} label="Telegram 交流群" />
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Package className="h-4 w-4" /> 技术栈</CardTitle>
          <CardDescription>前端已迁移至 React 19 + Tailwind + Radix 组件体系；后端为 Express + TypeScript 分层结构</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {TECH_STACK.map((item) => (
            <a
              key={item.name}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-border px-3 py-2 text-sm transition-colors hover:bg-accent"
            >
              <p className="font-medium">{item.name}</p>
              <p className="text-xs text-muted-foreground">{item.role}</p>
            </a>
          ))}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> 贡献者</CardTitle>
          <CardDescription>来自 GitHub 的贡献者列表</CardDescription>
        </CardHeader>
        <CardContent>
          {contributors.isLoading ? (
            <div className="flex gap-2">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-10 w-10 rounded-full" />)}</div>
          ) : contributors.isError ? (
            <p className="text-xs text-muted-foreground">暂时无法获取贡献者列表（GitHub 限流或离线环境）</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {(contributors.data ?? []).map((person) => (
                <a
                  key={person.login}
                  href={person.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent"
                  title={person.login + ' · ' + person.contributions + ' 次提交'}
                >
                  <img src={person.avatar_url} alt="" className="h-6 w-6 rounded-full" loading="lazy" />
                  <span>{person.login}</span>
                  <span className="text-muted-foreground">{person.contributions}</span>
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LinkRow({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  return (
    <a className="flex items-center gap-2 text-primary hover:underline" href={href} target="_blank" rel="noopener noreferrer">
      {icon}
      <span>{label}</span>
      <ExternalLink className="ml-auto h-3.5 w-3.5" />
    </a>
  );
}
