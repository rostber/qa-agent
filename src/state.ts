import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { STATE_FILE, LAST_URL_KEY } from './config/constants.js';

export interface AppState {
  [LAST_URL_KEY]?: string;
  [key: string]: any;
}

export function loadState(): AppState {
  try {
    if (existsSync(STATE_FILE)) {
      const data = readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Ошибка загрузки состояния:', error);
  }
  return {};
}

export function saveState(state: AppState): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Ошибка сохранения состояния:', error);
  }
}

export function getLastUrl(): string | undefined {
  return loadState()[LAST_URL_KEY];
}

export function setLastUrl(url: string): void {
  const state = loadState();
  state[LAST_URL_KEY] = url;
  saveState(state);
}

export function clearLastUrl(): void {
  const state = loadState();
  delete state[LAST_URL_KEY];
  saveState(state);
}
