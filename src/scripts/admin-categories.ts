import { initContent } from './admin';

const initCategories = () => initContent('categories');
document.addEventListener('astro:page-load', initCategories);
window.addEventListener('pageshow', event => { if (event.persisted) initCategories(); });
initCategories();
