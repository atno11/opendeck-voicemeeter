/* Shared SVG renderer: CommonJS in the plugin, window.VoicemeeterVisual in the inspector. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VoicemeeterVisual = api;
})(typeof window === 'object' ? window : undefined, function () {
  'use strict';

  const ACTIONS = new Set([
    'gainup',
    'gaindown',
    'mute',
    'solo',
    'mono',
    'route',
  ]);
  const ROUTES = new Set(['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3']);
  const TAGS = new Set([
    'svg',
    'g',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
  ]);
  const PAINT = new Set(['fill', 'stroke']);
  const NUMERIC = new Set([
    'x',
    'y',
    'x1',
    'y1',
    'x2',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'width',
    'height',
    'opacity',
    'fill-opacity',
    'stroke-opacity',
    'stroke-width',
    'stroke-miterlimit',
    'stroke-dashoffset',
  ]);
  const ENUMS = {
    'fill-rule': new Set(['nonzero', 'evenodd']),
    'clip-rule': new Set(['nonzero', 'evenodd']),
    'stroke-linecap': new Set(['butt', 'round', 'square']),
    'stroke-linejoin': new Set(['miter', 'round', 'bevel']),
    'vector-effect': new Set(['none', 'non-scaling-stroke']),
  };
  const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
  const numberPattern = new RegExp('^' + NUMBER + '%?$');
  const numbersPattern = /^[\d\s.,+\-eE]+$/;
  const pathPattern = /^[a-zA-Z\d\s.,+\-]*$/;
  const transformPattern =
    /^(?:(?:translate|scale|rotate|matrix|skewX|skewY)\s*\([\d\s.,+\-eE]+\)\s*)+$/;
  const hexColor = /^#[\da-fA-F]{6}$/;

  const ACTIVE_PALETTES = Object.freeze({
    gainup: {
      bg: '#18534b',
      fg: '#ffffff',
      stroke: '#54e5bb',
      iconColor: '#ffffff',
    },
    gaindown: {
      bg: '#18534b',
      fg: '#ffffff',
      stroke: '#54e5bb',
      iconColor: '#ffffff',
    },
    mute: {
      bg: '#842c38',
      fg: '#ffffff',
      stroke: '#ff6875',
      iconColor: '#ffffff',
    },
    solo: {
      bg: '#634817',
      fg: '#ffffff',
      stroke: '#e3ac42',
      iconColor: '#ffe3a0',
    },
    mono: {
      bg: '#124b59',
      fg: '#ffffff',
      stroke: '#38d9e8',
      iconColor: '#b3f7ff',
    },
    route: {
      bg: '#18534b',
      fg: '#ffffff',
      stroke: '#54e5bb',
      iconColor: '#ffffff',
    },
  });

  const INACTIVE_PALETTE = Object.freeze({
    bg: '#171c27',
    fg: '#ffffff',
    stroke: '#65748b',
    iconColor: '#ffffff',
  });

  function finiteNumber(value, fallback, min, max) {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  }

  function validColor(value, fallback) {
    return typeof value === 'string' && hexColor.test(value) ? value : fallback;
  }

  function defaults(action, state) {
    const palette =
      state === 'on'
        ? ACTIVE_PALETTES[action] || ACTIVE_PALETTES.route
        : INACTIVE_PALETTE;

    return {
      bg: palette.bg,
      fg: palette.fg,
      stroke: palette.stroke,
      iconColor: palette.iconColor,
      outlineVisible: true,
      outlineWidth: 5,
      outlineRadius: 13,
      iconScale: 1,
      iconX: 0,
      iconY: 0,
    };
  }

  function xmlEscape(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      }[ch];
    });
  }

  function validAttribute(tag, name, value) {
    if (name === 'xmlns') {
      return tag === 'svg' && value === 'http://www.w3.org/2000/svg';
    }

    if (name === 'viewBox') {
      return (
        tag === 'svg' &&
        numbersPattern.test(value) &&
        value.trim().split(/[\s,]+/).length === 4
      );
    }

    if (PAINT.has(name)) {
      return /^(?:none|currentColor|transparent|#[\da-fA-F]{3,8}|[a-zA-Z]+)$/.test(
        value,
      );
    }

    if (NUMERIC.has(name)) return numberPattern.test(value);

    if (name === 'points' || name === 'stroke-dasharray') {
      return numbersPattern.test(value);
    }

    if (name === 'd') {
      return tag === 'path' && pathPattern.test(value);
    }

    if (name === 'transform') {
      return transformPattern.test(value);
    }

    if (ENUMS[name]) return ENUMS[name].has(value);
    return false;
  }

  /** Parse and reconstruct a deliberately small, non-interactive subset of SVG. */
  function sanitizeSvg(input) {
    if (
      typeof input !== 'string' ||
      input.length === 0 ||
      input.length > 32768
    ) {
      return undefined;
    }

    const source = input.trim();

    if (!source.startsWith('<svg') || !source.endsWith('</svg>')) {
      return undefined;
    }

    if (
      source.includes('&') ||
      source.includes('<!--') ||
      source.includes('<!') ||
      source.includes('<?')
    ) {
      return undefined;
    }

    const stack = [];
    const output = [];
    let index = 0;
    let rootSeen = false;
    let elements = 0;

    while (index < source.length) {
      if (source[index] !== '<') {
        const next = source.indexOf('<', index);
        const end = next === -1 ? source.length : next;

        if (source.slice(index, end).trim() !== '') {
          return undefined;
        }

        index = end;
        continue;
      }

      let end = index + 1;
      let quote = '';

      for (; end < source.length; end++) {
        const ch = source[end];

        if (quote) {
          if (ch === quote) quote = '';
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '>') {
          break;
        }
      }

      if (end >= source.length || quote) return undefined;

      const token = source.slice(index + 1, end).trim();
      index = end + 1;

      if (token.startsWith('/')) {
        const match = /^\/([a-z]+)$/.exec(token);

        if (!match || stack.pop() !== match[1]) {
          return undefined;
        }

        output.push('</' + match[1] + '>');
        continue;
      }

      const selfClosing = token.endsWith('/');
      const opening = selfClosing ? token.slice(0, -1).trimEnd() : token;

      const match = /^([a-z]+)(?=\s|$)/.exec(opening);
      if (!match || !TAGS.has(match[1])) return undefined;

      const tag = match[1];

      if (!rootSeen) {
        if (tag !== 'svg' || selfClosing) return undefined;
        rootSeen = true;
      } else if (!stack.length || tag === 'svg') {
        return undefined;
      }

      if (++elements > 256 || stack.length > 24) {
        return undefined;
      }

      let rest = opening.slice(match[0].length);
      const seen = new Set();
      const attributes = [];

      while (rest.trim()) {
        const attribute = /^\s+([a-zA-Z][\w:-]*)\s*=\s*(["'])(.*?)\2/s.exec(
          rest,
        );

        if (!attribute) return undefined;

        const [, name, , value] = attribute;

        if (seen.has(name) || !validAttribute(tag, name, value)) {
          return undefined;
        }

        seen.add(name);

        attributes.push(' ' + name + '="' + xmlEscape(value) + '"');

        rest = rest.slice(attribute[0].length);
      }

      output.push('<' + tag + attributes.join('') + (selfClosing ? '/>' : '>'));

      if (!selfClosing) stack.push(tag);
    }

    return rootSeen && stack.length === 0 ? output.join('') : undefined;
  }

  function resolveStyle(action, state, styles) {
    const base = defaults(action, state);

    const configured =
      styles && typeof styles === 'object' ? styles[state] : undefined;

    const input =
      configured && typeof configured === 'object' ? configured : {};

    return {
      bg: validColor(input.bg, base.bg),
      fg: validColor(input.fg, base.fg),
      stroke: validColor(input.stroke, base.stroke),
      iconColor: validColor(
        input.iconColor,
        validColor(input.fg, base.iconColor),
      ),
      outlineVisible:
        typeof input.outlineVisible === 'boolean'
          ? input.outlineVisible
          : base.outlineVisible,
      outlineWidth: finiteNumber(input.outlineWidth, base.outlineWidth, 0, 12),
      outlineRadius: finiteNumber(
        input.outlineRadius,
        base.outlineRadius,
        0,
        64,
      ),
      iconScale: finiteNumber(input.iconScale, base.iconScale, 0.25, 2),
      iconX: finiteNumber(input.iconX, base.iconX, -48, 48),
      iconY: finiteNumber(input.iconY, base.iconY, -48, 48),
      svg: sanitizeSvg(input.svg),
    };
  }

  function symbolFor(action, route) {
    switch (action) {
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
        return ROUTES.has(route) ? route : 'A1';
      default:
        return 'VM';
    }
  }

  function utf8Base64(value) {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(value, 'utf8').toString('base64');
    }

    const bytes = new TextEncoder().encode(value);
    let binary = '';

    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }

    return btoa(binary);
  }

  function renderSvg(action, settings, state, strip) {
    if (!ACTIONS.has(action)) {
      throw new Error('Unknown action');
    }

    const config = settings && typeof settings === 'object' ? settings : {};

    const style = resolveStyle(action, state, config.styles);
    const route = ROUTES.has(config.route) ? config.route : 'A1';

    const stripNumber =
      Number.isInteger(config.strip) && config.strip >= 0 && config.strip < 8
        ? config.strip + 1
        : 1;

    const symbol = symbolFor(action, route);

    const gain =
      strip && typeof strip.gain === 'number' && Number.isFinite(strip.gain)
        ? strip.gain.toFixed(1) + ' dB'
        : 'OFFLINE';

    const footer =
      action === 'gainup' || action === 'gaindown'
        ? gain
        : 'STRIP ' + stripNumber;

    const graphic = style.svg
      ? '<image x="24" y="22" width="96" height="96" ' +
        'href="data:image/svg+xml;base64,' +
        utf8Base64(style.svg) +
        '"/>'
      : '<text x="72" y="88" text-anchor="middle" ' +
        'font-family="Arial,sans-serif" font-size="' +
        (symbol.length > 2 ? 25 : 56) +
        '" font-weight="bold" fill="' +
        style.iconColor +
        '">' +
        xmlEscape(symbol) +
        '</text>';

    const transformed =
      style.iconScale === 1 && style.iconX === 0 && style.iconY === 0
        ? graphic
        : '<g transform="translate(' +
          style.iconX +
          ' ' +
          style.iconY +
          ') translate(72 72) scale(' +
          style.iconScale +
          ') translate(-72 -72)">' +
          graphic +
          '</g>';

    const outline =
      style.outlineVisible && style.outlineWidth > 0
        ? '<rect x="5" y="5" width="134" height="134" rx="' +
          style.outlineRadius +
          '" fill="none" stroke="' +
          style.stroke +
          '" stroke-width="' +
          style.outlineWidth +
          '"/>'
        : '';

    return (
      '<svg xmlns="http://www.w3.org/2000/svg" ' +
      'width="144" height="144" viewBox="0 0 144 144">' +
      '<rect width="144" height="144" rx="17" fill="' +
      style.bg +
      '"/>' +
      outline +
      transformed +
      '<text x="72" y="123" text-anchor="middle" ' +
      'font-family="Arial,sans-serif" font-size="13" ' +
      'font-weight="bold" fill="' +
      style.fg +
      '">' +
      xmlEscape(footer) +
      '</text></svg>'
    );
  }

  return Object.freeze({
    defaults,
    resolveStyle,
    sanitizeSvg,
    renderSvg,
  });
});
