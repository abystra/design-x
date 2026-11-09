# R2 本地验收配置

本地使用用户授权的 `designx` 私有桶，默认运行配置将 `S3_BUCKET` 和 `S3_STAGING_BUCKET` 都配置为 `designx`。上传暂存、正式版本和项目内容池使用独立路径；验收对象还受随机测试 workspace 前缀隔离。下面的真实服务验收命令仍要求显式 `--single-bucket-test`；生产独立 staging/正式桶的边界保持不变。本地启动无需构建镜像。

浏览器直接 PUT 必须允许应用的 Origin。若桶尚无 CORS，可在 Cloudflare → R2 → `designx` → Settings → CORS Policy 使用 [cors.local.json](cors.local.json)。如果已有规则，**将这个规则对象追加到现有数组，不要覆盖原规则**。该文件只允许当前本地入口 `http://127.0.0.1:5173`，不会将桶变为公开桶；生产 Origin 必须单独配置。原理和 Dashboard 操作见 [Cloudflare 官方 CORS 文档](https://developers.cloudflare.com/r2/buckets/cors/)。

程序和验收脚本不会自动改写云端桶配置。对象读写凭据可能无权读取或修改桶 CORS，这不等于对象上传或短期读取凭据无效。

```sh
node --env-file=.env.r2.local --import tsx scripts/verify-r2-runtime.ts --live --keep --single-bucket-test --browser
node --import tsx infra/e2b/verify-materials.ts --live --single-bucket-test
node --import tsx scripts/verify-agent-workflow.ts --live --single-bucket-test --fixture artifacts/v2/r2-acceptance.json
node --env-file=.env.r2.local --import tsx scripts/verify-r2-runtime.ts --cleanup <fixture-workspace-id>
```

数据面全部通过、仅 CORS 不通过时，报告为 `partial`，允许独立继续 E2B 素材验收。浏览器直传仍保持未通过状态，配置 CORS 后必须重新检查，不能以服务端 PUT 替代浏览器验收。

## 保留历史数据的完整切换

`verify-*` 命令不会替换 `.env`。默认配置切换必须在 API、各 Worker 和定时清理均停止写入后进行，先备份数据库、当前配置及项目/文档/版本清单。`scripts/mirror-storage.ts` 复制整个对象存储，包含旧资产、不可变版本、导出、导入包、任务输入及 staging；`scripts/migrate-storage.ts` 只负责后续为未版本化的旧资产建立基线，不能代替全量复制。

本地 S3 与 R2 的主桶均名为 `designx`，全量镜像保持该桶原路径。其他历史桶映射到 R2 的独立前缀。数据库里的历史 bucket/key 不修改，所有对象读写及签名上传经过同一层显式映射：

```dotenv
S3_BUCKET=designx
S3_STAGING_BUCKET=designx
S3_BUCKET_ALIASES_JSON={"designx-staging":{"bucket":"designx","prefix":"_legacy/designx-staging/"},"designx-legacy-migration-test":{"bucket":"designx","prefix":"_legacy/designx-legacy-migration-test/"}}
```

准备两个 Git 忽略、权限 `0600` 的完整私有存储 profile，不要在日志或聊天中输出凭据：

- `artifacts/v2/cutover/storage-source.env`：原本地 `S3_ENDPOINT/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET/S3_STAGING_BUCKET`，另设 `MIRROR_SOURCE_BUCKETS_JSON=["designx-legacy-migration-test"]`。实际使用时应包含盘点得到的所有额外历史桶。
- `artifacts/v2/cutover/storage-target.env`：R2 的 `S3_*` 及上述 aliases。

```sh
# 不带 --copy：读取源/目标、计算摘要和差异，不写对象。
pnpm exec tsx scripts/mirror-storage.ts --source-env artifacts/v2/cutover/storage-source.env --target-env artifacts/v2/cutover/storage-target.env --manifest artifacts/v2/cutover/storage-mirror.json
pnpm exec tsx scripts/mirror-storage.ts --source-env artifacts/v2/cutover/storage-source.env --target-env artifacts/v2/cutover/storage-target.env --manifest artifacts/v2/cutover/storage-mirror.json --copy --concurrency 4
pnpm exec tsx scripts/mirror-storage.ts --source-env artifacts/v2/cutover/storage-source.env --target-env artifacts/v2/cutover/storage-target.env --manifest artifacts/v2/cutover/storage-mirror.json --verify
```

复制使用条件写入，每项读取目标并核对大小、SHA-256 和媒体类型；同名目标内容不同即停止，不覆盖。manifest 保存旧/新地址、摘要、完成状态，可在源清单不变时续跑。执行前后都会重查源清单，源对象永不删除。当前单对象读取预算为 256 MiB；超限明确失败，不会跳过对象后报告成功。源清单或映射改变时保留旧 manifest，改用新路径。

镜像不会修复原本不存在的对象。应先将数据库引用与源清单对照；例如：

```sh
pnpm exec tsx scripts/audit-storage-references.ts --source-env artifacts/v2/cutover/storage-source.env --database-env .env --manifest artifacts/v2/cutover/storage-mirror.json --output artifacts/v2/cutover/other-source-reference-audit.json
```

该只读审计覆盖任务输入/成果、冻结素材、上传、生成暂存和旧迁移；资产及 `asset_versions` 本身另与数据库备份逐项核验。已清理的成功导入源包、从未上传的会话、历史测试缺对象应分别记录原因，不能制造替代字节或删除数据库历史来通过验收。

只有全量镜像已 `verified` 才将主 `.env` 的 `S3_*` 和 aliases 换为目标配置。进程环境优先于 `.env`，应移除旧 shell/启动器中的 `S3_*`、`LEGACY_S3_*` 覆盖。此时在 R2 原地创建旧资产基线；不要再传旧 endpoint/credentials：

```sh
# 按全库回填；也可使用 --workspaces <JSON> 限制到备份时的 workspace ID 数组。
# --exclude-assets 仅用于已审计的缺失对象 asset ID 数组；默认缺失立即报错。
pnpm exec tsx scripts/migrate-storage.ts --all-workspaces --exclude-assets artifacts/v2/cutover/preexisting-missing-asset-ids.json --apply
```

排除项不会改变资产记录，也不会伪造版本。其余资产先复制并验证，再以事务切换当前版本；原路径和逐项回滚映射保留。`migrate-storage.ts` 不带 `--apply` 仍会创建已验证副本与迁移记录，只延迟引用切换，并非只读 dry run。旧跨 endpoint 同名桶的逐项迁移保护仍保留；上述完整镜像后的原地回填不受此限制。

## 已产生新 R2 写入后的回退

不能直接恢复切换前 `.env` 或旧数据库快照：它们没有新 R2 对象及新版本的地址状态。先停止全部写入，备份当前数据库和配置，对当前 R2 **整个物理 `designx` 桶**反向镜像到本地 `designx`，保留 `_legacy/…` 路径，然后保留当前数据库、当前 aliases 和 `S3_STAGING_BUCKET=designx`，仅切换存储 endpoint/region/credentials。原本地 staging/legacy 桶仍保留作审计和恢复来源。

以下代码从当前配置及先前私有 source profile 生成新的回退 profile，既不打印密钥，也不覆盖已有文件：

```sh
node --input-type=module <<'NODE'
import {readFile,writeFile} from 'node:fs/promises';
import {parse} from 'dotenv';
const active=parse(await readFile('.env'));
const old=parse(await readFile('artifacts/v2/cutover/storage-source.env'));
const keys=['S3_ENDPOINT','S3_REGION','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY','S3_BUCKET'];
const select=env=>Object.fromEntries(keys.map(key=>{if(!env[key])throw new Error(`Missing ${key}`);return [key,env[key]];}));
const source={...select(active),S3_STAGING_BUCKET:active.S3_BUCKET,MIRROR_SOURCE_BUCKETS_JSON:'[]',S3_BUCKET_ALIASES_JSON:'{}'};
const target={...select(old),S3_STAGING_BUCKET:old.S3_BUCKET,MIRROR_SOURCE_BUCKETS_JSON:'[]',S3_BUCKET_ALIASES_JSON:active.S3_BUCKET_ALIASES_JSON||'{}'};
for(const [name,values] of [['source',source],['target',target]]){
 const text=Object.entries(values).map(([key,value])=>{if(/[\r\n']/.test(value))throw new Error('Use an explicitly prepared private profile for quoted values');return `${key}='${value}'`;}).join('\n')+'\n';
 await writeFile(`artifacts/v2/cutover/storage-rollback-${name}.env`,text,{mode:0o600,flag:'wx'});
}
NODE
pnpm exec tsx scripts/mirror-storage.ts --source-env artifacts/v2/cutover/storage-rollback-source.env --target-env artifacts/v2/cutover/storage-rollback-target.env --manifest artifacts/v2/cutover/storage-rollback-mirror.json --copy
pnpm exec tsx scripts/mirror-storage.ts --source-env artifacts/v2/cutover/storage-rollback-source.env --target-env artifacts/v2/cutover/storage-rollback-target.env --manifest artifacts/v2/cutover/storage-rollback-mirror.json --verify
```

两端原对象保留；冲突会中止，必须查明原因，不能改为无条件覆盖。验证成功后才将主 `.env` 的存储字段换为回退 target profile，重新核验历史和新增项目。`MIRROR_SOURCE_BUCKETS_JSON` 仅供脚本使用。新版 E2B 的项目 `matfs` 准备当前要求 R2 endpoint；回到本地 S3 时保持 Agent 新派发停止，恢复兼容 Runner 必须另外验收。未知执行不可在另一宿主重跑。此过程是回退操作说明，不代表已经执行过回退或完整产品验收。
