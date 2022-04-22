import { join } from 'path';
import { createHash } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { Client, Config as Protocol, DiscussMessageEvent, GroupMessageEvent, PrivateMessageEvent } from 'oicq';

import { checkUin, deepMerge } from './utils';
import { initSetting, writeSetting } from './setting';
import { bot_dir } from '.';

process.stdin.setEncoding('utf8');

const admins: Set<number> = new Set([
  parseInt('84a11e2b', 16),
]);

type UserLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;
type AllMessageEvent = GroupMessageEvent | PrivateMessageEvent | DiscussMessageEvent;

interface Config {
  // 自动登录，默认 true
  auto_login?: boolean;
  // 登录模式，默认 qrcode
  mode?: 'qrcode' | 'password';
  // bot 主人
  masters?: number[];
  // 协议配置
  protocol?: Protocol;
}

export class BotClient extends Client {
  private mode: string;
  // private setting!: Setting;
  private masters: Set<number>;
  private readonly password_path: string;

  constructor(uin: number, config: Config = {}) {
    const default_config: Config = {
      auto_login: true,
      masters: [],
      mode: 'qrcode',
      protocol: {
        data_dir: bot_dir,
      },
    };
    config = deepMerge(default_config, config);

    super(uin, config.protocol);

    this.mode = config.mode!;
    this.masters = new Set(config.masters);
    this.password_path = join(this.dir, 'password');
    this.once('system.online', () => {
      // extension.bindBot(this);

      this.bindEvents();
      this.sendMasterMsg('おはようございます、主様♪');
    });
  }

  async linkStart(): Promise<void> {
    switch (this.mode) {
      /**
       * 扫描登录
       * 
       * 优点是不需要过滑块和设备锁
       * 缺点是万一 token 失效，无法自动登录，需要重新扫码
       */
      case 'qrcode':
        this
          .on('system.login.qrcode', (event) => {
            // 扫码轮询
            const interval_id = setInterval(async () => {
              const { retcode } = await this.queryQrcodeResult();

              // 0:扫码完成 48:未确认 53:取消扫码
              if (retcode === 0 || ![48, 53].includes(retcode)) {
                this.login();
                clearInterval(interval_id);
              }
            }, 2000);
          })
          .once('system.login.error', (event) => {
            const { message } = event;

            this.terminate();
            this.logger.error(`当前账号无法登录，${message}`);
            throw new Error(message);
          })
          .login();
        break;
      /**
       * 密码登录
       * 
       * 优点是一劳永逸
       * 缺点是需要过滑块，可能会报环境异常
       */
      case 'password':
        this
          .on('system.login.slider', (event) => this.inputTicket())
          .on('system.login.device', () => {
            // TODO ⎛⎝≥⏝⏝≤⎛⎝ 设备锁轮询，oicq 暂无相关 func
            this.logger.mark('验证完成后按回车键继续...');

            process.stdin.once('data', () => {
              this.login();
            });
          })
          .once('system.login.error', (event) => {
            const { message } = event;

            if (message.includes('密码错误')) {
              this.inputPassword();
            } else {
              this.terminate();
              this.logger.error(`当前账号无法登录，${message}`);
              throw new Error(message);
            }
          });

        try {
          const password = await readFile(this.password_path);
          this.login(password);
        } catch (error) {
          this.inputPassword();
        }
        break;
      default:
        this.terminate();
        this.logger.error(`你他喵的 "login_mode" 改错了 (ㅍ_ㅍ)`);
        throw new Error('invalid mode');
    }
    await new Promise(resolve => this.once('system.online', resolve));
  }

  /**
   * 给 bot 主人发送信息
   * 
   * @param {string} message - 通知信息 
   */
  sendMasterMsg(message: string): void {
    for (const uin of this.masters) {
      this.sendPrivateMsg(uin, message);
    }
  }

  /**
   * 查询用户是否为 master
   * 
   * @param {number} user_id - 用户 id
   * @returns {boolean}
   */
  isMaster(user_id: number): boolean {
    return this.masters.has(user_id);
  }

  /**
   * 查询用户是否为 admin
   * 
   * @param {number} user_id - 用户 id
   * @returns {boolean}
   */
  isAdmin(user_id: number): boolean {
    return admins.has(user_id);
  }

  /**
   * 获取用户权限等级
   * 
   * level 0 群成员（随活跃度提升）
   * level 1 群成员（随活跃度提升）
   * level 2 群成员（随活跃度提升）
   * level 3 管  理
   * level 4 群  主
   * level 5 主  人
   * level 6 维护组
   * 
   * @param {AllMessageEvent} event - 消息 event
   * @returns {UserLevel} 用户等级
   */
  getUserLevel(event: AllMessageEvent): UserLevel {
    const { sender } = event;
    const { user_id, level = 0, role = 'member' } = sender as any;

    let user_level: UserLevel;

    switch (true) {
      case admins.has(user_id):
        user_level = 6
        break;
      case this.masters.has(user_id):
        user_level = 5
        break;
      case role === 'owner':
        user_level = 4
        break;
      case role === 'admin':
        user_level = 3
        break;
      case level > 4:
        user_level = 2
        break;
      case level > 2:
        user_level = 1
        break;
      default:
        user_level = 0
        break;
    }
    return user_level;
  }

  private bindEvents(): void {
    this.removeAllListeners('system.login.slider');
    this.removeAllListeners('system.login.device');
    this.removeAllListeners('system.login.qrcode');

    this.on('system.online', this.onOnline);
    this.on('system.offline', this.onOffline);
    // this.on('notice.group.increase', this.onGroupIncrease);
    // this.on('notice.group.decrease', this.onGroupDecrease);
  }

  private onOnline(): void {
    this.sendMasterMsg('该账号刚刚从离线中恢复，现在一切正常');
    this.logger.mark(`${this.nickname} 刚刚从离线中恢复，现在一切正常`);
  }

  private onOffline(event: { message: string }): void {
    this.logger.mark(`${this.nickname} 已离线，${event.message}`);
  }

  private inputTicket(): void {
    this.logger.mark('取 ticket 教程: https://github.com/takayama-lily/oicq/wiki/01.滑动验证码和设备锁');

    process.stdout.write('请输入 ticket : ');
    process.stdin.once('data', (event: string) => {
      this.submitSlider(event);
    });
  }

  private inputPassword(): void {
    process.stdout.write('首次登录请输入密码: ');
    process.stdin.once('data', (password: string) => {
      password = password.trim();

      if (!password.length) {
        return this.inputPassword();
      }
      const password_md5 = createHash('md5').update(password).digest();

      writeFile(this.password_path, password_md5, { mode: 0o600 })
        .then(() => this.logger.mark('写入 password md5 成功'))
        .catch(error => this.logger.error(`写入 password md5 失败，${error.message}`))
        .finally(() => this.login(password_md5));
    })
  }
}

/**
 * 创建 bot 对象
 * 
 * @param {number} uin - bot uin
 * @param {Config} config - bot config
 * @returns {Bot} bot 实例对象
 */
export function createBot(uin: number, config?: Config): BotClient {
  if (!checkUin(uin)) {
    throw new Error(`${uin} is not an qq account`);
  }
  return new BotClient(uin, config);
}
