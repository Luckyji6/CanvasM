// 自己的服务器上用的运维小工具（以服务用户身份运行）：
//   node cli.mjs count            现有多少个连接（只能数文件，看不到是谁）
//   node cli.mjs prune <days>     删掉超过 <days> 天没用过的连接

import { fileURLToPath } from 'node:url';
import { FileStore } from './src/stores/file.mjs';

const dir = process.env.DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url));
const store = await new FileStore(dir).init();

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'count') {
  console.log(await store.count());
} else if (cmd === 'prune' && Number(arg) >= 30) {
  console.log(`removed ${await store.prune(Number(arg))}`);
} else {
  console.error('usage: node cli.mjs count | prune <days ≥ 30>');
  process.exit(1);
}
