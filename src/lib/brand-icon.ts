import lucide from '@iconify-json/lucide/icons.json' with { type: 'json' };
import simpleIcons from '@iconify-json/simple-icons/icons.json' with { type: 'json' };

/** 仅服务端使用，避免将整套图标数据带入浏览器。 */
export function isBrandIcon(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:lucide|simple-icons):[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return false;
  const [prefix, name] = value.split(':');
  const collection = prefix === 'lucide' ? lucide : simpleIcons;
  return Object.hasOwn(collection.icons, name)
    || ('aliases' in collection && Object.hasOwn(collection.aliases, name));
}
