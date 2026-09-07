import { createSubmissionAuth } from './submission-auth';
import { createSubmissionGate, fetchSubmissionJson } from './submission-request';

function initSiteSubmission() {
  const dialog = document.querySelector<HTMLDialogElement>('#submit-site-dialog');
  const openButton = document.querySelector<HTMLButtonElement>('[data-submit-site-open]');
  if (!dialog || !openButton || dialog.dataset.initialized) return;
  dialog.dataset.initialized = 'true';
  const form = dialog.querySelector<HTMLFormElement>('[data-submission-form]')!;
  const fields = form.querySelector<HTMLFieldSetElement>('fieldset')!;
  const category = form.elements.namedItem('categoryId') as HTMLSelectElement;
  const categoryLabel = form.querySelector<HTMLLabelElement>('label[for="submission-category"]')!;
  const customToggle = form.elements.namedItem('useCustomCategory') as HTMLInputElement;
  const customCategory = form.elements.namedItem('customCategory') as HTMLInputElement;
  const fileInput = form.elements.namedItem('iconFile') as HTMLInputElement;
  const iconUrl = form.elements.namedItem('iconUrl') as HTMLInputElement;
  const preview = form.querySelector<HTMLImageElement>('[data-icon-preview]')!;
  const uploadLabel = form.querySelector<HTMLElement>('[data-upload-label]')!;
  const message = form.querySelector<HTMLElement>('[data-submission-message]')!;
  const categoryStatus = form.querySelector<HTMLElement>('[data-category-status]')!;
  const submitButton = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  const submitLabel = form.querySelector<HTMLElement>('[data-submit-label]')!;
  const closeButtons = dialog.querySelectorAll<HTMLButtonElement>('[data-submission-close]');
  let iconMode = 'upload';
  let busy = false;
  let categoriesLoaded = false;
  let categoriesLoading = false;
  const gate = createSubmissionGate();
  let objectUrl = '';
  let previousOverflow = '';
  let submitted = false;
  let disposed = false;
  const toast = document.querySelector<HTMLElement>('[data-submission-toast]');
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const hideToast = () => {
    clearTimeout(toastTimer);
    if (toast) toast.textContent = '';
  };
  const showSuccessToast = () => {
    hideToast();
    if (toast) toast.textContent = '提交成功';
    toastTimer = setTimeout(hideToast, 3000);
  };
  const entryMessage = document.querySelector<HTMLElement>('[data-submission-entry-message]');
  async function checkAccount() {
    const result = await fetchSubmissionJson('/api/account/session', { credentials: 'same-origin', cache: 'no-store' }, 10_000);
    if (!result.data?.user) throw Object.assign(new Error('请先登录，再提交站点。'), { status: 401 });
  }

  const showMessage = (text: string, success = false) => {
    message.textContent = text;
    message.dataset.success = String(success);
    delete message.dataset.pending;
    message.hidden = false;
  };
  const clearPreview = () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = '';
    preview.hidden = true;
    preview.removeAttribute('src');
  };
  const setIconMode = (mode: string) => {
    iconMode = mode;
    form.querySelectorAll<HTMLButtonElement>('[data-icon-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.iconMode === mode));
    });
    form.querySelector<HTMLElement>('[data-icon-upload]')!.hidden = mode !== 'upload';
    form.querySelector<HTMLElement>('[data-icon-online]')!.hidden = mode !== 'url';
    fileInput.disabled = mode !== 'upload';
    iconUrl.disabled = mode !== 'url';
  };
  const syncCategory = () => {
    category.hidden = customToggle.checked;
    category.disabled = customToggle.checked || categoriesLoading;
    category.required = !customToggle.checked;
    customCategory.hidden = !customToggle.checked;
    customCategory.disabled = !customToggle.checked;
    customCategory.required = customToggle.checked;
    categoryLabel.htmlFor = customToggle.checked ? 'submission-custom-category' : 'submission-category';
    submitButton.disabled = busy || (categoriesLoading && !customToggle.checked);
  };
  customCategory.id = 'submission-custom-category';
  const loadCategories = async () => {
    if (categoriesLoaded || categoriesLoading) return;
    categoriesLoading = true;
    category.setAttribute('aria-busy', 'true');
    categoryStatus.textContent = '正在加载分类…';
    syncCategory();
    try {
      const payload = await fetchSubmissionJson('/api/categories', {}, 10_000);
      if (!Array.isArray(payload.data) || !payload.data.length) throw new Error('暂无分类');
      category.replaceChildren(new Option('请选择适合的分类', ''));
      for (const item of payload.data) {
        category.add(new Option(item.name, item.id));
      }
      categoriesLoaded = true;
      categoryStatus.textContent = '';
    } catch {
      category.replaceChildren(new Option('分类暂时不可用', ''));
      categoryStatus.textContent = '分类加载失败，可使用自定义分类，或关闭后重试。';
    } finally {
      categoriesLoading = false;
      category.setAttribute('aria-busy', 'false');
      syncCategory();
    }
  };
  const resetForm = () => {
    form.reset();
    gate.reset();
    fields.disabled = false;
    syncCategory();
    setIconMode('upload');
    clearPreview();
    uploadLabel.textContent = '点击选择图标';
    fileInput.setCustomValidity('');
    message.hidden = true;
    submitted = false;
    submitLabel.textContent = '提交站点';
  };
  const auth = createSubmissionAuth({
    check: checkAccount,
    open() {
      if (dialog.open) return;
      if (submitted) resetForm();
      if (entryMessage) entryMessage.textContent = '';
      previousOverflow = document.documentElement.style.overflow;
      dialog.showModal();
      document.documentElement.style.overflow = 'hidden';
      void loadCategories();
    },
    login() {
      if (dialog.open) dialog.close();
      document.dispatchEvent(new CustomEvent('nav:auth-required'));
    },
    loading(value) {
      openButton.disabled = value;
      openButton.setAttribute('aria-busy', String(value));
      if (entryMessage && value) entryMessage.textContent = '正在检查登录状态…';
      else if (entryMessage?.textContent === '正在检查登录状态…') entryMessage.textContent = '';
    },
    error(error) {
      if (entryMessage) entryMessage.textContent = error instanceof Error ? error.message : '账号服务暂不可用，请重试。';
    },
  });
  openButton.addEventListener('click', () => { if (!dialog.open) void auth.open(); });
  const accountChanged = (event: Event) => {
    if (!busy) gate.reset();
    const reason = (event as CustomEvent).detail?.reason;
    if (reason === 'logout' && dialog.open && !busy) dialog.close();
    auth.accountChanged(reason);
  };
  document.addEventListener('nav:account-changed', accountChanged);
  closeButtons.forEach((button) => button.addEventListener('click', () => { if (!busy) dialog.close(); }));
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog || busy) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.documentElement.style.overflow = previousOverflow;
    openButton.focus({ preventScroll: true });
  });
  customToggle.addEventListener('change', () => { syncCategory(); if (customToggle.checked) customCategory.focus(); });
  form.querySelectorAll<HTMLButtonElement>('[data-icon-mode]').forEach((button) => {
    button.addEventListener('click', () => setIconMode(button.dataset.iconMode!));
  });
  preview.addEventListener('error', () => { preview.hidden = true; });
  fileInput.addEventListener('change', () => {
    clearPreview();
    fileInput.setCustomValidity('');
    const file = fileInput.files?.[0];
    uploadLabel.textContent = file?.name || '点击选择图标';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size >= 1024 * 1024 || !file.size) {
      fileInput.setCustomValidity('请选择小于 1 MB 的 PNG、JPG、WebP 或 GIF 图片。');
      fileInput.reportValidity();
      return;
    }
    objectUrl = URL.createObjectURL(file);
    preview.src = objectUrl;
    preview.hidden = false;
  });
  const readFile = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图标读取失败，请重新选择文件。'));
    reader.readAsDataURL(file);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    if (submitted) { dialog.close(); return; }
    if (!form.reportValidity() || !gate.start()) return;
    busy = true;
    message.hidden = true;
    form.setAttribute('aria-busy', 'true');
    submitButton.setAttribute('aria-busy', 'true');
    submitLabel.textContent = '正在准备…';
    showMessage('正在提交…');
    message.dataset.pending = 'true';
    submitButton.disabled = true;
    fields.disabled = true;
    closeButtons.forEach((button) => { button.disabled = true; });
    let needsLogin = false;
    try {
      await checkAccount();
      if (disposed) return;
      const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement).value.trim();
      const file = fileInput.files?.[0];
      const payload = {
        categoryId: customToggle.checked ? '' : category.value,
        customCategory: customToggle.checked ? customCategory.value.trim() : '',
        name: value('name'), url: value('url'), remark: value('remark'),
        iconUrl: iconMode === 'url' ? iconUrl.value.trim() : '',
        iconData: iconMode === 'upload' && file ? await readFile(file) : '',
      };
      for (const url of [payload.url, payload.iconUrl].filter(Boolean)) {
        if (!/^https?:\/\//i.test(url)) throw new Error('站点和图标链接仅支持 http:// 或 https://。');
      }
      const body = JSON.stringify(payload);
      const idempotencyKey = gate.keyFor(body);
      submitLabel.textContent = payload.iconData ? '正在上传并提交…' : '正在提交…';
      const result = await fetchSubmissionJson('/api/submissions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body,
      });
      if (result.data?.status !== 'pending' || !result.data?.id) throw new Error('未收到保存确认，请稍后重试。');
      submitted = true;
      if (!disposed) {
        dialog.close();
        showSuccessToast();
      }
    } catch (error) {
      needsLogin = auth.unauthorized(error);
      showMessage(error instanceof Error && error.message !== 'Failed to fetch' ? error.message : '网络连接失败，请稍后重试。已填写的内容会保留。');
    } finally {
      busy = false;
      gate.finish();
      form.setAttribute('aria-busy', 'false');
      submitButton.setAttribute('aria-busy', 'false');
      fields.disabled = submitted;
      submitButton.disabled = false;
      submitLabel.textContent = submitted ? '完成' : '提交站点';
      closeButtons.forEach((button) => { button.disabled = false; });
      if (needsLogin && !disposed) auth.requestLogin();
    }
  });
  document.addEventListener('astro:before-swap', () => {
    disposed = true;
    auth.dispose();
    hideToast();
    document.removeEventListener('nav:account-changed', accountChanged);
    if (dialog.open) { dialog.close(); document.documentElement.style.overflow = previousOverflow; }
    clearPreview();
  }, { once: true });
}
initSiteSubmission();
document.addEventListener('astro:page-load', initSiteSubmission);





