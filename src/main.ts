import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = createApp(config);

console.log(JSON.stringify({
  level: 'info',
  message: 'server_starting',
  port: config.port,
}));

Deno.serve({ port: config.port }, app);
