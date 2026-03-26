import { stopServers } from './fixtures';

export default async function globalTeardown() {
  await stopServers();
}
