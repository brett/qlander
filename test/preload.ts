// Loaded before every test file (bunfig.toml). A checkout with its own
// qlander.yml (a control repo running from source) tests on that file; a
// checkout without one (the public repo) tests on the neutral example config.

import { existsSync } from "node:fs";
import { CONFIG_PATH, useConfigFile } from "../src/config/load";

export const EXAMPLE_CONFIG = `${import.meta.dir}/fixtures/example.qlander.yml`;

if (!existsSync(CONFIG_PATH)) useConfigFile(EXAMPLE_CONFIG);
