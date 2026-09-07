export type AccountChangeReason = 'login' | 'register' | 'logout';
const channelName = 'nav:account-changed';
let initialized = false;
let channel: BroadcastChannel | undefined;
const isReason = (value: unknown): value is AccountChangeReason => ['login', 'register', 'logout'].includes(value as string);
function dispatch(reason: AccountChangeReason) {
  // 事件仅包含 reason，不暴露用户名、会话或个人记录；消费者必须重新查询 API。
  document.dispatchEvent(new CustomEvent(channelName, { detail: { reason } }));
}
export function initializeAccountEvents() {
  if (initialized) return;
  initialized = true;
  try {
    channel = new BroadcastChannel(channelName);
    channel.addEventListener('message', event => {
      if (isReason(event.data?.reason)) dispatch(event.data.reason);
    });
  } catch { /* 不支持 BroadcastChannel 时使用不含账号数据的 storage 通知。 */ }
  window.addEventListener('storage', event => {
    if (event.key !== channelName || !event.newValue) return;
    try {
      const payload = JSON.parse(event.newValue);
      if (isReason(payload.reason)) dispatch(payload.reason);
    } catch { /* 忽略其他脚本写入的无效通知。 */ }
  });
}
export function notifyAccountChanged(reason: AccountChangeReason) {
  initializeAccountEvents();
  dispatch(reason);
  if (channel) {
    channel.postMessage({ reason });
  } else {
    try { localStorage.setItem(channelName, JSON.stringify({ reason, nonce: crypto.randomUUID() })); }
    catch { /* 禁用本地存储不影响当前页面的登录状态更新。 */ }
  }
}
