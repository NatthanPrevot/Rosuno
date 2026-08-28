import { scanRepositoryForSecrets } from "./lib/controls.mjs";

try {
  console.log(JSON.stringify(scanRepositoryForSecrets(), null, 2));
} catch (error) {
  console.error(`Secret scan failed: ${error.message}`);
  process.exitCode = 1;
}
