import type {GroupNotice} from './resource-group-driver.js';

/** Host creates/closes a same-profile channel. Messages only trigger durable reloads. */
export function createGroupNotificationPort(channel: Pick<BroadcastChannel,'postMessage'|'addEventListener'|'removeEventListener'>) {
  return {
    notify(notice:GroupNotice){channel.postMessage(notice);},
    listen(receive:(notice:unknown)=>void){const handler=(event:MessageEvent)=>receive(event.data);channel.addEventListener('message',handler);return ()=>channel.removeEventListener('message',handler);},
  };
}
