import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal Chrome DevTools Protocol driver for recording demo videos of the real UI in headless Edge/Chrome.
 * - Real input: clicks, typing and drags are dispatched as real mouse/keyboard events (the app reacts as for a user).
 * - Visible cursor + captions: injected overlay (headless has no cursor), moved in sync with the real events.
 * - Recording: Page.startScreencast frames with timestamps → ffmpeg concat (see encode in record.ts).
 */

export const W = 1280;
export const H = 800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];

/** Overlay: cursor, click ripple, caption bar, title card. Runs in every document (CDP scripts are not subject to the page CSP). */
const OVERLAY = String.raw`(() => {
  if (window.__demo) return;
  const mk = (css) => { const d = document.createElement('div'); d.style.cssText = css; return d; };
  const root = mk('position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:Inter,Segoe UI,system-ui,sans-serif');
  const cursor = mk('position:absolute;left:0;top:0;width:22px;height:22px;transform:translate(640px,400px);transition:transform 0ms linear;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))');
  cursor.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2.5l15 9.2-6.6 1.4 3.9 7.4-3 1.5-3.8-7.5L4.6 19z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const caption = mk('position:absolute;left:50%;bottom:26px;transform:translateX(-50%);max-width:78%;padding:10px 18px;border-radius:12px;background:rgba(17,20,30,.88);color:#fff;font-size:17px;font-weight:550;line-height:1.35;text-align:center;opacity:0;transition:opacity .25s;box-shadow:0 8px 24px rgba(0,0,0,.3)');
  const card = mk('position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:linear-gradient(135deg,#312e81,#6d28d9 55%,#be185d);color:#fff;text-align:center');
  root.append(card, caption, cursor);
  const attach = () => document.body && !root.isConnected && document.body.append(root);
  attach(); new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true });
  let pos = { x: 640, y: 400 };
  window.__demo = {
    move(x, y, ms) { cursor.style.transition = 'transform ' + ms + 'ms cubic-bezier(.3,.7,.3,1)'; cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'; pos = { x, y }; },
    jump(x, y) { cursor.style.transition = 'none'; cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'; pos = { x, y }; },
    click() {
      const r = mk('position:absolute;left:' + (pos.x - 16) + 'px;top:' + (pos.y - 16) + 'px;width:32px;height:32px;border-radius:50%;background:rgba(99,102,241,.35);border:2px solid rgba(99,102,241,.9);transform:scale(.3);opacity:1;transition:transform .45s ease-out,opacity .45s ease-out');
      root.insertBefore(r, cursor); requestAnimationFrame(() => { r.style.transform = 'scale(1.4)'; r.style.opacity = '0'; }); setTimeout(() => r.remove(), 500);
    },
    caption(text) { caption.textContent = text || ''; caption.style.opacity = text ? '1' : '0'; },
    card(title, sub) {
      if (!title) { card.style.display = 'none'; return; }
      card.innerHTML = '';
      const a = mk('font-size:38px;font-weight:750;letter-spacing:-.02em;max-width:80%'); a.textContent = title;
      const b = mk('font-size:19px;opacity:.88;max-width:70%'); b.textContent = sub || '';
      const c = mk('margin-top:18px;font-size:14px;letter-spacing:.12em;text-transform:uppercase;opacity:.7'); c.textContent = 'Social Spy';
      card.append(a, b, c); card.style.display = 'flex';
    },
  };
})()`;

export interface Frame {
  file: string;
  t: number;
}

export class Browser {
  private ws!: WebSocket;
  private seq = 0;
  private pending = new Map<number, (r: { result?: any; error?: { message: string } }) => void>();
  private proc!: ChildProcess;
  private frames: Frame[] = [];
  private recDir: string | null = null;
  private frameNo = 0;
  private cursor = { x: W / 2, y: H / 2 };

  static async launch(profileDir: string, port = 9351): Promise<Browser> {
    const b = new Browser();
    const exe = process.env.DEMO_BROWSER ?? BROWSERS.find((p) => existsSync(p));
    if (!exe) throw new Error('No Edge or Chrome found for recording');
    b.proc = spawn(exe, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, `--window-size=${W},${H}`, '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
    type Target = { type: string; webSocketDebuggerUrl: string };
    let target: Target | undefined;
    for (let i = 0; i < 60 && !target; i++) {
      try {
        target = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Target[]).find((x) => x.type === 'page');
      } catch {
        /* not up yet */
      }
      if (!target) await sleep(250);
    }
    if (!target) throw new Error('Browser did not start');
    b.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (b.ws.onopen = r));
    b.ws.onmessage = (m) => b.onMessage(JSON.parse(String(m.data)));
    await b.send('Page.enable');
    await b.send('Runtime.enable');
    await b.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY });
    return b;
  }

  private onMessage(d: { id?: number; method?: string; params?: any; result?: any; error?: any }) {
    if (d.id && this.pending.has(d.id)) {
      this.pending.get(d.id)!(d);
      this.pending.delete(d.id);
      return;
    }
    if (d.method === 'Page.screencastFrame') {
      void this.send('Page.screencastFrameAck', { sessionId: d.params.sessionId });
      if (this.recDir) {
        const file = join(this.recDir, `f${String(this.frameNo++).padStart(6, '0')}.jpg`);
        writeFileSync(file, Buffer.from(d.params.data, 'base64'));
        this.frames.push({ file, t: d.params.metadata.timestamp });
      }
    }
    if (d.method === 'Runtime.exceptionThrown') console.warn('[page]', d.params.exceptionDetails?.exception?.description?.split('\n')[0]);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, (r) => (r.error ? reject(new Error(`${method}: ${r.error.message}`)) : resolve(r.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value as T;
  }

  async goto(url: string, settleMs = 1200) {
    await this.send('Page.navigate', { url });
    await sleep(settleMs);
    await this.eval(OVERLAY);
    await this.eval(`window.__demo.jump(${this.cursor.x}, ${this.cursor.y})`);
  }

  async setPrefs(lang: 'en' | 'vi', theme: 'light' | 'dark' | 'system' = 'light') {
    await this.eval(`localStorage.setItem('sss-lang','${lang}'); localStorage.setItem('sss-theme','${theme}'); localStorage.setItem('sss-setup-guide-seen','1')`);
  }

  /* ---------------- recording ---------------- */
  async startRecording(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.recDir = dir;
    this.frames = [];
    this.frameNo = 0;
    await this.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  }
  async stopRecording(): Promise<Frame[]> {
    await sleep(300);
    await this.send('Page.stopScreencast');
    this.recDir = null;
    return this.frames;
  }

  /* ---------------- overlay ---------------- */
  async caption(text: string) {
    await this.eval(`window.__demo.caption(${JSON.stringify(text)})`);
  }
  async card(title: string, sub = '', ms = 2200) {
    await this.eval(`window.__demo.card(${JSON.stringify(title)}, ${JSON.stringify(sub)})`);
    await sleep(ms);
    await this.eval(`window.__demo.card('')`);
  }

  /* ---------------- locating elements ---------------- */
  /**
   * Center of the first visible element matching `sel` whose text contains `text` (any of the given strings),
   * scrolled into view first. Returns null when not found.
   */
  async locate(sel: string, text?: string | string[], nth = 0): Promise<{ x: number; y: number; w: number; h: number } | null> {
    const texts = text === undefined ? null : Array.isArray(text) ? text : [text];
    return this.eval(`(() => {
      const texts = ${JSON.stringify(texts)};
      const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => {
        const r = e.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        if (!texts) return true;
        const t = (e.textContent || e.getAttribute('placeholder') || e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        return texts.some((x) => t.includes(x));
      });
      const el = els[${nth}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
  }

  async waitFor(sel: string, text?: string | string[], timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.locate(sel, text)) return true;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${sel}${text ? ` "${text}"` : ''}`);
  }

  /* ---------------- real input ---------------- */
  async moveTo(x: number, y: number) {
    const d = Math.hypot(x - this.cursor.x, y - this.cursor.y);
    const ms = Math.round(Math.min(1100, Math.max(250, d * 1.1)));
    await this.eval(`window.__demo.move(${x}, ${y}, ${ms})`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    this.cursor = { x, y };
    await sleep(ms + 80);
  }

  async click(sel: string, text?: string | string[], opts: { nth?: number; pause?: number } = {}) {
    const p = await this.locate(sel, text, opts.nth ?? 0);
    if (!p) throw new Error(`Not found: ${sel}${text ? ` "${text}"` : ''}`);
    await this.moveTo(Math.round(p.x), Math.round(p.y));
    await this.eval('window.__demo.click()');
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(opts.pause ?? 500);
  }

  /** Click an input, clear it, then type like a person. */
  async type(sel: string, value: string, opts: { text?: string | string[]; nth?: number; clear?: boolean } = {}) {
    await this.click(sel, opts.text, { nth: opts.nth, pause: 150 });
    if (opts.clear !== false) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    }
    for (const ch of value) {
      await this.send('Input.insertText', { text: ch });
      await sleep(45 + Math.random() * 45);
    }
    await sleep(300);
  }

  async press(key: 'Enter' | 'Delete' | 'Escape') {
    const code = { Enter: 13, Delete: 46, Escape: 27 }[key];
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
    await sleep(400);
  }

  /** Native <select> popups are not drawn in headless mode: point at the select, then set the option like a user. */
  async select(sel: string, matchOption: string | string[], nth = 0) {
    await this.click(sel, undefined, { nth, pause: 250 });
    const ok = await this.eval<boolean>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(sel)})][${nth}];
      const want = ${JSON.stringify(Array.isArray(matchOption) ? matchOption : [matchOption])};
      const opt = [...el.options].find((o) => want.some((w) => o.value === w || o.textContent.includes(w)));
      if (!opt) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, opt.value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`Option ${matchOption} not found in ${sel}`);
    await sleep(500);
  }

  /** Real drag with intermediate moves (the overlay cursor follows). */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 18) {
    await this.moveTo(from.x, from.y);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.eval(`window.__demo.move(${x}, ${y}, 30)`);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(35);
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    this.cursor = { x: to.x, y: to.y };
    await sleep(500);
  }

  async scroll(dy: number) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.cursor.x, y: this.cursor.y, deltaX: 0, deltaY: dy });
    await sleep(600);
  }

  async close() {
    try {
      this.ws?.close();
    } finally {
      this.proc?.kill();
    }
  }
}

export { sleep };
