import dotenv from 'dotenv';

dotenv.config();

export interface Config {
  apiToken: string;
  baseUrl: string;
  model: string;
}

export function getConfig(): Config {
  const apiToken = process.env.OPENAI_API_TOKEN;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL;

  if (!apiToken) {
    throw new Error('OPENAI_API_TOKEN is not set in .env file');
  }
  if (!baseUrl) {
    throw new Error('OPENAI_BASE_URL is not set in .env file');
  }
  if (!model) {
    throw new Error('OPENAI_MODEL is not set in .env file');
  }

  return {
    apiToken,
    baseUrl,
    model,
  };
}
