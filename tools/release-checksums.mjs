/** Print SHA-256 for the exact downloaded release files; never trust filenames alone. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

if (process.argv.length < 3) {
  console.error('Usage: node tools/release-checksums.mjs <Setup.exe> <Portable.exe> [latest.yml]');
  process.exitCode = 1;
} else {
  for (const file of process.argv.slice(2)) {
    const hash = createHash('sha256');
    try {
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      console.log(`${hash.digest('hex')}  ${file}`);
    } catch (error) {
      console.error(`${file}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
