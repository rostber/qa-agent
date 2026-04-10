import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'path';
import packageJson from '../package.json' with { type: 'json' };

export async function createPlaywrightMcpClient(): Promise<Client> {
  // Используем локальную версию @playwright/mcp через относительный путь от корня проекта
  const mcpCliPath = join(process.cwd(), 'node_modules/@playwright/mcp/cli.js');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [mcpCliPath, '--caps', 'testing,devtools', '--isolated'],
  });

  const client = new Client(
    {
      name: packageJson.name,
      version: packageJson.version,
    },
    {
      capabilities: {},
    }
  );

  await client.connect(transport);

  return client;
}

export async function closeMcpClient(client: Client): Promise<void> {
  await client.close();
}
