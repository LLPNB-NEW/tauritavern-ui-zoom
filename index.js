/**
 * UI Zoom — browser-like whole-interface zoom for TauriTavern / SillyTavern.
 *
 * Why this exists
 * ---------------
 * Tauri/wry disables WebView2's built-in zoom control (`IsZoomControlEnabled`),
 * so the window cannot be zoomed like a browser tab (Ctrl + wheel / Ctrl + +/- / 0).
 * This extension re-implements it inside the page:
 *
 *  1. The CSS `zoom` property is applied to <html>. Chromium scales layout, text,
 *     popups and `position: fixed` bars exactly like browser zoom does.
 *  2. CSS `zoom` does *not* scale the viewport itself, so every viewport-relative
 *     length (vh / dvh / svh / lvh / vw / dvw / svw / lvw / vmin / vmax) that the
 *     app CSS declares is rewritten into `calc(<len> / var(--tt-ui-zoom))` and
 *     injected as a last-wins stylesheet. Viewport-sized containers therefore keep
 *     filling the window instead of overflowing — matching real browser zoom, where
 *     px/rem/em scale up while viewport units stay a fraction of the screen.
 *     Inline styles get the same treatment, whether written with `style.setProperty()`
 *     or by direct property assignment (`el.style.width = '100vw'`). A DOM watcher
 *     catches the remaining write paths (Blink resolves direct property writes through
 *     a named-property interceptor, and `cssText` / `setAttribute` / jQuery `.css()`
 *     bypass the prototype entirely), so third-party extensions that size their own
 *     overlays in viewport units stay inside the window.
 *  3. `--doc-height` (written by the app from `window.innerHeight`) is overridden
 *     the same way, because it is consumed as a CSS length.
 *  4. CSS `zoom` makes Chromium report mouse/geometry coordinates in *visual* pixels
 *     while CSS lengths and `offsetWidth`/`getComputedStyle` stay in unzoomed CSS
 *     pixels. That inconsistency breaks every JS-positioned popup and the Moving UI
 *     drag. The "coordinate fix" (on by default) normalises the JS coordinate space
 *     back to CSS pixels, i.e. the app's JS sees the same numbers it would see at
 *     100% zoom for the same layout.
 *
 * Known deviation from real browser zoom: CSS media queries (`@media (max-width…)`)
 * are still evaluated against the unzoomed viewport, so breakpoint-driven layout
 * does not shift with zoom. Everything else is emulated.
 *
 * Shortcuts (browser-like): Ctrl + wheel, Ctrl + '+' / '-', Ctrl + '0'.
 * Fallback family that still reaches the page when the WebView swallows browser
 * accelerator keys: Ctrl + Alt + '+' / '-' / '0'.
 *
 * The zoom factor is persisted both in `localStorage` and in
 * `extension_settings.tauritavernUiZoom` (settings.json).
 */

const ZOOM_VAR = '--tt-ui-zoom';
const COMPENSATION_STYLE_ID = 'tt_ui_zoom_compensation';
const PANEL_CONTAINER_ID = 'tt_ui_zoom_container';
const INDICATOR_ID = 'tt_ui_zoom_indicator';
const STORAGE_KEY = 'tauritavern.uiZoom';
const SETTINGS_KEY = 'tauritavernUiZoom';
const COORDINATE_FIX_STORAGE_KEY = 'tauritavern.uiZoomCoordinateFix';
const COORDINATE_FIX_SETTINGS_KEY = 'tauritavernUiZoomCoordinateFix';
const PANEL_GUARD_CLASS = 'tt-ui-zoom-panel-guard';
const PANEL_GUARD_STORAGE_KEY = 'tauritavern.uiZoomPanelGuard';
const PANEL_GUARD_SETTINGS_KEY = 'tauritavernUiZoomPanelGuard';

/** Chat width (in vw) at or above which the side panels have no usable gap left. */
const PANEL_GUARD_CHAT_WIDTH_VW = 80;

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

/** Chrome's zoom ladder, so stepping feels like a browser. */
const ZOOM_LADDER = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

const WHEEL_STEP_INTERVAL_MS = 60;
const WHEEL_MIN_DELTA = 1;
const INDICATOR_DURATION_MS = 1000;
const COMPENSATION_REBUILD_DELAY_MS = 400;
const PANEL_MOUNT_TIMEOUT_MS = 60000;

/**
 * A viewport unit that has not been compensated yet. The negative lookahead keeps the
 * rewrite idempotent — `calc(100vw / var(--tt-ui-zoom))` must never be divided twice,
 * which matters now that the rewrite also walks live inline styles.
 */
const VIEWPORT_UNIT_SOURCE = '(-?(?:\\d+\\.?\\d*|\\.\\d+))(dvh|svh|lvh|dvw|svw|lvw|vmin|vmax|vh|vw)(?![\\w-])(?!\\s*/\\s*var\\(--tt-ui-zoom\\))';
const viewportUnitGlobal = new RegExp(VIEWPORT_UNIT_SOURCE, 'g');
const viewportUnitTest = new RegExp(VIEWPORT_UNIT_SOURCE);

/** Cheap pre-filter for live `style` attributes; false positives are harmless. */
const LOOSE_VIEWPORT_UNIT_TEST = /[\d.]+(?:dvh|svh|lvh|dvw|svw|lvw|vmin|vmax|vh|vw)/;

/**
 * Style properties whose values may carry viewport units. Every one of them exists
 * on CSSStyleDeclaration.prototype in both spellings (dashed and camelCase), and
 * frameworks write the camelCase accessor: `node.style.marginTop = '10vh'`.
 */
const LENGTH_PROPERTIES = [
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'top', 'right', 'bottom', 'left', 'inset', 'margin', 'margin-top', 'margin-right',
    'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'gap', 'row-gap', 'column-gap', 'font-size',
    'line-height', 'border-radius', 'border-width', 'flex-basis', 'translate',
];

const BASE_CSS = [
    ':root {',
    `    ${ZOOM_VAR}: 1;`,
    '    /* The app writes --doc-height from window.innerHeight (unzoomed px).',
    '       Divide it so a 100%-height box still matches the window under zoom. */',
    '    --doc-height: calc(100vh / var(--tt-ui-zoom)) !important;',
    '}',
    'html {',
    `    zoom: var(${ZOOM_VAR});`,
    '}',
    '/* Zoom scales px-based popup content while the popup frame is capped to the',
    '   viewport, so a long panel can spill outside the window and push its buttons',
    '   out of reach. Keep every open popup inside the window, with a scrollable',
    '   content area. */',
    'dialog.popup[open] {',
    '    max-height: calc(100dvh / var(--tt-ui-zoom) - 2em) !important;',
    '    max-width: calc(100dvw / var(--tt-ui-zoom) - 2em) !important;',
    '}',
    'dialog.popup[open] > .popup-body {',
    '    min-height: 0 !important;',
    '    max-height: calc(100dvh / var(--tt-ui-zoom) - 3em) !important;',
    '}',
    'dialog.popup[open] > .popup-body > .popup-content {',
    '    min-height: 0 !important;',
    '    overflow-y: auto !important;',
    '}',
    'dialog.popup[open] > .popup-body > .popup-content > * {',
    '    min-height: 0;',
    '}',
    '/* Extensions that mount a full-screen editor as an iframe inside the page size it',
    '   with an inline `width: 100vw; height: 100vh` (SPreset Editor does). Viewport',
    '   units resolve against the unzoomed viewport, so such a frame ends up exactly one',
    '   zoom factor too large and only its top-left corner stays visible. The JS intercept',
    '   rewrites those writes; this rule clamps whatever still slips through. */',
    'body > iframe[style*="100vw"],',
    'body > iframe[style*="100vh"] {',
    '    max-width: calc(100vw / var(--tt-ui-zoom)) !important;',
    '    max-height: calc(100vh / var(--tt-ui-zoom)) !important;',
    '}',
    '/* The character-management and AI-configuration panels do not live in the chat',
    '   column; they live in the gap beside it:',
    '       width = (100vw - --sheldWidth) / 2   with a 100px minimum.',
    '   With a full-width chat (页面宽度 100) there is no gap left, so they collapse',
    '   into a 100px sliver and everything inside wraps character-by-character. Real',
    '   browser zoom would trip the app own narrow-viewport layout (media queries see',
    '   the zoomed viewport there), which renders these panels as full-width overlays.',
    '   CSS media queries cannot see CSS `zoom`, so emulate that here instead — only',
    '   while the chat leaves no usable gap. */',
    `body.${PANEL_GUARD_CLASS} #right-nav-panel.openDrawer,`,
    `body.${PANEL_GUARD_CLASS} #left-nav-panel.openDrawer {`,
    '    width: calc(100vw / var(--tt-ui-zoom)) !important;',
    '    max-width: calc(100vw / var(--tt-ui-zoom)) !important;',
    '    left: 0 !important;',
    '    right: auto !important;',
    '    top: var(--topBarBlockSize) !important;',
    '    height: calc(100dvh / var(--tt-ui-zoom) - var(--topBarBlockSize)) !important;',
    '    max-height: calc(100dvh / var(--tt-ui-zoom) - var(--topBarBlockSize)) !important;',
    '}',
].join('\n');

const state = {
    zoom: 1,
    coordinateFix: true,
    panelGuard: true,
    chatWidthVw: null,
    wheelStamp: 0,
    indicatorTimer: 0,
    rebuildTimer: 0,
    panelMounted: false,
    sheetCache: new WeakMap(),
    styleObserver: null,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clampZoom(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 1;
    }
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(numeric * 1000) / 1000));
}

function getStContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch {
        return null;
    }
}

function hasViewportUnit(text) {
    viewportUnitTest.lastIndex = 0;
    return viewportUnitTest.test(text);
}

function rewriteViewportUnits(text) {
    viewportUnitGlobal.lastIndex = 0;
    return text.replace(viewportUnitGlobal, (_match, amount, unit) => `calc(${amount}${unit} / var(${ZOOM_VAR}))`);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readStoredZoom() {
    const context = getStContext();
    const fromSettings = Number(context?.extensionSettings?.[SETTINGS_KEY]);
    if (Number.isFinite(fromSettings) && fromSettings > 0) {
        return clampZoom(fromSettings);
    }

    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw !== null) {
            const numeric = Number(raw);
            if (Number.isFinite(numeric) && numeric > 0) {
                return clampZoom(numeric);
            }
        }
    } catch {
        // localStorage can be unavailable; fall through to the default.
    }

    return 1;
}

function persistZoom(value) {
    try {
        localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
        // ignore
    }

    const context = getStContext();
    if (context?.extensionSettings) {
        try {
            context.extensionSettings[SETTINGS_KEY] = value;
            context.saveSettingsDebounced?.();
        } catch {
            // ignore
        }
    }
}

function readCoordinateFixPreference() {
    const context = getStContext();
    const fromSettings = context?.extensionSettings?.[COORDINATE_FIX_SETTINGS_KEY];
    if (typeof fromSettings === 'boolean') {
        return fromSettings;
    }

    try {
        const raw = localStorage.getItem(COORDINATE_FIX_STORAGE_KEY);
        if (raw === 'true' || raw === 'false') {
            return raw === 'true';
        }
    } catch {
        // ignore
    }

    return true;
}

function persistCoordinateFixPreference(enabled) {
    try {
        localStorage.setItem(COORDINATE_FIX_STORAGE_KEY, String(enabled));
    } catch {
        // ignore
    }

    const context = getStContext();
    if (context?.extensionSettings) {
        try {
            context.extensionSettings[COORDINATE_FIX_SETTINGS_KEY] = enabled;
            context.saveSettingsDebounced?.();
        } catch {
            // ignore
        }
    }
}

function readPanelGuardPreference() {
    const context = getStContext();
    const fromSettings = context?.extensionSettings?.[PANEL_GUARD_SETTINGS_KEY];
    if (typeof fromSettings === 'boolean') {
        return fromSettings;
    }

    try {
        const raw = localStorage.getItem(PANEL_GUARD_STORAGE_KEY);
        if (raw === 'true' || raw === 'false') {
            return raw === 'true';
        }
    } catch {
        // ignore
    }

    return true;
}

function persistPanelGuardPreference(enabled) {
    try {
        localStorage.setItem(PANEL_GUARD_STORAGE_KEY, String(enabled));
    } catch {
        // ignore
    }

    const context = getStContext();
    if (context?.extensionSettings) {
        try {
            context.extensionSettings[PANEL_GUARD_SETTINGS_KEY] = enabled;
            context.saveSettingsDebounced?.();
        } catch {
            // ignore
        }
    }
}

// ---------------------------------------------------------------------------
// Viewport-unit compensation
// ---------------------------------------------------------------------------

function collectMatchedRuleTexts(sheet) {
    const cached = state.sheetCache.get(sheet);
    if (cached) {
        return cached;
    }

    const matched = [];
    let rules = null;
    try {
        rules = sheet.cssRules;
    } catch {
        rules = null; // cross-origin sheet: nothing we can do about it.
    }

    if (rules) {
        for (const rule of Array.from(rules)) {
            let text = '';
            try {
                text = rule.cssText || '';
            } catch {
                text = '';
            }
            if (text && hasViewportUnit(text)) {
                matched.push(text);
            }
        }
    }

    // Only cache positive results: a stylesheet that is still empty (or filled later
    // in place) must be re-scanned on the next rebuild.
    if (matched.length > 0) {
        state.sheetCache.set(sheet, matched);
    }

    return matched;
}

function buildCompensationCss() {
    const parts = [BASE_CSS];

    for (const sheet of Array.from(document.styleSheets)) {
        const owner = sheet.ownerNode;
        if (owner && owner.id === COMPENSATION_STYLE_ID) {
            continue;
        }
        for (const ruleText of collectMatchedRuleTexts(sheet)) {
            parts.push(rewriteViewportUnits(ruleText));
        }
    }

    return parts.join('\n');
}

function ensureCompensationStyle() {
    let style = document.getElementById(COMPENSATION_STYLE_ID);
    if (!style) {
        style = document.createElement('style');
        style.id = COMPENSATION_STYLE_ID;
        style.dataset.tauritavernUiZoom = 'true';
        (document.head || document.documentElement).appendChild(style);
    }
    return style;
}

function rebuildCompensation() {
    if (state.rebuildTimer) {
        clearTimeout(state.rebuildTimer);
        state.rebuildTimer = 0;
    }

    const style = ensureCompensationStyle();
    const css = buildCompensationCss();
    if (style.textContent !== css) {
        style.textContent = css;
    }

    // Keep the override sheet last so it wins over equal-specificity app rules that
    // may have been injected after the extension was activated.
    const head = document.head;
    if (head && head.lastElementChild !== style) {
        head.appendChild(style);
    }
}

function scheduleCompensationRebuild() {
    if (state.rebuildTimer) {
        return;
    }
    state.rebuildTimer = setTimeout(() => {
        state.rebuildTimer = 0;
        try {
            rebuildCompensation();
        } catch (error) {
            console.warn('[ui-zoom] compensation rebuild failed', error);
        }
    }, COMPENSATION_REBUILD_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Inline viewport-unit compensation
//
// The stylesheet rewrite above cannot touch inline styles. The app sets e.g.
// `--sheldWidth: 50vw` (and the autocomplete sets `--bottomOffset: calc(100vh -
// ...px)`) via `style.setProperty()`, and those values are then consumed as CSS
// lengths next to our already-compensated `100vw`/`100vh` rules. Leaving them in
// unzoomed viewport units makes the character panel / autocomplete layout drift
// out of place. Rewriting them to `calc(<len> / var(--tt-ui-zoom))` keeps them
// consistent and, because they reference the live `--tt-ui-zoom`, they stay
// correct when the zoom changes.
// ---------------------------------------------------------------------------

function rewriteInlineValue(value) {
    return hasViewportUnit(value) ? rewriteViewportUnits(value) : value;
}

/**
 * Remembers how wide the chat column is, so the side-panel guard only kicks in when
 * the chat leaves no usable gap for the character / AI-configuration panels.
 */
function noteChatWidth(value) {
    const match = /^\s*([\d.]+)vw\s*$/.exec(String(value ?? ''));
    if (!match) {
        return;
    }
    const width = Number(match[1]);
    if (!Number.isFinite(width)) {
        return;
    }
    state.chatWidthVw = width;
    refreshPanelGuard();
}

function refreshPanelGuard() {
    const enabled = state.panelGuard
        && Number.isFinite(state.chatWidthVw)
        && state.chatWidthVw >= PANEL_GUARD_CHAT_WIDTH_VW;
    document.body?.classList.toggle(PANEL_GUARD_CLASS, enabled);
}

function compensateExistingInlineViewportUnits() {
    const style = document.documentElement.style;
    for (let i = 0; i < style.length; i++) {
        const property = style[i];
        if (typeof property !== 'string' || !property.startsWith('--')) {
            continue;
        }
        const value = style.getPropertyValue(property);
        if (property === '--sheldWidth') {
            noteChatWidth(value);
        }
        const rewritten = rewriteInlineValue(value);
        if (rewritten !== value) {
            style.setProperty(property, rewritten);
        }
    }
}

function installViewportUnitIntercept() {
    if (typeof CSSStyleDeclaration === 'undefined') {
        return;
    }
    const original = CSSStyleDeclaration.prototype.setProperty;
    if (original.__ttUiZoomWrapped) {
        return;
    }

    function wrappedSetProperty(property, value, priority) {
        if (property === '--sheldWidth') {
            noteChatWidth(value);
        }
        if (typeof value === 'string') {
            value = rewriteInlineValue(value);
        }
        return original.call(this, property, value, priority);
    }
    wrappedSetProperty.__ttUiZoomWrapped = true;

    CSSStyleDeclaration.prototype.setProperty = wrappedSetProperty;
}

/**
 * The values above are also written straight onto the declaration —
 * `element.style.width = '100vw'`, or, as SPreset Editor's frame-sizer does it,
 * `Object.assign(frame.style, { width: '100vw', height: '100vh' })` — and such writes
 * never reach setProperty(). Intercepting the accessors on CSSStyleDeclaration.prototype
 * catches every one of them, whatever library performed the write.
 */
function installInlineLengthIntercept() {
    if (typeof CSSStyleDeclaration === 'undefined') {
        return;
    }

    const prototype = CSSStyleDeclaration.prototype;
    const names = new Set();
    for (const property of LENGTH_PROPERTIES) {
        names.add(property);
        names.add(property.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase()));
    }

    for (const name of names) {
        let inherited;
        try {
            inherited = findPropertyDescriptor(prototype, name);
        } catch {
            inherited = undefined;
        }
        if (!inherited || typeof inherited.set !== 'function' || inherited.set.__ttUiZoomWrapped) {
            continue;
        }

        const originalSet = inherited.set;
        const wrappedSet = function wrappedLengthSetter(value) {
            if (typeof value === 'string') {
                value = rewriteInlineValue(value);
            }
            return originalSet.call(this, value);
        };
        wrappedSet.__ttUiZoomWrapped = true;

        try {
            Object.defineProperty(prototype, name, {
                configurable: true,
                enumerable: inherited.enumerable ?? false,
                get: inherited.get,
                set: wrappedSet,
            });
        } catch (error) {
            console.warn('[ui-zoom] could not intercept style.' + name, error);
        }
    }
}

// ---------------------------------------------------------------------------
// Live inline-style normalisation
//
// Blink resolves `style.width = '100vw'` through a named-property interceptor rather
// than through an accessor on CSSStyleDeclaration.prototype, so the patch above cannot
// see it there — and jQuery-based extensions write inline styles the same way. Watching
// the document for `style` attribute mutations catches every remaining path (property
// writes, Object.assign, cssText, setAttribute, jQuery .css()) and normalises the
// declarations in place. Mutation records are delivered before the next paint, so the
// corrected value is what actually gets rendered.
// ---------------------------------------------------------------------------

function normalizeStyleAttribute(element) {
    const raw = element?.getAttribute?.('style');
    if (typeof raw !== 'string' || !LOOSE_VIEWPORT_UNIT_TEST.test(raw)) {
        return;
    }

    const style = element.style;
    if (!style || typeof style.length !== 'number') {
        return;
    }

    const pending = [];
    for (let index = 0; index < style.length; index++) {
        const property = style[index];
        const value = style.getPropertyValue(property);
        if (typeof value === 'string' && hasViewportUnit(value)) {
            pending.push([property, value, style.getPropertyPriority(property)]);
        }
    }

    for (const [property, value, priority] of pending) {
        style.setProperty(property, rewriteInlineValue(value), priority);
    }
}

function normalizeStyleTree(node) {
    if (!node || node.nodeType !== 1) {
        return;
    }
    normalizeStyleAttribute(node);
    const descendants = node.querySelectorAll?.('[style]');
    if (descendants) {
        for (const descendant of descendants) {
            normalizeStyleAttribute(descendant);
        }
    }
}

function installInlineStyleWatcher() {
    if (typeof MutationObserver !== 'function' || !document.documentElement) {
        return;
    }

    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') {
                normalizeStyleAttribute(record.target);
                continue;
            }
            for (const node of record.addedNodes) {
                normalizeStyleTree(node);
            }
        }
    });

    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style'],
        childList: true,
        subtree: true,
    });
    state.styleObserver = observer;
}

// ---------------------------------------------------------------------------
// Coordinate-space normalisation
//
// Under `zoom` on <html> Chromium reports getBoundingClientRect(), clientX/clientY,
// elementFromPoint() and window.innerWidth in *visual* pixels, while CSS lengths,
// offsetWidth and getComputedStyle stay in unzoomed CSS pixels. Dividing the former
// by the zoom factor puts the whole JS world back into CSS pixels, which is exactly
// the coordinate space the app sees at 100% zoom.
// ---------------------------------------------------------------------------

function makeRect(x, y, width, height) {
    if (typeof DOMRect === 'function') {
        return new DOMRect(x, y, width, height);
    }
    return {
        x, y, width, height,
        left: x,
        top: y,
        right: x + width,
        bottom: y + height,
        toJSON() {
            return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
        },
    };
}

function findPropertyDescriptor(target, property) {
    let current = target;
    while (current) {
        const descriptor = Object.getOwnPropertyDescriptor(current, property);
        if (descriptor) {
            return descriptor;
        }
        current = Object.getPrototypeOf(current);
    }
    return undefined;
}

function redefineGetter(target, property, compute) {
    if (!target) {
        return false;
    }

    try {
        const inherited = findPropertyDescriptor(target, property);
        const original = inherited?.get;
        if (typeof original !== 'function') {
            return false;
        }

        Object.defineProperty(target, property, {
            configurable: true,
            enumerable: inherited.enumerable ?? false,
            get() {
                const value = original.call(this);
                return typeof value === 'number' ? compute(value) : value;
            },
        });
        return true;
    } catch {
        return false;
    }
}

function installCoordinateNormalization() {
    const toCss = value => value / state.zoom;
    const toVisual = value => value * state.zoom;

    const scaleRect = rect => makeRect(
        toCss(rect.left),
        toCss(rect.top),
        toCss(rect.width),
        toCss(rect.height),
    );

    const wrapRectGetter = (target, property) => {
        const original = target?.[property];
        if (typeof original !== 'function') {
            return;
        }
        try {
            Object.defineProperty(target, property, {
                configurable: true,
                writable: true,
                value: function (...args) {
                    return scaleRect(original.apply(this, args));
                },
            });
        } catch {
            // ignore
        }
    };

    const wrapRectListGetter = (target, property) => {
        const original = target?.[property];
        if (typeof original !== 'function') {
            return;
        }
        try {
            Object.defineProperty(target, property, {
                configurable: true,
                writable: true,
                value: function (...args) {
                    const list = original.apply(this, args);
                    const rects = Array.from(list, scaleRect);
                    rects.item = index => rects[index] ?? null;
                    return rects;
                },
            });
        } catch {
            // ignore
        }
    };

    wrapRectGetter(Element.prototype, 'getBoundingClientRect');
    wrapRectListGetter(Element.prototype, 'getClientRects');
    if (typeof Range !== 'undefined') {
        wrapRectGetter(Range.prototype, 'getBoundingClientRect');
        wrapRectListGetter(Range.prototype, 'getClientRects');
    }

    for (const property of ['clientX', 'clientY', 'pageX', 'pageY', 'offsetX', 'offsetY']) {
        redefineGetter(MouseEvent.prototype, property, toCss);
    }
    if (typeof Touch !== 'undefined') {
        for (const property of ['clientX', 'clientY', 'pageX', 'pageY']) {
            redefineGetter(Touch.prototype, property, toCss);
        }
    }

    redefineGetter(window, 'innerWidth', toCss);
    redefineGetter(window, 'innerHeight', toCss);
    // Measured on Chromium: the root element reports client/scroll metrics in visual
    // pixels while `offsetWidth` and all non-root elements (including body) already
    // report unzoomed CSS pixels.
    for (const property of ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight']) {
        redefineGetter(document.documentElement, property, toCss);
    }

    const visualViewport = window.visualViewport;
    if (visualViewport) {
        for (const property of ['width', 'height', 'offsetLeft', 'offsetTop']) {
            redefineGetter(visualViewport, property, toCss);
        }
    }

    for (const name of ['elementFromPoint', 'elementsFromPoint', 'caretRangeFromPoint', 'caretPositionFromPoint']) {
        const original = document[name];
        if (typeof original !== 'function') {
            continue;
        }
        try {
            Object.defineProperty(document, name, {
                configurable: true,
                writable: true,
                value: function (x, y, ...rest) {
                    return original.call(this, toVisual(x), toVisual(y), ...rest);
                },
            });
        } catch {
            // ignore
        }
    }
}

// ---------------------------------------------------------------------------
// Startup log
// ---------------------------------------------------------------------------

function logStartupState() {
    try {
        const style = document.getElementById(COMPENSATION_STYLE_ID);
        const rules = style ? (style.textContent.match(/calc\(/g) || []).length : 0;
        console.info(
            `[ui-zoom] active — zoom ${Math.round(state.zoom * 100)}%, `
            + `coordinate fix ${state.coordinateFix ? 'on' : 'off'}, ${rules} compensated rules`,
        );
    } catch {
        // ignore
    }

    // Remove diagnostics left behind by an earlier diagnostic build.
    const context = getStContext();
    if (context?.extensionSettings && 'tauritavernUiZoomDiagnostics' in context.extensionSettings) {
        try {
            delete context.extensionSettings.tauritavernUiZoomDiagnostics;
            context.saveSettingsDebounced?.();
        } catch {
            // ignore
        }
    }
}

// ---------------------------------------------------------------------------
// Zoom indicator (small centered bubble, like Chrome's zoom feedback)
// ---------------------------------------------------------------------------

function showIndicator(value) {
    if (!document.body) {
        return;
    }

    let indicator = document.getElementById(INDICATOR_ID);
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = INDICATOR_ID;
        indicator.className = 'tt-ui-zoom-indicator';
        document.body.appendChild(indicator);
    }

    indicator.textContent = `${Math.round(value * 100)}%`;
    indicator.classList.add('visible');

    if (state.indicatorTimer) {
        clearTimeout(state.indicatorTimer);
    }
    state.indicatorTimer = setTimeout(() => {
        state.indicatorTimer = 0;
        indicator.classList.remove('visible');
    }, INDICATOR_DURATION_MS);
}

// ---------------------------------------------------------------------------
// Applying zoom
// ---------------------------------------------------------------------------

function refreshPanel(value) {
    const range = document.getElementById('tt_ui_zoom_range');
    const label = document.getElementById('tt_ui_zoom_value');
    const percent = Math.round(value * 100);

    if (range && Number(range.value) !== percent) {
        range.value = String(percent);
    }
    if (label) {
        label.textContent = `${percent}%`;
    }
}

function applyZoom(value, options = {}) {
    const { persist = true, announce = true } = options;
    const next = clampZoom(value);
    state.zoom = next;

    const root = document.documentElement;
    root.style.setProperty(ZOOM_VAR, String(next));
    root.style.zoom = String(next);

    refreshPanel(next);

    if (persist) {
        persistZoom(next);
    }
    if (announce) {
        showIndicator(next);
    }

    return next;
}

function zoomStep(direction) {
    const current = state.zoom;
    const epsilon = 1e-3;

    if (direction > 0) {
        const next = ZOOM_LADDER.find(value => value > current + epsilon);
        return applyZoom(next ?? MAX_ZOOM);
    }

    const lower = [...ZOOM_LADDER].reverse().find(value => value < current - epsilon);
    return applyZoom(lower ?? MIN_ZOOM);
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

function matchZoomAction(event) {
    const key = String(event.key || '');
    const code = String(event.code || '');

    if (key === '+' || key === '=' || code === 'NumpadAdd' || key === 'Add') {
        return 'in';
    }
    if (key === '-' || key === '_' || code === 'NumpadSubtract' || key === 'Subtract') {
        return 'out';
    }
    if (key === '0' || code === 'Numpad0') {
        return 'reset';
    }

    return null;
}

function onKeyDown(event) {
    if (event.defaultPrevented) {
        return;
    }
    if (!(event.ctrlKey || event.metaKey)) {
        return;
    }

    const action = matchZoomAction(event);
    if (!action) {
        return;
    }

    // Plain Ctrl + +/-/0 is the browser-like family; Ctrl + Alt + ... is the
    // fallback family that always reaches the page. Both are handled here.
    event.preventDefault();
    event.stopPropagation();

    if (action === 'in') {
        zoomStep(1);
    } else if (action === 'out') {
        zoomStep(-1);
    } else {
        applyZoom(1);
    }
}

function onWheel(event) {
    if (!(event.ctrlKey || event.metaKey)) {
        return;
    }
    if (Math.abs(event.deltaY) < WHEEL_MIN_DELTA) {
        return;
    }

    // Ctrl + wheel is page zoom in a browser; pinch-to-zoom on a trackpad also
    // arrives as a ctrl+wheel event, hence the small throttle.
    event.preventDefault();
    event.stopPropagation();

    const now = Date.now();
    if (now - state.wheelStamp < WHEEL_STEP_INTERVAL_MS) {
        return;
    }
    state.wheelStamp = now;

    zoomStep(event.deltaY < 0 ? 1 : -1);
}

function installInputHandlers() {
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
}

// ---------------------------------------------------------------------------
// Settings panel (Extensions drawer)
// ---------------------------------------------------------------------------

function createPanel() {
    const container = document.createElement('div');
    container.className = 'extension_container';
    container.id = PANEL_CONTAINER_ID;
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>界面缩放 UI Zoom</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="tt-ui-zoom-row">
                    <div id="tt_ui_zoom_out" class="menu_button menu_button_icon" title="缩小 (Ctrl + -)">
                        <i class="fa-solid fa-minus"></i>
                    </div>
                    <input id="tt_ui_zoom_range" class="tt-ui-zoom-range" type="range"
                        min="${Math.round(MIN_ZOOM * 100)}" max="${Math.round(MAX_ZOOM * 100)}"
                        step="5" value="100" title="拖动调整整个界面的缩放比例">
                    <div id="tt_ui_zoom_in" class="menu_button menu_button_icon" title="放大 (Ctrl + +)">
                        <i class="fa-solid fa-plus"></i>
                    </div>
                    <span id="tt_ui_zoom_value" class="tt-ui-zoom-value">100%</span>
                </div>
                <div class="tt-ui-zoom-row">
                    <div id="tt_ui_zoom_reset" class="menu_button menu_button_icon" title="恢复 100% (Ctrl + 0)">
                        <i class="fa-solid fa-rotate-left"></i>
                        <span>恢复 100%</span>
                    </div>
                </div>
                <div class="tt-ui-zoom-row">
                    <label class="checkbox_label" title="把鼠标坐标换算回 CSS 像素，避免放大后弹窗、右键菜单、拖动位置出现偏移。修改后需要重启界面才生效。">
                        <input type="checkbox" id="tt_ui_zoom_coordinate_fix">
                        <span>坐标修正（推荐，重启界面后生效）</span>
                    </label>
                </div>
                <div class="tt-ui-zoom-row">
                    <label class="checkbox_label" title="角色管理 / AI 配置面板平时住在聊天区两侧的空隙里，宽度 =（窗口宽 − 页面宽度）/2，最小 100px。页面宽度调到 100 时没有空隙，它们会被压成 100px 窄条、文字逐字换行。打开这个开关后，只有在这种情况下才把这两个面板铺满窗口（App 在窄窗口下的做法）。">
                        <input type="checkbox" id="tt_ui_zoom_panel_guard">
                        <span>页面宽度接近 100 时侧边栏铺满（推荐）</span>
                    </label>
                </div>
                <small class="tt-ui-zoom-hint">
                    <b>Ctrl + 鼠标滚轮</b> 缩放整个界面，和浏览器一样；<b>Ctrl + 加号 / 减号</b> 放大缩小，<b>Ctrl + 0</b> 恢复 100%。<br>
                    如果这几个组合键被系统或 WebView 占用，请改用 <b>Ctrl + Alt + 加号 / 减号 / 0</b>，或直接拖动上面的滑块。<br>
                    缩放比例会自动保存，下次启动仍然生效。
                </small>
            </div>
        </div>
    `;
    return container;
}

function bindPanel(container) {
    const range = container.querySelector('#tt_ui_zoom_range');
    const out = container.querySelector('#tt_ui_zoom_out');
    const inn = container.querySelector('#tt_ui_zoom_in');
    const reset = container.querySelector('#tt_ui_zoom_reset');
    const coordinateFix = container.querySelector('#tt_ui_zoom_coordinate_fix');
    const panelGuard = container.querySelector('#tt_ui_zoom_panel_guard');

    range?.addEventListener('input', () => {
        applyZoom(Number(range.value) / 100, { persist: false });
    });
    range?.addEventListener('change', () => {
        applyZoom(Number(range.value) / 100);
    });
    out?.addEventListener('click', () => zoomStep(-1));
    inn?.addEventListener('click', () => zoomStep(1));
    reset?.addEventListener('click', () => applyZoom(1));

    if (coordinateFix) {
        coordinateFix.checked = state.coordinateFix;
        coordinateFix.addEventListener('change', () => {
            state.coordinateFix = coordinateFix.checked;
            persistCoordinateFixPreference(state.coordinateFix);
        });
    }

    if (panelGuard) {
        panelGuard.checked = state.panelGuard;
        panelGuard.addEventListener('change', () => {
            state.panelGuard = panelGuard.checked;
            persistPanelGuardPreference(state.panelGuard);
            refreshPanelGuard();
        });
    }
}

function mountPanel() {
    if (state.panelMounted && document.getElementById(PANEL_CONTAINER_ID)) {
        return;
    }

    const settingsHost = document.getElementById('extensions_settings');
    if (!settingsHost) {
        return;
    }

    document.getElementById(PANEL_CONTAINER_ID)?.remove();
    const container = createPanel();
    bindPanel(container);
    settingsHost.append(container);
    state.panelMounted = true;
    refreshPanel(state.zoom);
}

function waitForPanelHost() {
    const started = Date.now();
    const timer = setInterval(() => {
        mountPanel();
        if (state.panelMounted || Date.now() - started > PANEL_MOUNT_TIMEOUT_MS) {
            clearInterval(timer);
        }
    }, 1000);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function watchStylesheets() {
    if (!document.head) {
        return;
    }

    const observer = new MutationObserver(mutations => {
        // Ignore our own style element being written/re-appended.
        const relevant = mutations.some(mutation => {
            const nodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
            return nodes.some(node => !(node.nodeType === 1 && node.id === COMPENSATION_STYLE_ID));
        });
        if (relevant) {
            scheduleCompensationRebuild();
        }
    });
    observer.observe(document.head, { childList: true, subtree: true });

    window.addEventListener('load', () => scheduleCompensationRebuild());
    // Linked stylesheets may still be loading/parsing right after activation.
    [250, 1000, 3000, 8000].forEach(delay => setTimeout(() => scheduleCompensationRebuild(), delay));
}

function boot() {
    state.coordinateFix = readCoordinateFixPreference();
    state.panelGuard = readPanelGuardPreference();

    const existing = globalThis.__ttUiZoom;
    if (existing) {
        // Extension was re-activated without a page reload: re-apply and refresh UI.
        existing.applyZoom(readStoredZoom(), { persist: false, announce: false });
        existing.rebuildCompensation();
        refreshPanelGuard();
        return;
    }

    globalThis.__ttUiZoom = { applyZoom, zoomStep, rebuildCompensation, refreshPanelGuard, state };

    installInputHandlers();
    ensureCompensationStyle();
    applyZoom(readStoredZoom(), { persist: false, announce: false });
    compensateExistingInlineViewportUnits();
    installViewportUnitIntercept();
    installInlineLengthIntercept();
    installInlineStyleWatcher();
    refreshPanelGuard();
    rebuildCompensation();
    watchStylesheets();

    if (state.coordinateFix) {
        try {
            installCoordinateNormalization();
        } catch (error) {
            console.warn('[ui-zoom] coordinate normalization failed', error);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForPanelHost, { once: true });
    } else {
        waitForPanelHost();
    }

    // Report the settled state to the frontend console once startup is done.
    setTimeout(() => {
        try {
            logStartupState();
        } catch (error) {
            console.warn('[ui-zoom] startup log failed', error);
        }
    }, 3000);
}

boot();
