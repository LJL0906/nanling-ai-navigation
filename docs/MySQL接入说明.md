# MySQL 接入说明

更新日期：2026-09-07

> **2026-09-07 后续更新**：已验证 MySQL 5.7.43 连接，完成 18 分类、2400 站点、52 菜单和 8 项配置的真实入库与全量回读校验。本地 `NAV_STORAGE=mysql`，按用户确认使用无 TLS 直连。菜单现已完成后台读写和前台展示闭环，配置表仍仅完成入库；最新操作见《菜单接口与管理说明.md》。下文“当前状态”及“本轮”描述保留的是此前接入准备阶段记录，不代表最新运行状态。


## 当前状态

- 已按用户提供的3306端口接入 MySQL 驱动与连接池；数据库实际类型、版本、TLS要求仍需连通检查确认。
- 主机、端口、库名及账号已写入本地 `.env`，不提交到 Git；密码留给用户填写。
- 当前 `NAV_STORAGE=seed`，页面继续读取现有18类、2400条站点。
- 本轮没有尝试连接远程数据库，没有建表或写入数据，也没有声称已验证真实连接。
- MySQL读取仓储、连接检查和显式初始化工具已实现；后台仍为只读，尚未开放运营增删改。

## 填写密码

编辑项目根目录 `.env` 中的 `MYSQL_PASSWORD`，例如：

```dotenv
MYSQL_PASSWORD="在这里填入真实密码"
```

不要把真实密码提交到Git或聊天。连接采用独立字段而非URL，因此密码里的 `@`、`:`、`/` 不需要URL编码；包含 `#` 或空格时必须加引号。配置不裁剪密码首尾空格。

不要覆盖已有 `ADMIN_TOKEN`。数据库密码和管理令牌用途不同。

## 连接与初始化顺序

密码填好后，先确认目标库、MySQL版本、账号权限和TLS要求，再执行只读检查：

```powershell
npm run db:check
```

该命令只检查当前数据库、版本和TLS状态，不创建数据库或数据表。

确认允许创建专用表、且目标是空表后，显式执行：

```powershell
npm run db:migrate -- --apply
npm run db:import -- --apply
```

- 不提供 `--apply` 时，建表/导入命令在创建连接前拒绝执行。
- 不会创建数据库、删除表、清空表、修改其他业务表或覆盖已有数据。
- 表名为 `nav_categories` 和 `nav_sites`；SQL 使用InnoDB、utf8mb4和JSON字段。
- 需要支持JSON的MySQL版本；实际数据库版本尚未验证。
- 建表使用 `CREATE TABLE IF NOT EXISTS`。MySQL DDL会隐式提交，不能把两条建表语句当成可整体回滚的迁移。
- 导入先离线校验数据，再取得数据库互斥锁，并确认两张表均为空；采用参数化INSERT和事务，失败回滚，拒绝重复导入。
- `payload` 保留原始整条JSON；索引列 `id`、`slug`、`category_id` 必须与JSON一致，读取时会校验。分类站点数量以实际数据重算。
- 初始化操作需要建表和插入权限；正式网站只读运行可改用仅有SELECT权限的账号。

导入成功后再把 `.env` 中的开关改为：

```dotenv
NAV_STORAGE=mysql
```

重启所属开发/生产服务。MySQL模式下连接失败、缺少表、空库或数据异常会明确报错，**不会悄悄回退种子数据**。需要临时回退时可由用户手动改回 `NAV_STORAGE=seed` 并重启。

## TLS与网络

- 默认 `MYSQL_SSL_MODE=required`，验证证书与服务端身份，不自动降级。
- 私有证书可通过 `MYSQL_SSL_CA` 设置本机CA文件路径。
- IP连接与证书身份可能不匹配；应与数据库管理员确认可用主机名、CA和驱动连接行为，不能通过关闭证书校验来掩盖问题。
- `disabled` 仅供明确确认无需TLS的受控环境，不建议通过公网明文传输数据库凭据。
- 应在数据库侧仅放行应用服务器来源IP，不向所有地址开放3306端口。
- 本轮未进行网络或端口探测；网络白名单、TLS及账号授权仍待确认。

## 验证范围

```powershell
npm test
npm run typecheck
npm run build
npm run test:build
```

数据库配置、JSON行还原、参数化导入、事务回滚及拒绝覆盖通过本地模拟测试；`test:build`强制使用seed，不接触用户远程数据库。真实MySQL建表/导入尚未执行。

## 本轮文件变更

### 新增

- `.env`（本地忽略，不提交）
- `src/server/database-config.ts`
- `src/server/database-schema.ts`
- `src/server/mysql-reader.ts`
- `src/server/mysql-repository.ts`
- `scripts/管理数据库.mjs`
- `scripts/数据库工具.test.mjs`
- `scripts/数据库配置与读取.test.mjs`
- `docs/MySQL接入说明.md`

### 修改

- `.env.example`
- `package.json`
- `package-lock.json`
- `src/server/navigation.ts`
- `src/pages/api/health.ts`
- `src/scripts/admin.ts`
- `scripts/检查构建产物.mjs`
- `README.md`
- `docs/全栈开发与部署.md`

### 删除

无。
