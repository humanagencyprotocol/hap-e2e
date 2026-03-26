import { startServers } from './fixtures';

export default async function globalSetup() {
  await startServers();
}
