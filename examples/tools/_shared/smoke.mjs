import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function runExample(file, args, reportDir) {
  try {
    const result = await promisify(execFile)(process.execPath, [file, ...args], {
      env: { ...process.env, FETCHFORGE_EXAMPLE_REPORT_DIR: reportDir },
      timeout: 30_000,
      maxBuffer: 4_000_000,
    });
    return { ...result, code: 0 };
  } catch (error) {
    if (!Number.isInteger(error.code)) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}
