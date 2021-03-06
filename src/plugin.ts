import { join } from 'path';
import { EventMap } from 'oicq';
import { Dirent } from 'fs';
import { mkdir, readdir } from 'fs/promises';
import { EventEmitter } from 'events';
import { Job, JobCallback, scheduleJob } from 'node-schedule';

import { BotClient, getBot, getBotList } from './bot';
import { Listen } from './listen';
import { deepClone, deepMerge, logger } from './utils';
import { modules_dir, plugins_dir } from '.';
import { AllMessageEvent } from './events';
import { Command, commandEvent, CommandMessageType } from './command';
import { getSetting } from './setting';

interface PluginDirs {
  modules: string[];
  plugins: string[];
}

// 插件选项
export interface Option {
  // 锁定，默认 false
  lock: boolean;
  // 开关，默认 true
  apply: boolean;
  // 其它设置
  [param: string]: string | number | boolean | Array<string | number>;
}

const plugin_list: Map<string, Plugin> = new Map();

export class Plugin extends EventEmitter {
  private ver: string;

  private name!: string;
  private path!: string;

  private args: (string | string[])[];
  private jobs: Job[];
  private bot_list: Map<number, BotClient>;
  private events: Set<string>;
  private command_list: Map<string, Command>;
  private listen_list: Map<string, Listen>;
  private init_func?: () => any;
  private bind_func?: (bot: BotClient) => any;

  constructor(
    public prefix: string = '',
    private option: Option = { apply: true, lock: false },
  ) {
    super();
    this.ver = '0.0.0';
    this.args = [];
    this.jobs = [];
    this.bot_list = new Map();
    this.events = new Set();
    this.command_list = new Map();
    this.listen_list = new Map();

    //#region 更新指令
    const updateCommand = new Command('group', 'update <key> <value>', this)
      .description('群服务列表')
      .action(function (key: string, value: string) {
        this.update(key, value)
          .then(message => this.event.reply(message))
          .catch(error => this.event.reply(error.message))
      });
    //#endregion
    //#region 帮助指令
    const helpCommand = new Command('all', 'help', this)
      .description('帮助信息')
      .action(function () {
        const message = ['Commands: '];

        for (const [_, command] of this.plugin.command_list) {
          const { raw_name, desc } = command;
          message.push(`  ${raw_name}  ${desc}`);
        }
        this.event.reply(message.join('\n'));
      });
    //#endregion
    //#region 版本指令
    const versionCommand = new Command('all', 'version', this)
      .description('版本信息')
      .action(function () {
        const plugin = this.plugin;

        this.event.reply(`${plugin.name} v${plugin.ver}`);
      });
    //#endregion

    this.parse = this.parse.bind(this);
    this.on('plugin.bind', this.bindEvents);

    setTimeout(() => {
      this.command_list.set(helpCommand.name, helpCommand);
      this.command_list.set(updateCommand.name, updateCommand);
      this.command_list.set(versionCommand.name, versionCommand);
    });
  }

  init(name: string, path: string) {
    this.name = name;
    this.path = path;

    return this;
  }

  command<T extends keyof commandEvent>(raw_name: string, message_type: T | CommandMessageType = 'all'): Command<T> {
    const command = new Command(message_type, raw_name, this);

    this.events.add('message');
    this.command_list.set(command.name, command);
    return command as unknown as Command<T>;
  }

  listen<T extends keyof EventMap>(event_name: T) {
    const listen = new Listen(event_name, this);

    this.events.add(event_name);
    this.listen_list.set(event_name, listen);
    return listen;
  }

  schedule(cron: string, func: JobCallback) {
    const job = scheduleJob(cron, func);

    this.jobs.push(job);
    return this;
  }

  version(ver: string) {
    this.ver = ver;
    return this;
  }

  onInit(callback: () => any) {
    this.init_func = callback;
    return this;
  }

  onBind(callback: (bot: BotClient) => any) {
    this.bind_func = callback;
    this.on('plugin.bind', this.bind_func);
    this.once('plugin.unbind', this.bind_func);

    return this;
  }

  private clearSchedule() {
    for (const job of this.jobs) {
      job.cancel();
    }
  }

  // 指令解析器
  private parse(event: AllMessageEvent) {
    for (const [_, command] of this.command_list) {
      if (command.isMatched(event)) {
        this.args = command.parseArgs(event.raw_message);
        this.runCommand(command);
        // TODO ⎛⎝≥⏝⏝≤⎛⎝ 插件事件
        // this.emit(`plugin.${this.name}`, event);
      }
    }
  }

  // 执行指令
  private runCommand(command: Command) {
    const args_length = this.args.length;

    for (let i = 0; i < args_length; i++) {
      const { required, value } = command.args[i];
      const argv = this.args[i];

      if (required && !argv) {
        return command.event.reply(`Error: <${value}> cannot be empty`);
      } else if (required && !argv.length) {
        return command.event.reply(`Error: <...${value}> cannot be empty`);
      }
    }

    if (command.isLimit()) {
      command.event.reply('权限不足');
    } else if (command.func && this.prefix === '') {
      command.func(...this.args);
    } else if (command.message_type !== 'private' && command.stop && !command.isApply()) {
      command.stop();
    } else if (command.message_type !== 'private' && command.func && command.isApply()) {
      command.func(...this.args);
    } else if (command.event.message_type === 'private' && command.func) {
      command.func(...this.args);
    }
  }

  // 绑定 bot 事件
  bindEvents(bot: BotClient): void {
    for (const event_name of this.events) {
      if (event_name === 'message') {
        bot.on(event_name, this.parse);
        this.once('plugin.unbind', () => bot.off(event_name, this.parse));
      } else {
        const listen = this.listen_list.get(event_name)!;

        bot.on(event_name, listen.func);
        this.once('plugin.unbind', () => bot.off(event_name, listen.func));
      }
    }
  }

  getOption() {
    // 深拷贝防止 default option 被修改
    return deepClone(this.option);
  }

  getName() {
    return this.name;
  }

  getBot(uin: number): BotClient {
    if (!this.bot_list.has(uin)) {
      throw new Error(`bot "${uin}" is undefined`);
    }
    return this.bot_list.get(uin)!;
  }

  getBotList(): Map<number, BotClient> {
    return this.bot_list;
  }

  bindBot(bot: BotClient): Plugin {
    const { uin } = bot;

    if (this.bot_list.has(uin)) {
      throw new Error(`bot is already bind with "${this.name}"`);
    }
    this.bot_list.set(uin, bot);
    this.emit('plugin.bind', bot);
    return this;
  }

  unbindBot(bot: BotClient): void {
    const { uin } = bot;

    if (!this.bot_list.has(uin)) {
      throw new Error(`bot is not bind with "${this.name}"`);
    }
    this.clearSchedule();
    this.bot_list.delete(uin);
    this.emit('plugin.unbind');
  }

  // 销毁
  destroy() {
    for (const [_, bot] of this.bot_list) {
      this.unbindBot(bot);
    }
    this.off('plugin.bind', this.bindEvents);
    plugin_list.delete(this.name);
    destroyPlugin(this.path);
  }
}

/**
 * 检索可用插件目录
 *
 * @returns {Promise<PluginDirs>}
 */
export async function findPlugin(): Promise<PluginDirs> {
  const modules: string[] = [];
  const plugins: string[] = [];
  const module_dirs: Dirent[] = [];
  const plugin_dirs: Dirent[] = [];

  try {
    const dirs = await readdir(plugins_dir, { withFileTypes: true });
    plugin_dirs.push(...dirs);
  } catch (error) {
    await mkdir(plugins_dir);
  }

  for (const dir of plugin_dirs) {
    if (dir.isDirectory() || dir.isSymbolicLink()) {
      const plugin_path = join(plugins_dir, dir.name);

      try {
        require.resolve(plugin_path);
        plugins.push(dir.name);
      } catch { }
    }
  }

  try {
    const dirs = await readdir(modules_dir, { withFileTypes: true });
    module_dirs.push(...dirs);
  } catch (err) {
    await mkdir(modules_dir);
  }

  for (const dir of module_dirs) {
    if (dir.isDirectory() && dir.name.startsWith('kokkoro-plugin-')) {
      const module_path = join(modules_dir, dir.name);

      try {
        require.resolve(module_path);
        modules.push(dir.name);
      } catch { }
    }
  }

  return {
    modules, plugins,
  }
}

/**
 * 导入插件模块
 *
 * @param {string} name - 模块名
 * @returns {Promise<Plugin>} 插件实例对象
 */
async function importPlugin(name: string): Promise<Plugin> {
  // 移除文件名前缀
  const plugin_name = name.replace('kokkoro-plugin-', '');

  if (plugin_list.has(plugin_name)) return getPlugin(plugin_name);

  let plugin_path = '';
  try {
    const { modules, plugins } = await findPlugin();

    for (const raw_name of plugins) {
      if (raw_name === name || raw_name === 'kokkoro-plugin-' + name) {
        plugin_path = join(plugins_dir, raw_name);
        break;
      }
    }

    // 匹配 npm 模块
    if (!plugin_path) {
      for (const raw_name of modules) {
        if (raw_name === name || raw_name === 'kokkoro-plugin-' + name) {
          plugin_path = join(modules_dir, raw_name);
          break;
        }
      }
    }
    if (!plugin_path) throw new Error('cannot find this plugin');

    const { plugin } = require(plugin_path) as { plugin?: Plugin };

    if (plugin instanceof Plugin) {
      const require_path = require.resolve(plugin_path);

      plugin.init(plugin_name, require_path);
      plugin_list.set(plugin_name, plugin);
      return plugin;
    }
    throw new Error(`plugin not instantiated`);
  } catch (error) {
    const message = `"${name}" import module failed, ${(error as Error).message}`;
    logger.error(message);
    // destroyPlugin(require.resolve(plugin_path));
    throw new Error(message);
  }
}

/**
 * 销毁插件
 *
 * @param plugin_path - 插件路径
 */
function destroyPlugin(plugin_path: string) {
  const module = require.cache[plugin_path];
  const index = module?.parent?.children.indexOf(module);

  if (!module) {
    return;
  }
  if (index && index >= 0) {
    module.parent?.children.splice(index, 1);
  }

  for (const path in require.cache) {
    if (require.cache[path]?.id.startsWith(module.path)) {
      delete require.cache[path]
    }
  }

  delete require.cache[plugin_path];
}

/**
 * 获取插件实例
 *
 * @param {string} name - 插件名
 * @returns {Plugin} 插件实例
 */
export function getPlugin(name: string): Plugin {
  if (!plugin_list.has(name)) {
    throw new Error(`plugin "${name}" is undefined`);
  }
  return plugin_list.get(name)!;
}

export function getPluginList(): Map<string, Plugin> {
  return plugin_list;
}

/**
 * 启用插件
 * 
 * @param name - plugin name
 * @param uin - bot uin
 * @returns {Promise}
 */
export async function enablePlugin(name: string, uin: number): Promise<void> {
  try {
    await importPlugin(name);
    // 如果插件已被导入，仅绑定当前 bot ，否则绑定全部
    plugin_list.has(name)
      ? bindBot(name, uin)
      : bindAllBot(name);
  } catch (error) {
    throw error;
  }
}

/**
 * 禁用插件
 * 
 * @param name - plugin name
 * @param uin - bot uin
 */
export function disablePlugin(name: string, uin: number): void {
  try {
    getPlugin(name);
    unbindBot(name, uin);
  } catch (error) {
    throw error;
  }
}

/**
 * 重载插件
 *
 * @param {string} name - plugin name
 * @returns {Promise}
 */
export async function reloadPlugin(name: string): Promise<void> {
  try {
    const plugin = getPlugin(name);
    const bots = [...plugin.getBotList()];

    plugin.destroy();
    const ext = await importPlugin(name);

    for (const [_, bot] of bots) {
      ext.bindBot(bot);
    }
  } catch (error) {
    throw error;
  }
}

/**
 * 插件绑定 bot
 *
 * @param {string} name - plugin name
 * @param {number} uin - bot uin
 */
export function bindBot(name: string, uin: number): void {
  if (!plugin_list.has(name)) {
    throw new Error(`plugin "${name}" is undefined`);
  }
  const bot = getBot(uin);
  const plugin = getPlugin(name);
  const setting = getSetting(uin);

  const group_list = bot.getGroupList();
  const plugins = setting.plugins;

  plugin.bindBot(bot);

  // 更新 plugins
  if (!plugins.includes(name)) {
    plugins.push(name);
  }
  // 更新 option
  for (const [group_id, group_info] of group_list) {
    const { group_name } = group_info;

    setting[group_id] ||= {
      group_name, plugin: {},
    };

    if (setting[group_id].group_name !== group_name) {
      setting[group_id].group_name = group_name;
    }
    const default_option = plugin.getOption();
    const local_option = setting[group_id].plugin[name];
    const option = deepMerge(default_option, local_option);

    setting[group_id].plugin[name] = option;
  }
}

/**
 * 插件解绑 bot
 *
 * @param name - plugin name
 * @param uin - bot uin
 */
function unbindBot(name: string, uin: number): void {
  if (!plugin_list.has(name)) {
    throw new Error(`plugin "${name}" is undefined`);
  }
  const bot = getBot(uin);
  const plugin = getPlugin(name);
  const setting = getSetting(uin);

  const group_list = bot.getGroupList();
  const plugins_set = new Set(setting.plugins);

  plugin.unbindBot(bot);

  // 更新 plugins
  if (plugins_set.has(name)) {
    plugins_set.delete(name);
    setting.plugins = [...plugins_set];
  }
  // 更新 option
  for (const [group_id, group_info] of group_list) {
    const { group_name } = group_info;

    if (setting[group_id].group_name !== group_name) {
      setting[group_id].group_name = group_name;
    }
    delete setting[group_id].plugin[name];
  }
}

/**
 * 插件绑定全部 bot
 * 
 * @param name - plugin name
 */
function bindAllBot(name: string): void {
  const uins = getBotList().keys();

  for (const uin of uins) {
    try {
      bindBot(name, uin)
    } catch (error) {
      throw error;
    }
  }
}

/**
 * 导入所有插件模块
 *
 * @returns
 */
export async function importAllPlugin(): Promise<Map<string, Plugin>> {
  const { modules, plugins } = await findPlugin();
  const all_modules = [...modules, ...plugins];
  const modules_length = all_modules.length;

  if (modules_length) {
    for (let i = 0; i < modules_length; i++) {
      const name = all_modules[i];

      try {
        await importPlugin(name);
      } catch { }
    }
  }
  return plugin_list;
}
