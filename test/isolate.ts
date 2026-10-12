// Import FIRST in any test that boots the gateway: points the persistent store at a fresh temp dir, so test
// sellers ("Broken API", "Junk Oracle", …) never leak into the developer's real .data/store.json — and a
// DATABASE_URL in .env can never send test rows to a real Postgres.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.AGORA_DATA_DIR) process.env.AGORA_DATA_DIR = mkdtempSync(join(tmpdir(), "agora-test-"));
delete process.env.DATABASE_URL;
