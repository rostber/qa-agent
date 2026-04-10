import * as readline from 'readline';
import { createAgent, closeGlobalMcpClient } from './agent.js';
import { SYSTEM_PROMPT } from './config/prompt.js';
import { LAST_URL_KEY, STATE_FILE, MAX_HISTORY, LOADING_FRAMES, LOADING_INTERVAL_MS } from './config/constants.js';
import { getLastUrl, setLastUrl, clearLastUrl } from './state.js';
import chalk from 'chalk';

// Команды
const PROMPT_PREFIX = '/prompt ';
const EXIT_COMMANDS = ['/exit', '/quit'];
const AUTO_OPEN_URL = '/auto-open';

// Цвета и стили
const styles = {
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.cyan,
  bold: chalk.bold,
  dim: chalk.dim,
  grey: chalk.gray,
  cyan: chalk.cyan,
  yellow: chalk.yellow,
  red: chalk.red,
  blue: chalk.blue,
};

function printWelcomeMessage() {
  const lastUrl = getLastUrl();
  console.log('\n' + styles.bold.bgBlue(' QA Agent CLI ') + '\n');
  console.log(styles.dim('Добро пожаловать в интерактивный чат с AI-агентом.'));
  console.log('');
  console.log(styles.bold('Ввод:'));
  console.log(`  ${styles.dim('-')} Введите сообщение и нажмите Enter для отправки`);
  console.log(`  ${styles.dim('-')} Для многострочного ввода: введите текст, нажмите Enter, затем пустую строку для отправки`);
  console.log('');
  console.log(styles.bold('Команды:'));
  console.log(`  ${styles.info('/open <url>')} — открыть браузер по адресу`);
  console.log(`  ${styles.info('/auto-open')} — открыть последнюю сохранённую URL (${lastUrl || 'не задан'})`);
  console.log(`  ${styles.info(`${PROMPT_PREFIX}<текст>`)} — установить системный промт`);
  console.log(`  ${styles.info('/exit, /quit')} — выйти из программы`);
  console.log('');
  console.log(styles.bold('Пример работы:'));
  console.log(`  ${styles.dim('1.')} ${styles.info('/open https://example.com')}`);
  console.log(`  ${styles.dim('2.')} Авторизуйтесь в браузере вручную`);
  console.log(`  ${styles.dim('3.')} ${styles.dim('"Перейди на /products и скажи заголовок"')}`);
  console.log('');
}

// Индикатор загрузки с цветами
let loadingInterval: NodeJS.Timeout | null = null;
let currentLoadingMessage = '';

function showLoading(message: string = 'Агент думает...', requestCounter: { count: number }) {
  let i = 0;
  
  loadingInterval = setInterval(() => {
    const count = requestCounter.count;
    const suffix = count === 1 ? 'запрос' : (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? 'запроса' : 'запросов');
    const status = count > 0 ? styles.dim(`(${count} ${suffix})`) : '';
    currentLoadingMessage = `\r${LOADING_FRAMES[i]} ${styles.cyan(message)} ${status}`;
    process.stdout.write(currentLoadingMessage);
    i = (i + 1) % LOADING_FRAMES.length;
  }, LOADING_INTERVAL_MS);
}

function stopLoading(success = true, resultMessage = '') {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
  }
  if (currentLoadingMessage) {
    process.stdout.write('\r' + ' '.repeat(currentLoadingMessage.length) + '\r');
    currentLoadingMessage = '';
  }
  if (resultMessage) {
    console.log(success ? styles.success('✓ ' + resultMessage) : styles.error('✗ ' + resultMessage));
  }
}

async function main() {
  let systemPrompt = SYSTEM_PROMPT;
  let agent: Awaited<ReturnType<typeof createAgent>> | null = null;
  const conversationHistory: any[] = [];
  let isProcessing = false;
  const requestCounter = { count: 0 };

  printWelcomeMessage();

  // Автоматически открываем последнюю URL при запуске
  const lastUrl = getLastUrl();
  if (lastUrl) {
    console.log(`${styles.info('➜')} ${styles.dim('Найдена сохранённая URL:')} ${styles.bold(lastUrl)}`);
    console.log(`${styles.dim('  Используйте /open <new-url> для открытия другой страницы.')}\n`);
    
    // Создаём агента и открываем страницу
    try {
      agent = await createAgent(systemPrompt, requestCounter);
      showLoading('Открываю сохранённую страницу...', requestCounter);
      await agent.chat(`Открой страницу ${lastUrl}`, []);
      stopLoading(true, 'Страница открыта');
    } catch (error: any) {
      stopLoading(false, 'Ошибка открытия сохранённой страницы');
      console.error(styles.red(`  ${error.message}`));
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Буфер для многострочного ввода
  let inputBuffer = '';

  const promptUser = () => {
    process.stdout.write('\n' + styles.bold.blue('Вы') + ': ');
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
      console.log(styles.yellow('До свидания!'));
      rl.close();
      process.exit(0);
    }

    if (trimmed.startsWith('/open ')) {
      const url = trimmed.slice(6).trim();
      if (!url) {
        console.log(styles.red('Использование: /open <url>'));
        promptUser();
        return;
      }
      console.log(`\n${styles.info('➜')} ${styles.cyan('Открываю браузер по адресу:')} ${styles.bold(url)}`);
      console.log(`${styles.dim('  Браузер должен открыться в видимом режиме.')}`);
      console.log(`${styles.dim('  Авторизуйтесь вручную, затем продолжайте работу с агентом.')}\n`);

      // Сохраняем URL
      setLastUrl(url);

      // Создаём агента при первой команде /open
      if (!agent) {
        showLoading('Инициализация агента...', requestCounter);
        try {
          agent = await createAgent(systemPrompt, requestCounter);
          stopLoading(true, 'Агент готов к работе');
        } catch (error: any) {
          stopLoading(false, 'Ошибка инициализации агента');
          console.error(styles.red(`  ${error.message}`));
          promptUser();
          return;
        }
      }

      // Открываем страницу
      showLoading('Открываю страницу...', requestCounter);
      await agent.chat(`Открой страницу ${url}`, []);
      stopLoading(true, 'Страница открыта');

      inputBuffer = '';
      promptUser();
      return;
    }

    // Команда для открытия последней сохранённой URL
    if (trimmed === AUTO_OPEN_URL) {
      const lastUrl = getLastUrl();
      if (!lastUrl) {
        console.log(styles.yellow('Нет сохранённой URL. Используйте /open <url> для сохранения.'));
        promptUser();
        return;
      }
      console.log(`${styles.info('➜')} ${styles.cyan('Открываю сохранённую URL:')} ${styles.bold(lastUrl)}`);

      if (!agent) {
        showLoading('Инициализация агента...', requestCounter);
        try {
          agent = await createAgent(systemPrompt, requestCounter);
          stopLoading(true, 'Агент готов к работе');
        } catch (error: any) {
          stopLoading(false, 'Ошибка инициализации агента');
          console.error(styles.red(`  ${error.message}`));
          promptUser();
          return;
        }
      }

      showLoading('Открываю страницу...', requestCounter);
      await agent.chat(`Открой страницу ${lastUrl}`, []);
      stopLoading(true, 'Страница открыта');

      inputBuffer = '';
      promptUser();
      return;
    }

    if (trimmed.startsWith(PROMPT_PREFIX)) {
      systemPrompt = trimmed.slice(PROMPT_PREFIX.length).trim();
      if (agent) {
        agent = await createAgent(systemPrompt, requestCounter);
      }
      console.log(`${styles.success('✓')} ${styles.cyan('Системный промт обновлён')}`);
      inputBuffer = '';
      promptUser();
      return;
    }

    if (!agent) {
      console.error(styles.red('Агент не инициализирован. Используйте /open <url> для начала.'));
      promptUser();
      return;
    }

    isProcessing = true;
    showLoading('Агент думает...', requestCounter);

    try {
      const result = await agent.chat(userInput, conversationHistory);

      // Останавливаем индикатор
      stopLoading();

      let fullResponse = '';
      for await (const chunk of result.textStream) {
        process.stdout.write(chunk);
        fullResponse += chunk;
      }
      console.log('\n');

      // Очищаем историю от tool результатов, оставляем только user/assistant
      const cleanHistory = conversationHistory.filter((msg: any) =>
        msg.role === 'user' || msg.role === 'assistant'
      );
      cleanHistory.push({ role: 'user', content: userInput });
      cleanHistory.push({ role: 'assistant', content: fullResponse });

      // Ограничиваем размер истории (последние 50 сообщений)
      if (cleanHistory.length > MAX_HISTORY) {
        cleanHistory.splice(0, cleanHistory.length - MAX_HISTORY);
      }

      // Обновляем conversationHistory
      conversationHistory.length = 0;
      conversationHistory.push(...cleanHistory);

      // Сбрасываем счётчик запросов
      requestCounter.count = 0;
    } catch (error: any) {
      stopLoading(false, 'Ошибка при обработке запроса');
      console.error(styles.red(`  ${error.message}`));
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
  console.error(styles.red.bold('Критическая ошибка:'), error);
  process.exit(1);
});
