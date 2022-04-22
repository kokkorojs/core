import { join } from 'path';
import { Dirent } from 'fs';
import { mkdir, readdir } from 'fs/promises';
import { Observable } from 'rxjs';

import { modules_dir, plugins_dir } from '.';

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

class Plugin extends Observable {
  constructor() {
    super();
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

