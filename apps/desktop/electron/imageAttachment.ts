/**
 * 图片附件落盘。
 *
 * 为什么不让渲染层直接传 base64 给引擎：pi 的 image block 要的是**本地路径**
 * （它自己 readFile 后转 base64 发给模型）。所以图片必须先落到主进程能读到的地方。
 *
 * 落盘位置放在会话数据目录下，不污染用户的工作目录 ——
 * 用户的工作目录是他们的项目，不该出现我们塞进去的临时图。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 只收这几种：模型侧常见，且都有可靠的内容嗅探方式 */
const ALLOWED = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

/** 单张图上限 8MB：再大模型也吃不下，而且会让请求明显变慢 */
const MAX_BYTES = 8 * 1024 * 1024;

export interface SavedImage {
  /** 绝对路径，直接给 pi 用 */
  path: string;
  /** 给 UI 显示缩略图用的 data URI */
  dataUrl: string;
}

/**
 * 从 data URI 存成文件。
 *
 * 用内容嗅探而不是只信 mimeType 声明：data URI 里的类型是调用方给的，
 * 写错会把 .exe 存成 .png。这里只认魔数字节。
 */
export async function saveImageAttachment(
  sessionDir: string,
  dataUrl: string,
): Promise<SavedImage> {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('不是合法的 data URI');
  const isBase64 = match[2] === ';base64';
  if (!isBase64) throw new Error('只支持 base64 编码的图片');

  const buffer = Buffer.from(match[3] ?? '', 'base64');
  if (buffer.length === 0) throw new Error('图片内容为空');
  if (buffer.length > MAX_BYTES) {
    throw new Error(`图片太大（${(buffer.length / 1024 / 1024).toFixed(1)}MB），上限 8MB`);
  }

  const mime = sniffImageMime(buffer);
  if (!mime) throw new Error('无法识别的图片格式（支持 PNG / JPEG / WebP / GIF）');

  const ext = ALLOWED.get(mime)!;
  const dir = path.join(sessionDir, 'attachments');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}${ext}`);
  await fs.writeFile(file, buffer);

  return { path: file, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
}

/** 按魔数判断真实类型；认不出返回 null */
function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF8"
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  // WebP: "RIFF" .... "WEBP"
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}
