import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers, ensureUsersRegistered, ALICE, BOB, SP_URL } from './fixtures';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  await startServers();
  await ensureUsersRegistered();

  // Save user data for test worker processes
  writeFileSync(
    join(__dirname, '.test-users.json'),
    JSON.stringify({ alice: ALICE, bob: BOB }),
  );
}
