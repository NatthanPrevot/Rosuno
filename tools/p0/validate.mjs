import { validateRepository } from "./lib/controls.mjs";

try {
  console.log(JSON.stringify(validateRepository(), null, 2));
} catch (error) {
  console.error(`P0 validation failed: ${error.message}`);
  process.exitCode = 1;
}
