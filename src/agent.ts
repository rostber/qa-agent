import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { z } from 'zod';
import { getEnv } from './env.js';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

// Глобальный MCP клиент - один на всю сессию
let globalMcpClient: any = null;
let globalTools: Tool[] = [];

async function getMcpClient() {
  if (!globalMcpClient) {
    const { createPlaywrightMcpClient } = await import('./mcp-client.js');
    globalMcpClient = await createPlaywrightMcpClient();
    const tools = await globalMcpClient.listTools();
    globalTools = tools.tools;
  }
  return { client: globalMcpClient, tools: globalTools };
}

// Преобразуем JSON Schema в zod схему с поддержкой больше типов
function jsonSchemaToZod(schema: any): z.ZodTypeAny {
  if (!schema) return z.unknown();

  // Обработка enum
  if (schema.enum) {
    return z.enum(schema.enum as [string, ...string[]]);
  }

  // Обработка oneOf/anyOf - берём первый вариант
  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf || schema.anyOf).slice(0, 1);
    if (variants.length > 0) {
      return jsonSchemaToZod(variants[0]);
    }
  }

  switch (schema.type) {
    case 'object': {
      const shape: Record<string, any> = {};
      const required = schema.required || [];

      for (const [key, value] of Object.entries(schema.properties || {})) {
        let fieldSchema = jsonSchemaToZod(value);
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
    if (result.content.length === 0) return 'Пустой результат';
    return result.content
      .map((c: any) => c.text || c || JSON.stringify(c))
      .filter((t: string) => t && t !== 'undefined' && t !== 'null')
      .join('\n');
  }
  const str = JSON.stringify(result);
  return str === '{}' ? 'Пустой результат' : str;
}

// Генерируем список инструментов для системного промта
function generateToolsPrompt(tools: Tool[]): string {
  const toolList = tools.map(t =>
    `- ${t.name}: ${t.description}`
  ).join('\n');

  return `ДОСТУПНЫЕ ИНСТРУМЕНТЫ:
${toolList}`;
}

// Валидация URL
function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function createAgent(systemPrompt: string, requestCounter: { count: number }) {
  const config = getEnv();
  const { client: mcpClient, tools } = await getMcpClient();

  const openai = createOpenAI({
    apiKey: config.apiToken,
    baseURL: config.baseUrl,
  });

  // Добавляем список инструментов в системный промт (используем только fullSystemPrompt)
  const toolsPrompt = generateToolsPrompt(tools);
  const fullSystemPrompt = `${systemPrompt}\n\n${toolsPrompt}`;

  const mcpToolMap: Record<string, { description: string; parameters: z.ZodTypeAny; execute: (args: any) => Promise<{ content: string }> }> = {};
  
  for (const tool of tools) {
    const zodSchema = jsonSchemaToZod(tool.inputSchema);

    // Для browser_click используем только ref (согласно схеме MCP)
    if (tool.name === 'browser_click') {
      mcpToolMap[tool.name] = {
        description: tool.description ?? '',
        parameters: z.object({
          ref: z.string().describe('Exact target element reference from the page snapshot (например, "e3")'),
          element: z.string().optional().describe('Human-readable element description'),
          doubleClick: z.boolean().optional().describe('Whether to perform a double click'),
          button: z.enum(['left', 'right', 'middle']).optional().describe('Button to click'),
          modifiers: z.array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'])).optional().describe('Modifier keys to press'),
        }),
        execute: async (args: any) => {
          // Валидация: ref обязателен
          if (!args.ref || typeof args.ref !== 'string') {
            return { content: '### Error: ref обязателен для browser_click' };
          }

          // Retry с коротким ожиданием — даёт Playwright время на ожидание элемента
          const maxRetries = 2;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
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
                { timeout: 5000 } // 5 секунд — достаточно для клика
              );
              return { content: formatMcpResult(result) };
            } catch (error: any) {
              const errorMsg = error.message || String(error);
              const isTimeout = errorMsg.includes('Timeout');
              
              // Если это последняя попытка или не таймаут, возвращаем ошибку
              if (attempt === maxRetries || !isTimeout) {
                return { content: `### Error: ${errorMsg.substring(0, 500)}` };
              }
              
              // Короткая задержка перед повторной попыткой — даёт странице время на рендер
              await new Promise(resolve => setTimeout(resolve, 500));
            }
          }
          return { content: '### Error: Не удалось выполнить клик' };
        },
      };
    } else if (tool.name === 'browser_wait_for') {
      mcpToolMap[tool.name] = {
        description: tool.description ?? '',
        parameters: z.object({
          text: z.string().optional().describe('Текст для ожидания'),
          time: z.number().optional().describe('Время в мс'),
        }),
        execute: async (args: any) => {
          // Преобразуем строку в число если нужно
          if (args.time && typeof args.time === 'string') {
            args.time = parseInt(args.time, 10);
          }

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
          if (args.time && typeof args.time === 'number') {
            // Для time используем простую задержку без MCP вызова
            await new Promise(resolve => setTimeout(resolve, args.time));
            return { content: `Подождено ${args.time}мс` };
          }
          return { content: '### Error: Нет ни text ни time' };
        },
      };
    } else if (tool.name === 'browser_navigate') {
      mcpToolMap[tool.name] = {
        description: tool.description ?? '',
        parameters: z.object({
          url: z.string().describe('URL для перехода'),
        }),
        execute: async (args: any) => {
          // Валидация URL
          if (!args.url || !isValidUrl(args.url)) {
            return { content: `### Error: Неверный URL: ${args.url || '(пусто)'}` };
          }
          
          const result = await mcpClient.callTool(
            {
              name: 'browser_navigate',
              arguments: { url: args.url },
            },
            undefined,
            { timeout: 30000 }
          );
          return { content: formatMcpResult(result) };
        },
      };
    } else {
      mcpToolMap[tool.name] = {
        description: tool.description ?? '',
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
      // Используем fullSystemPrompt (с инструментами) вместо systemPrompt
      const messages: any[] = [
        { role: 'system', content: fullSystemPrompt },
        ...conversationHistory,
        { role: 'user', content: userMessage },
      ];

      let executionLog: string[] = [];
      let stepCount = 0;
      const maxSteps = 30; // Увеличили до 30 для сложных задач
      let hasError = false;
      let lastResult = '';
      let consecutiveErrors = 0;
      const maxConsecutiveErrors = 3; // Максимум 3 ошибки подряд перед остановкой
      const recentActions: string[] = []; // История последних действий для обнаружения зацикливания
      const maxRecentActions = 5; // Сколько последних действий хранить
      const maxRepeatedActions = 5; // Максимум повторений одного действия перед остановкой (увеличено с 3 до 5)
      let lastErrorStep = 0; // Номер шага когда была последняя ошибка
      
      // Для оптимизации запросов к LLM
      let lastSnapshotHash: string | null = null;
      let unchangedSnapshotCount = 0;
      const maxUnchangedSnapshots = 5; // Максимум snapshot без изменений перед остановкой
      let lastExecutedTool: string | null = null; // Запоминаем последний выполненный инструмент
      let iterationCount = 0; // Счётчик итераций (для пропуска проверки на первом шаге)

      // Выполняем шаги циклически: планируем -> выполняем -> повторяем
      while (stepCount < maxSteps) {
        stepCount++;
        iterationCount++;

        // 1. Делаем snapshot локально (без запроса к LLM) для проверки изменений
        // На первом шаге всегда делаем snapshot чтобы агент увидел состояние страницы
        // После действий меняющих страницу — делаем snapshot для проверки изменений
        let currentSnapshot: any = null;
        const toolsThatChangePage = ['browser_navigate', 'browser_click', 'browser_hover', 'browser_press_key', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_drag'];
        
        const shouldTakeSnapshot = iterationCount === 1 || (lastExecutedTool && toolsThatChangePage.includes(lastExecutedTool));
        
        if (shouldTakeSnapshot) {
          try {
            const snapshotTool = mcpToolMap['browser_snapshot'];
            if (snapshotTool) {
              const snapshotResult = await snapshotTool.execute({});
              currentSnapshot = { content: formatMcpResult(snapshotResult) };
            }
          } catch (error: any) {
            currentSnapshot = null;
          }
        }

        // 2. Проверяем изменился ли snapshot (пропускаем проверку на первом шаге)
        const shouldPlanNextStep = iterationCount === 1 || !currentSnapshot || !lastSnapshotHash || currentSnapshot.content !== lastSnapshotHash;

        if (!shouldPlanNextStep && currentSnapshot) {
          // Snapshot не изменился — нет смысла делать запрос к LLM
          unchangedSnapshotCount++;
          
          if (unchangedSnapshotCount >= maxUnchangedSnapshots) {
            executionLog.push(`Прекращаю выполнение: страница не меняется (${maxUnchangedSnapshots} раз подряд)`);
            console.log(`  ✗ ОШИБКА: Страница не меняется (${maxUnchangedSnapshots} раз подряд)`);
            hasError = true;
            break;
          }
          
          // Короткая задержка перед повторной проверкой
          await new Promise(resolve => setTimeout(resolve, 300));
          continue;
        }

        // Сбрасываем счётчик неизменённых snapshot
        if (currentSnapshot) {
          lastSnapshotHash = currentSnapshot.content;
          unchangedSnapshotCount = 0;
        }

        // 3. Snapshot изменился или это первый шаг — генерируем план (запрос к LLM)
        let planResult: any;
        let retries = 0;
        const maxRetries = 3;

        while (retries < maxRetries) {
          try {
            requestCounter.count++;

            // Формируем контекст последних snapshot для промта
            const recentSnapshots = messages
              .filter((m: any) => m.role === 'user' && m.content.includes('Результат browser_snapshot'))
              .slice(-2) // Берём последние 2 snapshot
              .map((m: any) => m.content)
              .join('\n\n');
            
            // На первом шаге добавляем текущий snapshot в промт
            const currentSnapshotContext = (iterationCount === 1 && currentSnapshot) 
              ? `Текущее состояние страницы:\n${currentSnapshot.content.substring(0, 3000)}`
              : '';

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
${currentSnapshotContext}
${recentSnapshots ? `\nПоследние snapshot страницы:\n${recentSnapshots}` : ''}
Результаты выполненных шагов: ${executionLog.slice(-5).join('; ')}
Следующий шаг (tool, args, description, continue).
Если все действия из задачи выполнены, установи continue=false.`,
            });
            break;
          } catch (error: any) {
            retries++;
            if (retries >= maxRetries) {
              executionLog.push(`Ошибка генерации плана после ${maxRetries} попыток: ${error.message?.substring(0, 100) || 'неизвестная ошибка'}`);
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

        // Отслеживаем повторяющиеся действия для обнаружения зацикливания
        const actionKey = `${step.tool}:${step.description.substring(0, 30)}`;
        recentActions.push(actionKey);
        if (recentActions.length > maxRecentActions) {
          recentActions.shift();
        }

        // Проверяем на зацикливание (одно и то же действие повторяется много раз)
        // НО: пропускаем проверку если это snapshot сразу после ошибки (разумное поведение)
        const repeatedCount = recentActions.filter(a => a === actionKey).length;
        const isSnapshotAfterError = step.tool === 'browser_snapshot' && (stepCount - lastErrorStep) <= 1;

        if (repeatedCount >= maxRepeatedActions && step.tool === 'browser_snapshot' && !isSnapshotAfterError) {
          executionLog.push(`Прекращаю выполнение: агент зациклился на ${step.tool} (${repeatedCount} раз подряд)`);
          console.log(`  ✗ ОШИБКА: Агент зациклился на ${step.tool} (${repeatedCount} раз подряд)`);
          hasError = true;
          break;
        }

        executionLog.push(`Шаг ${stepCount}: ${step.tool} - ${step.description}`);

        const tool = mcpToolMap[step.tool];
        if (!tool) {
          executionLog.push(`  ✗ Инструмент "${step.tool}" не найден`);
          console.log(`  ✗ ОШИБКА: Инструмент "${step.tool}" не найден`);
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
            consecutiveErrors++;
            lastErrorStep = stepCount; // Запоминаем шаг с ошибкой
            executionLog.push(`Шаг ${stepCount}: ${step.tool} - ${step.description} - ✗ ОШИБКА`);
            console.log(`  ✗ ОШИБКА: ${step.tool} - ${step.description}`);
            console.log(`  Детали: ${content.substring(0, 300)}`);

            // Запоминаем последний выполненный инструмент (даже при ошибке)
            lastExecutedTool = step.tool;

            // Если 3 ошибки подряд - останавливаемся
            if (consecutiveErrors >= maxConsecutiveErrors) {
              executionLog.push(`Прекращаю выполнение после ${maxConsecutiveErrors} ошибок подряд`);
              hasError = true;
              break;
            }

            // Добавляем информацию об ошибке в промт для следующего шага
            lastResult = `ОШИБКА: ${content.substring(0, 500)}`;
          } else {
            consecutiveErrors = 0; // Сброс счётчика ошибок
            executionLog.push(`Шаг ${stepCount}: ${step.tool} - ${step.description} - ✓ OK`);
            console.log(`  ✓ OK: ${step.tool} - ${step.description}`);
            lastResult = content;
            
            // Запоминаем последний выполненный инструмент для оптимизации snapshot
            lastExecutedTool = step.tool;

            // Добавляем результат snapshot в контекст для следующего шага
            if (step.tool === 'browser_snapshot') {
              // Добавляем snapshot в messages чтобы агент видел результат
              messages.push({
                role: 'user',
                content: `Результат browser_snapshot:\n${content.substring(0, 5000)}`,
              });
            }
          }
        } catch (error: any) {
          consecutiveErrors++;
          lastErrorStep = stepCount; // Запоминаем шаг с ошибкой
          executionLog.push(`Шаг ${stepCount}: ${step.tool} - ${step.description} - ✗ ОШИБКА`);
          console.log(`  ✗ ОШИБКА: ${step.tool} - ${step.description}`);
          console.log(`  Детали: ${error.message || String(error).substring(0, 200)}`);
          
          // Запоминаем последний выполненный инструмент
          lastExecutedTool = step.tool;

          // Если 3 ошибки подряд - останавливаемся
          if (consecutiveErrors >= maxConsecutiveErrors) {
            executionLog.push(`Прекращаю выполнение после ${maxConsecutiveErrors} ошибок подряд`);
            hasError = true;
            break;
          }
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
