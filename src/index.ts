import { join } from 'path';

export const cwd = process.cwd();
export const data_dir = join(cwd, 'data');
export const bot_dir = join(data_dir, 'bot');
export const modules_dir = join(cwd, 'node_modules');
export const plugins_dir = join(cwd, 'plugins');

export * from './bot';
export * from './utils';
