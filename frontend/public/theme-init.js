(() => {
  try {
    const locked = localStorage.getItem('dschat.dark-lock') === '1';
    const dark = locked || window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#212327' : '#ffffff');
  } catch {
    // localStorage / matchMedia 不可用时交由应用默认值处理
  }
})();
