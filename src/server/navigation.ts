import { seedRepository } from './seed-repository';
import { mysqlRepository } from './mysql-repository';
import { getStorageDriver } from './database-config';
import type { NavigationRepository } from './repository';

/** 切换到mysql后故障明确报错，不静默回退种子数据。 */
export const navigationRepository: NavigationRepository = getStorageDriver() === 'mysql' ? mysqlRepository : seedRepository;
