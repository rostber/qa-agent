import * as readline from 'readline';
import { createAgent, closeGlobalMcpClient } from './agent.js';

const PROMPT_PREFIX = '/prompt ';
const EXIT_COMMANDS = ['/exit', '/quit'];

function printWelcomeMessage() {
  console.log('\n=== QA Agent CLI ===');
  console.log('Добро пожаловать в интерактивный чат с AI-агентом.');
  console.log('');
  console.log('Ввод:');
  console.log('  - Введите сообщение и нажмите Enter для отправки');
  console.log('  - Для многострочного ввода: введите текст, нажмите Enter, затем пустую строку для отправки');
  console.log('');
  console.log('Команды:');
  console.log('  /open <url> — открыть браузер по адресу (для ручной авторизации)');
  console.log(`  ${PROMPT_PREFIX}<текст> — установить системный промт`);
  console.log('  /exit, /quit — выйти из программы');
  console.log('');
  console.log('Пример работы:');
  console.log('  1. /open https://example.com');
  console.log('  2. Авторизуйтесь в браузере вручную');
  console.log('  3. "Перейди на /products и скажи заголовок"');
  console.log('');
}

// Индикатор загрузки
function showLoading(requestCounter: { count: number }) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const interval = setInterval(() => {
    const count = requestCounter.count;
    const suffix = count === 1 ? 'запрос' : (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? 'запроса' : 'запросов');
    process.stdout.write(`\r${frames[i]} Агент думает... (${count} ${suffix})`);
    i = (i + 1) % frames.length;
  }, 80);
  return interval;
}

async function main() {
  let systemPrompt = `ТЫ — QA-АГЕНТ С ДОСТУПОМ К БРАУЗЕРУ ЧЕРЕЗ PLAYWRIGHT MCP.

БРАУЗЕР УЖЕ ОТКРЫТ И ГОТОВ К РАБОТЕ.

КРИТИЧЕСКИЕ ПРАВИЛА:
1. НИКОГДА не задавай вопросов пользователю.
2. Выполняй задачи ПОЛНОСТЬЮ — все шаги из запроса пользователя должны быть выполнены.
3. НЕ устанавливай continue=false пока не выполнишь ВСЕ шаги из запроса.
4. ПОСЛЕ browser_navigate делай browser_snapshot чтобы увидеть что на странице.
5. После выполнения ВСЕХ шагов дай краткий итоговый ответ и установи continue=false.
6. Если ошибка — объясни ПОЧЕМУ и установи continue=false.
7. ВАЖНО: Для browser_click используй ТОЛЬКО ref из snapshot (например, "ref=e3"), НЕ текст элемента!

ПРИМЕРЫ ИСПОЛЬЗОВАНИЯ ИНСТРУМЕНТОВ:

browser_navigate:
- {"url": "https://example.com"} — перейти по URL

browser_snapshot:
- {} — получить снимок страницы с доступными элементами

browser_click:
- {"ref": "e3", "element": "Example Domain heading"} — кликнуть по элементу с ref=e3
  ВАЖНО: ref берётся из snapshot, где элементы выглядят как: heading "Text" [ref=e3]

browser_wait_for:
- {"text": "Добро пожаловать"} — ждать появления текста
- {"time": 3000} — ждать 3 секунды

browser_type:
- {"element": "поле ввода", "text": "hello"} — ввести текст

browser_hover:
- {"element": "меню"} — навести курсор

browser_press_key:
- {"key": "Enter"} — нажать клавишу

ПРИМЕР РАБОТЫ:
Пользователь: "Нажми кнопку Войти"
- Шаг 1: browser_snapshot — увидеть страницу
  Snapshot показывает: - button "Войти" [ref=b5]
- Шаг 2: browser_click (ref: "b5", element: "Войти") — нажать кнопку
- Шаг 3: continue=false — задача выполнена

ПРИМЕР С НАВИГАЦИЕЙ:
Пользователь: "Перейди на example.com и нажми ссылку Learn more"
- Шаг 1: browser_navigate (url: "https://example.com")
- Шаг 2: browser_snapshot — увидеть страницу
  Snapshot показывает: - link "Learn more" [ref=e6]
- Шаг 3: browser_click (ref: "e6", element: "Learn more") — нажать ссылку
- Шаг 4: continue=false — задача выполнена
`;
  let agent: Awaited<ReturnType<typeof createAgent>> | null = null;
  const conversationHistory: any[] = [];
  let isProcessing = false;
  const requestCounter = { count: 0 };

  printWelcomeMessage();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Буфер для многострочного ввода
  let inputBuffer = '';

  const promptUser = () => {
    process.stdout.write('\nВы: ');
  };

  const processInput = (line: string) => {
    // Отправляем сразу при первом вводе
    if (inputBuffer === '' && line.trim() !== '') {
      handleInput(line);
      inputBuffer = '';
      return;
    }
    
    // Добавляем строку к буферу для многострочного ввода
    if (inputBuffer) {
      inputBuffer += '\n' + line;
    } else {
      inputBuffer = line;
    }
    
    // Отправляем когда пользователь нажимает Enter на пустой строке
    if (line.trim() === '' && inputBuffer.trim() !== '') {
      handleInput(inputBuffer);
      inputBuffer = '';
      return;
    }
    
    // Показываем промпт для продолжения ввода
    promptUser();
  };

  const handleInput = async (userInput: string) => {
    const trimmed = userInput.trim();
    
    // Проверка команд
    if (EXIT_COMMANDS.includes(trimmed.toLowerCase())) {
      console.log('До свидания!');
      rl.close();
      process.exit(0);
    }

    if (trimmed.startsWith('/open ')) {
      const url = trimmed.slice(6).trim();
      if (!url) {
        console.log('Использование: /open <url>');
        promptUser();
        return;
      }
      console.log(`\nОткрываю браузер по адресу: ${url}`);
      console.log('Браузер должен открыться в видимом режиме.');
      console.log('Авторизуйтесь вручную, затем продолжайте работу с агентом.\n');

      // Создаём агента при первой команде /open
      if (!agent) {
        try {
          agent = await createAgent(systemPrompt, requestCounter);
        } catch (error) {
          console.error('Ошибка инициализации агента:', error);
          promptUser();
          return;
        }
      }

      // Открываем страницу
      await agent.chat(`Открой страницу ${url}`, []);

      inputBuffer = '';
      promptUser();
      return;
    }

    if (trimmed.startsWith(PROMPT_PREFIX)) {
      systemPrompt = trimmed.slice(PROMPT_PREFIX.length).trim();
      if (agent) {
        agent = await createAgent(systemPrompt, requestCounter);
      }
      console.log(`Системный промт обновлён: "${systemPrompt}"`);
      inputBuffer = '';
      promptUser();
      return;
    }

    if (!agent) {
      console.error('Агент не инициализирован');
      promptUser();
      return;
    }

    isProcessing = true;
    const loadingInterval = showLoading(requestCounter);

    try {
      const result = await agent.chat(userInput, conversationHistory);

      // Останавливаем индикатор
      clearInterval(loadingInterval);

      let fullResponse = '';
      for await (const chunk of result.textStream) {
        process.stdout.write(chunk);
        fullResponse += chunk;
      }
      console.log('\n\n');

      // Очищаем историю от tool результатов, оставляем только user/assistant
      const cleanHistory = conversationHistory.filter((msg: any) =>
        msg.role === 'user' || msg.role === 'assistant'
      );
      cleanHistory.push({ role: 'user', content: userInput });
      cleanHistory.push({ role: 'assistant', content: fullResponse });

      // Ограничиваем размер истории (последние 50 сообщений)
      const MAX_HISTORY = 50;
      if (cleanHistory.length > MAX_HISTORY) {
        cleanHistory.splice(0, cleanHistory.length - MAX_HISTORY);
      }

      // Обновляем conversationHistory
      conversationHistory.length = 0;
      conversationHistory.push(...cleanHistory);

      // Сбрасываем счётчик запросов
      requestCounter.count = 0;
    } catch (error) {
      clearInterval(loadingInterval);
      console.error('\nОшибка при обработке запроса:', error);
    } finally {
      isProcessing = false;
      promptUser();
    }
  };

  rl.on('line', (line) => {
    if (isProcessing) return;
    processInput(line);
  });

  rl.on('close', async () => {
    await closeGlobalMcpClient();
  });

  promptUser();
}

main().catch((error) => {
  console.error('Критическая ошибка:', error);
  process.exit(1);
});
