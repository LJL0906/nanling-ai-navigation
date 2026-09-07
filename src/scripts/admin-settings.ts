/** 配置使用版本号保存；冲突保留草稿，不以自动重试覆盖他人的配置。 */
interface SettingsSnapshot {
  site: Record<string, string>;
  homeSectionPageSize: number;
  revision: string;
  writable: boolean;
}
const root = document.querySelector<HTMLElement>('[data-settings-admin]');
if (root) {
  const form = root.querySelector<HTMLFormElement>('[data-settings-form]')!;
  const fields = root.querySelector<HTMLFieldSetElement>('[data-settings-fields]')!;
  const save = root.querySelector<HTMLButtonElement>('[data-settings-save]')!;
  const refresh = root.querySelector<HTMLButtonElement>('[data-settings-refresh]')!;
  const message = root.querySelector<HTMLElement>('[data-settings-message]')!;
  const login = root.querySelector<HTMLElement>('[data-settings-login]')!;
  const keys = ['name', 'url', 'slogan', 'heroTitle', 'heroSubtitle', 'description', 'keywords'];
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  let snapshot: SettingsSnapshot | undefined;
  let busy = false;
  let dirty = false;
  function status(text: string, error = false) {
    message.textContent = text;
    message.dataset.error = String(error);
  }
  function lock(value: boolean) {
    busy = value;
    fields.disabled = value || !snapshot?.writable;
    save.disabled = value || !snapshot?.writable;
    refresh.disabled = value;
    form.setAttribute('aria-busy', String(value));
  }
  function apply(data: SettingsSnapshot) {
    snapshot = data;
    for (const key of keys) input(key).value = data.site[key];
    input('homeSectionPageSize').value = String(data.homeSectionPageSize);
    dirty = false;
  }
  async function request(init?: RequestInit): Promise<SettingsSnapshot> {
    const response = await fetch('/api/admin/settings', { credentials: 'same-origin', cache: 'no-store', ...init });
    const body = await response.json();
    login.hidden = response.status !== 401;
    if (!response.ok) throw new Error(body.error?.message ?? '配置请求失败，请稍后重试。');
    const data = body.data;
    if (!data || !keys.every(key => typeof data.site?.[key] === 'string')
      || !Number.isInteger(data.homeSectionPageSize) || typeof data.revision !== 'string'
      || typeof data.writable !== 'boolean') throw new Error('配置响应异常，请重新加载。');
    return data;
  }
  async function load() {
    if (busy || (dirty && !window.confirm('重新加载将丢弃未保存的配置，是否继续？'))) return;
    lock(true);
    try {
      apply(await request());
      status(snapshot!.writable ? '配置已加载。修改后请保存。' : '当前为种子模式，只读；启用 MySQL 后可保存配置。');
    } catch (error) { status(error instanceof Error ? error.message : '配置加载失败。', true); }
    finally { lock(false); }
  }
  form.addEventListener('input', () => { dirty = true; });
  refresh.addEventListener('click', () => { void load(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !snapshot?.writable || !form.reportValidity()) return;
    const site = Object.fromEntries(keys.map(key => [key, input(key).value]));
    const command = { site, homeSectionPageSize: Number(input('homeSectionPageSize').value), revision: snapshot.revision };
    lock(true);
    try {
      apply(await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }));
      status('配置已保存。重新加载前台页面即可查看；其他已打开页面不会被强制刷新。');
    } catch (error) { status(error instanceof Error ? error.message : '保存失败，草稿已保留。', true); }
    finally { lock(false); }
  });
  window.addEventListener('beforeunload', event => {
    if (dirty) { event.preventDefault(); event.returnValue = ''; }
  });
  void load();
}
export {};
