// Tiny in-process pub/sub for SSE fan-out. Each subscriber owns a bounded
// FIFO; when a subscriber is slow we drop its oldest event to make room
// (back-pressure favors keeping fresh data over blocking publishers).
//
// No external deps; mirrors panopticon's events.py but uses async iterators
// instead of blocking queues so handlers stay non-blocking.

export interface MomentoEvent {
  id: number;
  timestamp: number;
  type: string;
  data: Record<string, unknown>;
}

interface Subscriber {
  queue: MomentoEvent[];
  maxBuffer: number;
  resolve: ((ev: MomentoEvent | null) => void) | null;
  closed: boolean;
}

export class EventBus {
  private nextId = 0;
  private subscribers = new Set<Subscriber>();

  subscribe(maxBuffer = 128): {
    next: () => Promise<MomentoEvent | null>;
    close: () => void;
  } {
    const sub: Subscriber = { queue: [], maxBuffer, resolve: null, closed: false };
    this.subscribers.add(sub);
    return {
      next: () => {
        if (sub.closed) return Promise.resolve(null);
        const head = sub.queue.shift();
        if (head !== undefined) return Promise.resolve(head);
        return new Promise<MomentoEvent | null>((resolve) => {
          sub.resolve = resolve;
        });
      },
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        this.subscribers.delete(sub);
        if (sub.resolve) {
          const r = sub.resolve;
          sub.resolve = null;
          r(null);
        }
      },
    };
  }

  publish(type: string, data: Record<string, unknown>): MomentoEvent {
    this.nextId += 1;
    const event: MomentoEvent = {
      id: this.nextId,
      timestamp: Date.now() / 1000,
      type,
      data,
    };
    for (const sub of this.subscribers) {
      if (sub.closed) continue;
      if (sub.resolve) {
        const r = sub.resolve;
        sub.resolve = null;
        r(event);
        continue;
      }
      if (sub.queue.length >= sub.maxBuffer) {
        // Slow consumer; drop oldest to make room for the new event.
        sub.queue.shift();
      }
      sub.queue.push(event);
    }
    return event;
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }
}

export function eventToSSE(ev: MomentoEvent): string {
  // SSE framing: id, event, data fields followed by a blank line.
  const payload = JSON.stringify({ id: ev.id, timestamp: ev.timestamp, ...ev.data });
  return `id: ${ev.id}\nevent: ${ev.type}\ndata: ${payload}\n\n`;
}
