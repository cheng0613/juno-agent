/**
 * 一次性探测：当前模型到底能不能看图。
 *
 * 跑法：APP_PI_API_KEY=... node dist/probeImage.js
 *
 * 为什么必须实测：宿主没声明 supportsImageInput，引擎默认当成支持，
 * 但 deepseek 走 openai-completions 端点，视觉输入很可能是假的。
 * 不实测就做 UI，等于给用户一个发图必报错的入口。
 */
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import zlib from 'node:zlib';

import { Maker, createConsoleLogger, isTerminalTurnEvent, type PiNativeApi } from '@cindy/maker-core';
import {
  assertPiBinaryExists,
  createPiAgent,
  openDatabase,
  resolvePiBinary,
  SqliteSessionStorage,
} from '@juno/host-core';

const logger = createConsoleLogger('probe-image');
const UPSTREAM_ROOT = process.env.SPIKE_UPSTREAM_ROOT ?? 'C:/Users/chiaki/Desktop/agent/upstream/cindy';
const MODEL = process.env.APP_MODEL ?? 'deepseek-v4.1-flash-1017';
const ENDPOINT = process.env.APP_ENDPOINT ?? 'https://tokenhub.tencentmaas.com/v1';
const API = (process.env.APP_API ?? 'openai-completions') as PiNativeApi;
const DATA_DIR = process.env.APP_DATA_DIR ?? path.join(os.tmpdir(), 'probe-image');

/**
 * 现造一张极小的 PNG：64x64，纯红底 + 白字形状没有，
 * 但足够让模型判断「主色是什么」。
 */
function makeRedPng(): Buffer {
  const width = 64;
  const height = 64;
  // 每行 1 字节 filter + 64*3 字节 RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = 220; // R
      raw[p + 1] = 30; // G
      raw[p + 2] = 30; // B
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const binaryPath = resolvePiBinary(UPSTREAM_ROOT);
await assertPiBinaryExists(binaryPath);
const agentHome = path.join(DATA_DIR, 'pi-agent-home');
await fs.mkdir(agentHome, { recursive: true });

const agent = createPiAgent({
  binaryPath,
  model: MODEL,
  api: API,
  endpoint: ENDPOINT,
  contextWindow: 200_000,
  efforts: [],
  defaultEffort: null,
  agentHome,
  logger: logger.child('pi'),
});

const maker = new Maker({
  agents: { pi: agent },
  storage: new SqliteSessionStorage(await openDatabase(path.join(DATA_DIR, 'probe.db'))),
  logger,
});
const workDir = path.join(DATA_DIR, 'workspace');
await fs.mkdir(workDir, { recursive: true });
const session = await maker.createSession({
  agentKind: 'pi',
  workingDir: workDir,
  model: MODEL,
  title: 'probe-image',
});

session.setInteractionListener(async () => ({ kind: 'permission', behavior: 'allow' }) as never);

const caps = (session as unknown as { capabilities?: Record<string, unknown> }).capabilities;
logger.info('multimodal 能力声明', {
  multimodal: caps?.multimodal ?? null,
});

// 造图并落盘
const imgPath = path.join(workDir, 'red.png');
await fs.writeFile(imgPath, makeRedPng());
logger.info('测试图片已写入', { path: imgPath });

const runTurn = async (label: string, send: () => Promise<unknown>) => {
  const done = new Promise<void>((resolve) => {
    const off = session.onEvent((event) => {
      if (event.turnScope !== 'background' && isTerminalTurnEvent(event)) {
        off();
        resolve();
      }
    });
    setTimeout(() => {
      off();
      resolve();
    }, 90_000);
  });
  try {
    await send();
    await done;
    logger.info(`${label}: 完成`);
    return true;
  } catch (error) {
    logger.error(`${label}: 抛错`, {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

let answer = '';
session.onEvent((event) => {
  if (event.type === 'text') {
    const d = event.data as { text?: string; isFinal?: boolean };
    if (d?.isFinal && d.text) answer = d.text;
  }
});

// ---- 试法 1：结构化 image block ----
logger.info('=== 试法 1：send 里带 image block ===');
await runTurn('image block', () =>
  session.send({
    type: 'user',
    content: [
      { type: 'text', text: '这张图主体是什么颜色？只回答颜色名。' },
      { type: 'image', path: imgPath },
    ],
  } as never),
);
logger.info('回答', { answer: answer.slice(0, 120) });

// ---- 试法 2：让模型自己用 read 工具读图 ----
logger.info('=== 试法 2：让模型用 read 工具读图 ===');
answer = '';
await runTurn('read tool', () =>
  session.send(`用 read 工具读取 ${imgPath}，然后告诉我这张图主体是什么颜色。`),
);
logger.info('回答', { answer: answer.slice(0, 120) });

await maker.shutdown();
logger.info('probe done');
