import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';
import { getEnv } from './env.js';

// Глобальный MCP клиент - один на всю сессию
let globalMcpClient: any = null;
let globalTools: any[] = [];

async function getMcpClient() {
  if (!globalMcpClient) {
    const { createPlaywrightMcpClient } = await import('./mcp-client.js');
    globalMcpClient = await createPlaywrightMcpClient();
    const tools = await globalMcpClient.listTools();
    globalTools = tools.tools;
  }
  return { client: globalMcpClient, tools: globalTools };
}

// Преобразуем JSON Schema в zod схему
function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema) return z.object({});

  switch (schema.type) {
    case 'object': {
      const shape: Record<string, any> = {};
      const required = schema.required || [];
      
      for (const [key, value] of Object.entries(schema.properties || {})) {
        let fieldSchema = jsonSchemaToZod(value as any);
        if (!required.includes(key)) {
          fieldSchema = fieldSchema.optional();
        }
        shape[key] = fieldSchema;
      }
      
      return z.object(shape);
    }
    case 'array': {
      const itemsSchema = jsonSchemaToZod(schema.items);
      return z.array(itemsSchema);
    }
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    default:
      return z.unknown();
  }
}

// Преобразуем результат MCP в формат, понятный AI SDK
function formatMcpResult(result: any): string {
  if (typeof result === 'string') return result;
  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((c: any) => c.text || c)
      .join('\n');
  }
  return JSON.stringify(result);
}

// Генерируем список инструментов для системного промта
function generateToolsPrompt(tools: any[]): string {
  const toolList = tools.map(t => 
    `- ${t.name}: ${t.description}`
  ).join('\n');
  
  return `ДОСТУПНЫЕ ИНСТРУМЕНТЫ:
${toolList}`;
}

export async function createAgent(systemPrompt: string, requestCounter: { count: number }) {
  const config = getEnv();
  const { client: mcpClient, tools } = await getMcpClient();

  const openai = createOpenAI({
    apiKey: config.apiToken,
    baseURL: config.baseUrl,
  });

  // Добавляем список инструментов в системный промт
  const toolsPrompt = generateToolsPrompt(tools);
  const fullSystemPrompt = `${systemPrompt}\n\n${toolsPrompt}`;

  const mcpToolMap: Record<string, any> = {};
  for (const tool of tools) {
    const zodSchema = jsonSchemaToZod(tool.inputSchema);
    
    // Для browser_click используем только ref (согласно схеме MCP)
    if (tool.name === 'browser_click') {
      mcpToolMap[tool.name] = {
        description: tool.description,
        parameters: z.object({
          ref: z.string().describe('Exact target element reference from the page snapshot'),
          element: z.string().optional().describe('Human-readable element description'),
          doubleClick: z.boolean().optional().describe('Whether to perform a double click'),
          button: z.enum(['left', 'right', 'middle']).optional().describe('Button to click'),
          modifiers: z.array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'])).optional().describe('Modifier keys to press'),
        }),
        execute: async (args: any) => {
          const result = await mcpClient.callTool(
            {
              name: 'browser_click',
              arguments: {
                ref: args.ref,
                element: args.element,
                doubleClick: args.doubleClick,
                button: args.button,
                modifiers: args.modifiers,
              },
            },
            undefined,
            { timeout: 30000 }
          );
          return { content: formatMcpResult(result) };
        },
      };
    } else if (tool.name === 'browser_wait_for') {
      mcpToolMap[tool.name] = {
        description: tool.description,
        parameters: z.object({
          text: z.string().optional().describe('Текст для ожидания'),
          time: z.number().optional().describe('Время в мс'),
        }),
        execute: async (args: any) => {
          if (args.text) {
            const result = await mcpClient.callTool(
              {
                name: 'browser_wait_for',
                arguments: { text: args.text },
              },
              undefined,
              { timeout: 30000 }
            );
            return { content: formatMcpResult(result) };
          }
          if (args.time) {
            const result = await mcpClient.callTool(
              {
                name: 'browser_wait_for',
                arguments: { time: args.time },
              },
              undefined,
              { timeout: 30000 }
            );
            return { content: formatMcpResult(result) };
          }
          return { content: '### Error: Нет ни text ни time' };
        },
      };
    } else {
      mcpToolMap[tool.name] = {
        description: tool.description,
        parameters: zodSchema,
        execute: async (args: any) => {
          const result = await mcpClient.callTool(
            {
              name: tool.name,
              arguments: args,
            },
            undefined,
            { timeout: 30000 }
          );
          const formattedResult = formatMcpResult(result);
          return { content: formattedResult };
        },
      };
    }
  }

  return {
    async chat(userMessage: string, conversationHistory: any[] = []) {
      const messages: any[] = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: userMessage },
      ];

      let currentMessages = [...messages];
      let executionLog: string[] = [];
      let stepCount = 0;
      const maxSteps = 50;
      let hasError = false;
      let lastResult = '';

      // Выполняем шаги циклически: планируем -> выполняем -> повторяем
      while (stepCount < maxSteps) {
        stepCount++;

        // Создаём план для следующего шага
        let planResult: any;
        let retries = 0;
        const maxRetries = 3;

        while (retries < maxRetries) {
          try {
            requestCounter.count++;
            planResult = await generateObject({
              model: openai.chat(config.model),
              schema: z.object({
                tool: z.string().describe('Название инструмента'),
                args: z.record(z.string(), z.unknown()).describe('Аргументы'),
                description: z.string().describe('Краткое описание'),
                continue: z.boolean().describe('Нужно ли выполнять ещё шаги (true если задача не завершена)'),
              }),
              system: fullSystemPrompt,
              prompt: `Задача: ${userMessage.substring(0, 500)}
Результаты выполненных шагов: ${executionLog.slice(-5).join('; ')}
Следующий шаг (tool, args, description, continue).
Если все действия из задачи выполнены, установи continue=false.`,
            });
            break;
          } catch (error: any) {
            retries++;
            if (retries >= maxRetries) {
              executionLog.push(`Ошибка генерации плана после ${maxRetries} попыток`);
              hasError = true;
              break;
            }
          }
        }

        if (hasError && retries >= maxRetries) break;
        if (!planResult) {
          executionLog.push('Не удалось сформировать шаг');
          hasError = true;
          break;
        }

        const step = planResult.object;

        // Если задача завершена (continue=false)
        if (!step.continue) {
          executionLog.push(`Задача завершена: ${step.description}`);
          break;
        }

        executionLog.push(`Шаг ${stepCount}: ${step.tool} - ${step.description}`);

        const tool = mcpToolMap[step.tool];
        if (!tool) {
          executionLog.push(`  ✗ Инструмент "${step.tool}" не найден`);
          hasError = true;
          break;
        }

        try {
          requestCounter.count++;
          const result = await tool.execute(step.args);
          lastResult = result.content;

          // Проверяем на ошибки
          const content = result.content || '';
          const contentLower = content.toLowerCase();
          
          const isError = 
            content.includes('### Error') ||
            contentLower.includes('error:') ||
            contentLower.includes('exception') ||
            contentLower.includes('timeout') ||
            contentLower.includes('not found') ||
            contentLower.includes('cannot find') ||
            contentLower.includes('no element') ||
            contentLower.includes('invalid_type') ||
            contentLower.includes('invalid input') ||
            contentLower.includes('failed') ||
            contentLower.includes('cannot proceed');

          if (isError) {
            executionLog.push(`Шаг ${stepCount}: ${step.tool} - ${step.description} - ✗ ОШИБКА`);
            console.log(`  ✗ ОШИБКА: ${step.tool} - ${step.description}`);
            console.log(`  Детали: ${content.substring(0, 300)}`);
            hasError = true;
            break;
          } else {
            executionLog.push(`Шаг ${stepCount}: ${step.tool} - ${step.description} - ✓ OK`);
            console.log(`  ✓ OK: ${step.tool} - ${step.description}`);
            lastResult = content;

            if (step.tool === 'browser_snapshot') {
              currentMessages.push({
                role: 'user',
                content: `Результат snapshot: ${content.substring(0, 1000)}`,
              });
            }
          }
        } catch (error: any) {
          executionLog.push(`Шаг ${stepCount}: ${step.tool} - ${step.description} - ✗ ОШИБКА`);
          console.log(`  ✗ ОШИБКА: ${step.tool} - ${step.description}`);
          console.log(`  Детали: ${error.message || String(error).substring(0, 200)}`);
          hasError = true;
          break;
        }
      }

      // Формируем итоговый ответ
      let finalResponse: string;
      if (hasError) {
        finalResponse = `✗ Выполнение завершено с ошибками:\n\n${executionLog.join('\n')}`;
      } else {
        finalResponse = `✓ Все шаги выполнены успешно:\n\n${executionLog.join('\n')}`;
      }

      return {
        textStream: (async function* () {
          yield finalResponse;
        })(),
        fullStream: (async function* () {
          yield { type: 'text-delta', text: finalResponse };
        })(),
      };
    },

    async close() {
      // Не закрываем браузер - оставляем сессию активной
      // Браузер остаётся открытым между запросами
    },
  };
}

// Функция для закрытия глобального MCP клиента при выходе
export async function closeGlobalMcpClient() {
  if (globalMcpClient) {
    await globalMcpClient.close();
    globalMcpClient = null;
    globalTools = [];
  }
}
