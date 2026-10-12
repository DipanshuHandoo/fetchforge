import { startDemo } from './demo.mjs';
import { urls as inputUrls } from './input.mjs';

// --demo, then command-line URLs, then input.mjs, then the offline demo.
export async function loadUrls() {
  const args = process.argv.slice(2);
  if (args.includes('--demo')) {
    console.log('[input] --demo: using the offline demo with 50 local URLs');
    return startDemo();
  }
  if (args.length) return { urls: args, close: async () => {} };
  if (inputUrls.length) return { urls: inputUrls, close: async () => {} };
  console.log('[input] no URLs given; using the offline demo with 50 local URLs');
  return startDemo();
}
