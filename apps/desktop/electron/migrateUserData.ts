/**
 * 一次性目录迁移。
 *
 * 背景：产品从「Spike Agent」改名叫「Juno」后，Electron 的 `userData`
 * 跟着 productName 变成 `%APPDATA%/Juno`。旧目录 `%APPDATA%/Spike Agent`
 * 里躺着 session.db、settings.json、pi 的会话文件 —— 不搬的话，
 * 用户升级后打开就是一片空白，像被重置了。
 *
 * 三条约束：
 *   1. **只在目标不存在时搬**：新目录已经有数据（用户已经用过新版）就不碰
 *   2. **失败不阻断启动**：搬不动就让 app 用空目录跑，比起不来强
 *   3. **搬完留标记**：避免某些情况下（比如用户手动删了新目录）重复搬旧数据
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 历史名字，按时间倒序；以后改名往这里加 */
const LEGACY_APP_NAMES = ['Spike Agent'];

/**
 * 如果旧目录有数据、新目录没有，就把旧目录搬过来。
 *
 * 返回是否真的搬了，用于日志。
 */
export async function migrateLegacyUserData(): Promise<{ moved: boolean; from?: string }> {
  const target = app.getPath('userData');

  // 新目录已经有东西 → 不搬（用户已经在用新版）
  const targetExists = await fs
    .stat(target)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (targetExists) {
    const entries = await fs.readdir(target).catch(() => [] as string[]);
    // 只有空目录或只有迁移标记时才继续
    const meaningful = entries.filter((e) => e !== '.migrated-from');
    if (meaningful.length > 0) return { moved: false };
  }

  const appDataRoot = app.getPath('appData');
  for (const legacyName of LEGACY_APP_NAMES) {
    const legacyDir = path.join(appDataRoot, legacyName);
    const legacyExists = await fs
      .stat(legacyDir)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!legacyExists) continue;

    try {
      await fs.mkdir(target, { recursive: true });
      // recursive: true 会把内容一起复制；旧目录保留不删 ——
      // 万一新版本有问题，用户还能退回旧版本接着用
      await fs.cp(legacyDir, target, { recursive: true, force: false, errorOnExist: false });
      await fs.writeFile(path.join(target, '.migrated-from'), legacyName, 'utf8');
      console.log(`[migrate] 已从「${legacyName}」迁移数据到「${path.basename(target)}」`);
      return { moved: true, from: legacyDir };
    } catch (error) {
      // 迁移失败不能让 app 起不来 —— 用空目录继续跑，用户至少能用
      console.warn('[migrate] 目录迁移失败，将以空数据启动:', String(error));
    }
  }

  return { moved: false };
}
