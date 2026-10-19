import '@testing-library/dom';

// 固定语言，避免 jsdom 的 navigator.language(en-US) 让断言文本随环境漂移
localStorage.setItem('locale', 'zh-CN');

// jsdom 未实现 matchMedia / ResizeObserver，TDesign 组件在挂载时会用到
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}