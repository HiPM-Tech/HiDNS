// CSS Modules type declarations
declare module '*.css' {
  const content: Record<string, string>;
  export default content;
}

// Vite import.meta.env type augmentation
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** 'none' 关闭第三方默认背景图（自托管/内网），见 lib/theme.tsx */
  readonly VITE_DEFAULT_BACKGROUND?: string;
  readonly VITE_APP_VERSION?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
