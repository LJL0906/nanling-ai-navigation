const KEY = 'nav-search-history';
const MAX_ITEMS = 5;

function readHistory(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, MAX_ITEMS) : [];
  } catch {
    return [];
  }
}

function writeHistory(items: string[]) {
  localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
}

function initSearchHistory() {
  const form = document.querySelector<HTMLFormElement>('[data-search-history-form]');
  const input = form?.querySelector<HTMLInputElement>('input[name="q"]');
  const container = document.querySelector<HTMLElement>('[data-search-history]');
  const tags = document.querySelector<HTMLElement>('[data-search-history-tags]');
  if (!form || !input || !container || !tags || form.dataset.searchHistoryReady === 'true') return;
  form.dataset.searchHistoryReady = 'true';

  const render = () => {
    const items = readHistory();
    tags.replaceChildren(...items.map((word) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cyber-search-history__tag';
      button.textContent = word;
      button.title = word;
      button.addEventListener('click', () => {
        input.value = word;
        input.focus();
      });
      return button;
    }));
    container.hidden = items.length === 0;
  };

  form.addEventListener('submit', () => {
    const word = input.value.trim();
    if (!word) return;
    writeHistory([word, ...readHistory().filter((item) => item !== word)]);
  });

  render();
}

document.addEventListener('astro:page-load', initSearchHistory);
initSearchHistory();
