import { EventMap } from 'oicq';

import { BotClient } from './bot';
import { Plugin } from './plugin';

export class Listen<T extends keyof EventMap = any> {
  func?: EventMap[T];

  constructor(
    private event_name: T,
    private plugin: Plugin,
  ) {

  }

  trigger(func: EventMap<BotClient>[T]) {
    this.func = func;
    return this;
  }
}