import WebSocket from 'ws';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const PREFIX = 'dev.atno.voicemeeter.';
const ROOT = join(__dirname, '..');
const ROUTES = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3'] as const;
const MAX_PRESETS = 30;
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_NAME = 48;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Route = (typeof ROUTES)[number];
type ActionName = 'gainup' | 'gaindown' | 'mute' | 'solo' | 'mono' | 'route';
type StateName = 'off' | 'on';

interface Style {
  bg?: string;
  fg?: string;
  stroke?: string;
  svg?: string;
  iconColor?: string;
  outlineVisible?: boolean;
  outlineWidth?: number;
  outlineRadius?: number;
  iconScale?: number;
  iconX?: number;
  iconY?: number;
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

interface VisualRenderer {
  renderSvg(
    action: ActionName,
    settings: Settings,
    state: StateName,
    strip?: Strip,
  ): string;
  resolveStyle(
    action: ActionName,
    state: StateName,
    styles?: Partial<Record<StateName, Style>>,
  ): Style;
  sanitizeSvg(input: unknown): string | undefined;
}

interface Preset {
  id: string;
  name: string;
  styles: Record<StateName, Style>;
}

interface PresetRequest {
  scope: 'visualPresets';
  op: 'list' | 'save' | 'rename' | 'delete';
  requestId?: number;
  id?: string;
  name?: string;
  styles?: unknown;
}

interface OpenDeckEvent {
  event: string;
  action?: string;
  context?: string;
  payload?: {
    settings?: Settings;
    [key: string]: unknown;
  };
}

const visual = require('../ui/visual.js') as VisualRenderer;

const presetPath = join(
  process.env.APPDATA || join(homedir(), '.config'),
  'opendeck-voicemeeter',
  'visual-presets.json',
);

const instances = new Map<string, Instance>();
const pending = new Map<
  number,
  {
    resolve: (value: Strip[]) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

let strips: Strip[] = [];
let connected = false;
let socket: WebSocket | undefined;
let bridge: ChildProcessWithoutNullStreams | undefined;
let bridgeBuffer = '';
let nextId = 1;
let retryTimer: NodeJS.Timeout | undefined;
let busy = false;
let refreshing = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? '') : '';
}

function send(event: string, payload: object): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ event, ...payload }));
}

function actionName(uuid: string): ActionName | undefined {
  if (!uuid.startsWith(PREFIX)) return undefined;

  const name = uuid.slice(PREFIX.length);

  return ['gainup', 'gaindown', 'mute', 'solo', 'mono', 'route'].includes(name)
    ? (name as ActionName)
    : undefined;
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

  const state: StateName =
    strip && isActive(name, instance.settings, strip) ? 'on' : 'off';

  const svg = visual.renderSvg(name, instance.settings, state, strip);

  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

  if (instance.lastImage === image) return;

  instance.lastImage = image;

  send('setImage', {
    context,
    payload: { image, target: 0 },
  });
}

function renderAll(): void {
  for (const context of instances.keys()) {
    render(context);
  }
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

  child.on('error', (error) => {
    console.error('Bridge:', error.message);
  });

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

function presetName(value: unknown): string {
  if (typeof value !== 'string') return '';

  const name = value.trim();

  return name.length > 0 && name.length <= MAX_NAME ? name : '';
}

function nameKey(name: string): string {
  return name.toLocaleLowerCase('en-US');
}

function legacyId(name: string): string {
  const bytes = createHash('sha1')
    .update('opendeck-voicemeeter:legacy:' + nameKey(name))
    .digest();

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.subarray(0, 16).toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function normalizedStyles(
  action: ActionName,
  input: unknown,
): Record<StateName, Style> {
  if (!isRecord(input) || !isRecord(input.off) || !isRecord(input.on)) {
    throw new Error('Invalid ON/OFF appearance');
  }

  const result = {} as Record<StateName, Style>;

  for (const state of ['off', 'on'] as const) {
    const raw = input[state] as Record<string, unknown>;

    if (
      Object.hasOwn(raw, 'svg') &&
      raw.svg !== undefined &&
      !visual.sanitizeSvg(raw.svg)
    ) {
      throw new Error('Invalid custom SVG');
    }

    const resolved = visual.resolveStyle(action, state, {
      [state]: raw as Style,
    });

    result[state] = {
      bg: resolved.bg,
      fg: resolved.fg,
      stroke: resolved.stroke,
      iconColor: resolved.iconColor,
      outlineVisible: resolved.outlineVisible,
      outlineWidth: resolved.outlineWidth,
      outlineRadius: resolved.outlineRadius,
      iconScale: resolved.iconScale,
      iconX: resolved.iconX,
      iconY: resolved.iconY,
    };

    if (resolved.svg) {
      result[state].svg = resolved.svg;
    }
  }

  return result;
}

function parsePresets(input: unknown): Preset[] {
  if (!Array.isArray(input) || input.length > MAX_PRESETS) {
    throw new Error('Invalid preset library');
  }

  const names = new Set<string>();
  const ids = new Set<string>();

  return input.map((entry) => {
    if (!isRecord(entry)) {
      throw new Error('Invalid preset entry');
    }

    const name = presetName(entry.name);

    const id =
      typeof entry.id === 'string' && UUID_PATTERN.test(entry.id)
        ? entry.id
        : entry.id === undefined
          ? legacyId(name)
          : '';

    if (!name || !id || names.has(nameKey(name)) || ids.has(id)) {
      throw new Error('Invalid or duplicate preset');
    }

    names.add(nameKey(name));
    ids.add(id);

    return {
      id,
      name,
      styles: normalizedStyles('mute', entry.styles),
    };
  });
}

function readPresets(): Preset[] {
  if (!existsSync(presetPath)) return [];

  const raw = readFileSync(presetPath);

  if (raw.byteLength > MAX_STORE_BYTES) {
    throw new Error('Preset file exceeds size limit');
  }

  const data: unknown = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));

  if (!isRecord(data) || data.version !== 1) {
    throw new Error('Unsupported preset file format');
  }

  return parsePresets(data.presets);
}

function writePresets(next: Preset[]): void {
  const serialized = JSON.stringify({ version: 1, presets: next }, null, 2);

  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) {
    throw new Error('Preset library exceeds size limit');
  }

  const directory = dirname(presetPath);

  mkdirSync(directory, { recursive: true });

  const temporary = join(
    directory,
    `visual-presets.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    writeFileSync(temporary, serialized, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });

    renameSync(temporary, presetPath);
  } finally {
    if (existsSync(temporary)) {
      rmSync(temporary);
    }
  }
}

function processPresetRequest(
  action: ActionName,
  request: PresetRequest,
): {
  message: string;
  presets: Preset[];
} {
  const current = readPresets();

  if (request.op === 'list') {
    return {
      message: 'Preset library loaded',
      presets: current,
    };
  }

  if (request.op === 'save') {
    const name = presetName(request.name);

    if (!name) {
      throw new Error('Invalid preset name');
    }

    const styles = normalizedStyles(action, request.styles);

    const existing =
      typeof request.id === 'string'
        ? current.findIndex((p) => p.id === request.id)
        : -1;

    if (request.id !== undefined && existing < 0) {
      throw new Error('Preset not found');
    }

    if (
      current.some(
        (p, index) => index !== existing && nameKey(p.name) === nameKey(name),
      )
    ) {
      throw new Error('Preset name already exists');
    }

    if (existing < 0 && current.length >= MAX_PRESETS) {
      throw new Error('Maximum of 30 presets reached');
    }

    const next = current.slice();

    if (existing >= 0) {
      next[existing] = {
        id: next[existing].id,
        name,
        styles,
      };
    } else {
      next.push({
        id: randomUUID(),
        name,
        styles,
      });
    }

    writePresets(next);

    return {
      message: 'Preset saved',
      presets: next,
    };
  }

  if (request.op === 'rename') {
    const name = presetName(request.name);
    const index = current.findIndex((p) => p.id === request.id);

    if (!name || index < 0) {
      throw new Error('Invalid name or preset not found');
    }

    if (
      current.some((p, i) => i !== index && nameKey(p.name) === nameKey(name))
    ) {
      throw new Error('Preset name already exists');
    }

    const next = current.slice();

    next[index] = {
      ...next[index],
      name,
    };

    writePresets(next);

    return {
      message: 'Preset renamed',
      presets: next,
    };
  }

  if (request.op === 'delete') {
    const next = current.filter((p) => p.id !== request.id);

    if (next.length === current.length) {
      throw new Error('Preset not found');
    }

    writePresets(next);

    return {
      message: 'Preset deleted',
      presets: next,
    };
  }

  throw new Error('Unsupported preset operation');
}

function handlePresetMessage(message: OpenDeckEvent): void {
  const context = message.context;
  const action = message.action && actionName(message.action);

  if (!context || !action || !isRecord(message.payload)) {
    return;
  }

  const raw = message.payload;

  if (raw.scope !== 'visualPresets') return;

  const request = raw as unknown as PresetRequest;

  const reply: {
    scope: string;
    requestId?: number;
    ok: boolean;
    presets?: Preset[];
    error?: string;
    message?: string;
  } = {
    scope: 'visualPresets',
    requestId:
      typeof request.requestId === 'number' ? request.requestId : undefined,
    ok: false,
  };

  try {
    const result = processPresetRequest(action, request);

    reply.ok = true;
    reply.message = result.message;
    reply.presets = result.presets;
  } catch (error) {
    reply.error =
      error instanceof Error ? error.message : 'Preset operation failed';

    console.error('Preset operation:', reply.error);
  }

  send('sendToPropertyInspector', {
    action: message.action,
    context,
    payload: reply,
  });
}

function handleEvent(message: OpenDeckEvent): void {
  if (message.event === 'sendToPlugin') {
    handlePresetMessage(message);
    return;
  }

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

  socket.on('error', (error) => {
    console.error('OpenDeck:', error);
  });

  socket.on('close', () => {
    stopBridge();
    process.exit(0);
  });

  setInterval(() => void refresh(), 800).unref();
}

main();
