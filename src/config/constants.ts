import { join } from 'path';

// Файлы
export const STATE_FILE = join(process.cwd(), '.qa-agent-state.json');

// Ключи состояния
export const LAST_URL_KEY = 'lastUrl';

// История
export const MAX_HISTORY = 50;

// Индикатор загрузки
export const LOADING_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const LOADING_INTERVAL_MS = 80;

// Команды
export const PROMPT_PREFIX = '/prompt ';
export const EXIT_COMMANDS = ['/exit', '/quit'];
export const AUTO_OPEN_URL = '/auto-open';
