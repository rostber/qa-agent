import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function createPlaywrightMcpClient(): Promise<Client> {
  // Используем локальную версию @playwright/mcp через абсолютный путь
  const mcpCliPath = '/Users/vladimirsavelyev/Downloads/qa-agent/node_modules/@playwright/mcp/cli.js';

  const transport = new StdioClientTransport({
    command: 'node',
    args: [mcpCliPath, '--caps', 'testing,devtools', '--isolated'],
  });

  const client = new Client(
    {
      name: 'qa-agent-playwright-client',
      version: '1.0.0',
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
