const root = document.querySelector<HTMLElement>('[data-admin-overview]');
if (root) {
  const message = root.querySelector<HTMLElement>('[data-overview-message]')!;
  const retry = root.querySelector<HTMLButtonElement>('[data-overview-retry]')!;
  let busy = false;
  const controller = new AbortController();
  async function data(path: string) {
    const response = await fetch(path, { cache: 'no-store', signal: controller.signal });
    if (response.status === 401) { location.replace('/admin/login/'); throw new Error('登录已过期'); }
    if (!response.ok) throw new Error('数据暂不可用');
    return (await response.json()).data;
  }
  function number(key: string, value: unknown) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('数据格式异常');
    root!.querySelector<HTMLElement>(`[data-overview-count="${key}"]`)!.textContent = value.toLocaleString('zh-CN');
  }
  async function load() {
    if (busy) return;
    busy = true; retry.hidden = true; message.textContent = '正在获取最新数据…';
    const results = await Promise.allSettled([data('/api/admin/status'), data('/api/admin/submissions?status=pending&pageSize=1')]);
    if (controller.signal.aborted) return;
    let failed = false;
    try {
      if (results[0].status !== 'fulfilled') throw new Error();
      const status = results[0].value;
      for (const key of ['sites', 'categories', 'unverified']) number(key, status.counts[key]);
      root!.querySelector<HTMLElement>('[data-overview-storage]')!.textContent = status.storage.driver === 'mysql'
        ? (status.storage.databaseConnected ? 'MySQL · 已连接' : 'MySQL · 未连接') : 'Seed · 只读种子数据';
    } catch { failed = true; root!.querySelector<HTMLElement>('[data-overview-storage]')!.textContent = '读取失败'; }
    try { if (results[1].status !== 'fulfilled') throw new Error(); number('pending', results[1].value.total); }
    catch { failed = true; root!.querySelector<HTMLElement>('[data-overview-count="pending"]')!.textContent = '—'; }
    message.textContent = failed ? '部分数据加载失败，可重试；未获取的数据不计为零。' : '数据已更新 · 当前系统运行数据';
    retry.hidden = !failed; busy = false;
  }
  retry.addEventListener('click', () => void load());
  window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
  void load();
}
