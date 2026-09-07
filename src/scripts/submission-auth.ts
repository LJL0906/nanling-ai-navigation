/** 前端只负责交互门禁；最终身份必须由提交 API 从服务端会话校验。 */
export function createSubmissionAuth(options: {
  check: () => Promise<void>;
  open: () => void;
  login: () => void;
  loading: (value: boolean) => void;
  error: (error: unknown) => void;
}) {
  let opening = false;
  let disposed = false;
  let resume = false;
  let revision = 0;
  const unauthorized = (error: unknown) => (error as { status?: number } | null)?.status === 401;
  function requestLogin() {
    if (disposed) return;
    resume = true;
    options.login();
  }
  async function open() {
    if (opening || disposed) return;
    opening = true;
    const current = revision;
    options.loading(true);
    try {
      await options.check();
      if (!disposed && current === revision) options.open();
    } catch (error) {
      if (!disposed && current === revision) {
        options.error(error);
        if (unauthorized(error)) requestLogin();
      }
    } finally {
      opening = false;
      if (!disposed) options.loading(false);
    }
  }
  return {
    open, requestLogin, unauthorized,
    accountChanged(reason: unknown) {
      if (reason === 'logout') { revision++; resume = false; }
      else if (resume && (reason === 'login' || reason === 'register')) {
        resume = false;
        void open();
      }
    },
    dispose() { disposed = true; revision++; resume = false; },
  };
}
