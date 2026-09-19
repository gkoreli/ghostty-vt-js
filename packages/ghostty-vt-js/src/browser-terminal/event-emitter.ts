// Portions originally derived from coder/ghostty-web (MIT — see ./LICENSE):
//   https://github.com/coder/ghostty-web/blob/6a1a50df5b4f6b34d1b1de10fad3a0fc811bfbc0/lib/event-emitter.ts
// Substantially rewritten since; this file is ours and does not track that project.
// Modified: typed listener parameter (TS7006 fix); kept to track upstream.

import type { IDisposable, IEvent } from './interfaces.js';

export class EventEmitter<T> {
  private listeners: Array<(arg: T) => void> = [];

  fire(arg: T): void {
    for (const listener of this.listeners) {
      listener(arg);
    }
  }

  event: IEvent<T> = (listener: (arg: T) => void) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  dispose(): void {
    this.listeners = [];
  }
}
