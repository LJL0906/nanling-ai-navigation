import raw from '../data/导航数据.json';
import legacy from '../data/sites.json';
import { adaptNavigation } from '../lib/adapt-navigation';
import type { UnifiedNavigation } from '../lib/navigation-types';
import type { LegacyCategory } from '../lib/types';
import type { NavigationRepository, NavigationSnapshot } from './repository';

/** 数据库接入前的只读种子仓储。不覆盖源文件、不模拟数据库写入。 */
let snapshot: NavigationSnapshot | undefined;
export const seedRepository: NavigationRepository = {
  storage: { driver: 'seed', databaseConnected: false, writable: false },
  async getNavigation() {
    snapshot ??= adaptNavigation(raw as UnifiedNavigation, legacy as { categories: LegacyCategory[] });
    return snapshot;
  },
};
