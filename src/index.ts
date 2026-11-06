import WebSocket from 'ws';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

const PREFIX = 'com.opendeck.voicemeeter.';
const ROOT = join(__dirname, '..');
const ROUTES = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3'] as const;

type Route = (typeof ROUTES)[number];
type ActionName = 'gainup' | 'gaindown' | 'mute' | 'solo' | 'mono' | 'route';
type StateName = 'off' | 'on';

interface Style {
  bg?: string;
  fg?: string;
  stroke?: string;
  svg?: string;
}

interface Settings {
  strip?: number;
  step?: number;
  route?: Route;
  styles?: Partial<Record<StateName, Style>>;
}

interface Strip {
  index: number;
  label: string;
  gain: number;
  mute: boolean;
  solo: boolean;
  mono: boolean;
  routes: Record<Route, boolean>;
}

interface Instance {
  action: string;
  settings: Settings;
  lastImage?: string;
}

interface Response {
  id: number;
  ok: boolean;
  data?: Strip[];
  error?: string;
}

const instances = new Map<string, Instance>();
let strips: Strip[] = [];
let connected = false;
let socket: WebSocket | undefined;
let bridge: ChildProcessWithoutNullStreams | undefined;
let bridgeBuffer = '';
let nextId = 1;
let retryTimer: NodeJS.Timeout | undefined;

const pending = new Map<
  number,
  {
    resolve: (value: Strip[]) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? '') : '';
}

function send(event: string, payload: object): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ event, ...payload }));
}

function actionName(uuid: string): ActionName | undefined {
  const name = uuid.replace(PREFIX, '');
  if (['gainup', 'gaindown', 'mute', 'solo', 'mono', 'route'].includes(name)) {
    return name as ActionName;
  }
  return undefined;
}

function validStrip(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < 8
    ? Number(value)
    : 0;
}

function validStep(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0.1, Math.min(12, value))
    : 1;
}

function validRoute(value: unknown): Route {
  return ROUTES.includes(value as Route) ? (value as Route) : 'A1';
}

function color(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value
    : fallback;
}

function safeSvg(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32768) return undefined;
  const svg = value.trim();

  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) return undefined;

  // Restrict custom SVGs to simple vector primitives.
  if (
    /<\/?(?!svg\b|g\b|path\b|rect\b|circle\b|ellipse\b|line\b|polyline\b|polygon\b)[a-z][\w:-]*/i.test(
      svg,
    )
  ) {
    return undefined;
  }
  if (/\bon[a-z]+\s*=|href\s*=|style\s*=|url\s*\(|@|<!|<\?/i.test(svg)) {
    return undefined;
  }
  return svg;
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[char] ?? char,
  );
}

function defaults(
  active: boolean,
  name: ActionName,
): Required<Omit<Style, 'svg'>> {
  return {
    bg: active ? (name === 'mute' ? '#842c38' : '#18534b') : '#171c27',
    fg: '#ffffff',
    stroke: active ? '#54e5bb' : '#65748b',
  };
}

function defaultSymbol(name: ActionName, route: Route): string {
  switch (name) {
    case 'gainup':
      return '+';
    case 'gaindown':
      return '−';
    case 'mute':
      return 'M';
    case 'solo':
      return 'S';
    case 'mono':
      return 'MONO';
    case 'route':
      return route;
  }
}

function icon(
  name: ActionName,
  settings: Settings,
  state: StateName,
  strip?: Strip,
): string {
  const active = state === 'on';
  const palette = defaults(active, name);
  const configured = settings.styles?.[state] ?? {};
  const bg = color(configured.bg, palette.bg);
  const fg = color(configured.fg, palette.fg);
  const stroke = color(configured.stroke, palette.stroke);
  const custom = safeSvg(configured.svg);
  const symbol = defaultSymbol(name, validRoute(settings.route));
  const stripNumber = validStrip(settings.strip) + 1;
  const gain = strip ? `${strip.gain.toFixed(1)} dB` : 'OFFLINE';

  const graphic = custom
    ? `<image x="24" y="22" width="96" height="96"
        href="data:image/svg+xml;base64,${Buffer.from(custom).toString('base64')}"/>`
    : `<text x="72" y="88" text-anchor="middle"
        font-family="Arial,sans-serif" font-size="${symbol.length > 2 ? 25 : 56}"
        font-weight="bold" fill="${fg}">${escapeXml(symbol)}</text>`;

  const footer =
    name === 'gainup' || name === 'gaindown' ? gain : `STRIP ${stripNumber}`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg"
    xmlns:xlink="http://www.w3.org/1999/xlink"
    width="144" height="144" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="17" fill="${bg}"/>
    <rect x="5" y="5" width="134" height="134" rx="13"
      fill="none" stroke="${stroke}" stroke-width="5"/>
    ${graphic}
    <text x="72" y="123" text-anchor="middle"
      font-family="Arial,sans-serif" font-size="13"
      font-weight="bold" fill="${fg}">${escapeXml(footer)}</text>
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function isActive(name: ActionName, settings: Settings, strip: Strip): boolean {
  switch (name) {
    case 'mute':
      return strip.mute;
    case 'solo':
      return strip.solo;
    case 'mono':
      return strip.mono;
    case 'route':
      return Boolean(strip.routes[validRoute(settings.route)]);
    case 'gainup':
      return strip.gain >= 12;
    case 'gaindown':
      return strip.gain <= -60;
  }
}

function render(context: string): void {
  const instance = instances.get(context);
  if (!instance) return;

  const name = actionName(instance.action);
  if (!name) return;

  const strip = connected
    ? strips[validStrip(instance.settings.strip)]
    : undefined;
  const state =
    strip && isActive(name, instance.settings, strip) ? 'on' : 'off';
  const image = icon(name, instance.settings, state, strip);

  if (instance.lastImage === image) return;
  instance.lastImage = image;

  send('setImage', {
    context,
    payload: { image, target: 0 },
  });
}

function renderAll(): void {
  for (const context of instances.keys()) render(context);
}

function updateSnapshot(data: Strip[]): void {
  if (!Array.isArray(data) || data.length !== 8) {
    throw new Error('Invalid snapshot');
  }
  strips = data;
  connected = true;
  renderAll();
}

function rejectPending(message: string): void {
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    request.reject(new Error(message));
    pending.delete(id);
  }
}

function handleBridgeLine(line: string): void {
  let response: Response;

  try {
    response = JSON.parse(line) as Response;
  } catch {
    console.error('Invalid bridge JSON');
    return;
  }

  const request = pending.get(response.id);
  if (!request) return;

  clearTimeout(request.timer);
  pending.delete(response.id);

  if (response.ok && response.data) {
    request.resolve(response.data);
  } else {
    request.reject(new Error(response.error ?? 'Bridge request failed'));
  }
}

function stopBridge(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  bridge?.kill();
}

function startBridge(): void {
  if (bridge) return;

  const python = process.env.VOICEMEETER_PYTHON || 'python';
  const child = spawn(python, ['-u', join(ROOT, 'bridge.py')], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  bridge = child;
  bridgeBuffer = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    bridgeBuffer += chunk;

    if (bridgeBuffer.length > 1024 * 1024) {
      child.kill();
      return;
    }

    let newline: number;
    while ((newline = bridgeBuffer.indexOf('\n')) >= 0) {
      const line = bridgeBuffer.slice(0, newline).trim();
      bridgeBuffer = bridgeBuffer.slice(newline + 1);
      if (line) handleBridgeLine(line);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    console.error('[Voicemeeter]', chunk.trim());
  });

  child.on('error', (error) => console.error('Bridge:', error.message));

  child.on('close', () => {
    if (bridge !== child) return;
    bridge = undefined;
    connected = false;
    strips = [];
    rejectPending('Python bridge disconnected');
    renderAll();

    retryTimer = setTimeout(startBridge, 3000);
  });
}

function requestBridge(payload: object): Promise<Strip[]> {
  return new Promise((resolve, reject) => {
    if (!bridge || bridge.stdin.destroyed) {
      reject(new Error('Python bridge unavailable'));
      return;
    }

    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Bridge request timed out'));
      bridge?.kill();
    }, 5000);

    pending.set(id, { resolve, reject, timer });

    bridge.stdin.write(JSON.stringify({ id, ...payload }) + '\n', (error) => {
      if (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  });
}

let busy = false;
let refreshing = false;

async function refresh(): Promise<void> {
  if (refreshing || busy || !bridge) return;
  refreshing = true;

  try {
    updateSnapshot(await requestBridge({ op: 'snapshot' }));
  } catch (error) {
    console.error('Snapshot:', error);
    connected = false;
    renderAll();
  } finally {
    refreshing = false;
  }
}

async function execute(context: string): Promise<void> {
  const instance = instances.get(context);
  if (!instance) return;

  const name = actionName(instance.action);
  if (!name) return;

  if (busy || !connected) {
    send('showAlert', { context });
    return;
  }

  busy = true;
  try {
    const data = await requestBridge({
      op: 'command',
      strip: validStrip(instance.settings.strip),
      action: name,
      step: validStep(instance.settings.step),
      route: validRoute(instance.settings.route),
    });

    updateSnapshot(data);
  } catch (error) {
    console.error('Command:', error);
    send('showAlert', { context });
  } finally {
    busy = false;
  }
}

interface OpenDeckEvent {
  event: string;
  action?: string;
  context?: string;
  payload?: {
    settings?: Settings;
  };
}

function handleEvent(message: OpenDeckEvent): void {
  const context = message.context;
  if (!context) return;

  switch (message.event) {
    case 'willAppear':
      if (message.action) {
        instances.set(context, {
          action: message.action,
          settings: message.payload?.settings ?? {},
        });
        render(context);
      }
      break;

    case 'willDisappear':
      instances.delete(context);
      break;

    case 'didReceiveSettings': {
      const instance = instances.get(context);
      if (instance) {
        instance.settings = message.payload?.settings ?? {};
        instance.lastImage = undefined;
        render(context);
      }
      break;
    }

    case 'keyDown':
      void execute(context);
      break;
  }
}

function main(): void {
  const port = Number(argument('-port'));
  const uuid = argument('-pluginUUID');
  const registerEvent = argument('-registerEvent') || 'registerPlugin';

  if (!Number.isInteger(port) || port < 1 || port > 65535 || !uuid) {
    console.error('Missing OpenDeck startup arguments');
    process.exitCode = 1;
    return;
  }

  socket = new WebSocket(`ws://127.0.0.1:${port}`);

  socket.on('open', () => {
    send(registerEvent, { uuid });
    startBridge();
    void refresh();
  });

  socket.on('message', (raw) => {
    try {
      handleEvent(JSON.parse(raw.toString()) as OpenDeckEvent);
    } catch (error) {
      console.error('OpenDeck event:', error);
    }
  });

  socket.on('error', (error) => console.error('OpenDeck:', error));

  socket.on('close', () => {
    stopBridge();
    process.exit(0);
  });

  setInterval(() => void refresh(), 800).unref();
}

main();
