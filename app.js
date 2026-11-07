/* =========================================================
   GOmetta — app logic
   Работает в двух режимах:
   - с backend (config.js): реальная переписка через API;
   - без backend: локальное демо в localStorage.
   ========================================================= */

(() => {
  'use strict';

  const STORE_KEY = 'gometta.state.v1';
  const SESSION_KEY = 'gometta.session.v1';
  const TOKEN_KEY = 'gometta.token.v1';
  const MOBILE_QUERY = '(max-width: 860px)';

  /* Адрес backend. Пусто = демо-режим без сервера (см. config.js). */
  const API_BASE = String(window.GOMETTA_API || '').replace(/\/+$/, '');
  const REMOTE = Boolean(API_BASE);

  /* Telegram Mini App — единственный способ входа: номер подтверждает Telegram.
     SDK загружается только внутри Telegram — обычный сайт не ждёт telegram.org. */
  const TELEGRAM_SDK = 'https://telegram.org/js/telegram-web-app.js';
  let tg = null;
  let tgUser = null;
  let inTelegram = false;
  let botUsername = String(window.GOMETTA_BOT || '').trim().replace(/^@/, '');

  function detectTelegram() {
    tg = window.Telegram?.WebApp || null;
    tgUser = tg?.initDataUnsafe?.user || null;
    inTelegram = Boolean(tg && (tg.initData || tgUser));
  }

  function looksLikeTelegram() {
    return /tgWebApp(Data|Version|Platform|StartParam)=/.test(location.hash + location.search);
  }

  function loadTelegramSdk(done) {
    if (!looksLikeTelegram() || window.Telegram?.WebApp) {
      done();
      return;
    }
    const script = document.createElement('script');
    script.src = TELEGRAM_SDK;
    script.onload = done;
    script.onerror = done;
    document.head.appendChild(script);
  }

  /* ---------------------------------------------------------
     Utilities
     --------------------------------------------------------- */

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const uid = (prefix = 'id') =>
    `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;

  const esc = (value = '') =>
    String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));

  const pad = (n) => String(n).padStart(2, '0');
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  const fmtTime = (ts) => {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const startOfDay = (ts) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  const fmtDay = (ts) => {
    const today = startOfDay(Date.now());
    const day = startOfDay(ts);
    if (day === today) return 'Сегодня';
    if (day === today - DAY) return 'Вчера';
    const d = new Date(ts);
    const opts = { day: 'numeric', month: 'long' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('ru-RU', opts);
  };

  const fmtListTime = (ts) => {
    const today = startOfDay(Date.now());
    const day = startOfDay(ts);
    if (day === today) return fmtTime(ts);
    if (day === today - DAY) return 'Вчера';
    const d = new Date(ts);
    return d.toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      ...(d.getFullYear() !== new Date().getFullYear() ? { year: '2-digit' } : {}),
    });
  };

  const fmtDuration = (seconds) => {
    const safe = Math.max(0, Number(seconds) || 0);
    return `${Math.floor(safe / 60)}:${pad(safe % 60)}`;
  };

  const hueFor = (text) => {
    let hash = 0;
    for (const ch of String(text || '?')) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return hash;
  };

  const initials = (name) => {
    const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
    return parts.map((word) => word[0]?.toUpperCase() || '').join('') || '?';
  };

  const avatarStyle = (hue) =>
    `background:linear-gradient(135deg,hsl(${hue} 72% 56%),hsl(${(hue + 46) % 360} 68% 44%))`;

  const avatarHTML = (name, hue, extraClass = '') =>
    `<span class="avatar ${extraClass}" style="${avatarStyle(hue)}">${esc(initials(name))}</span>`;

  const linkify = (escapedText) =>
    escapedText.replace(/(https?:\/\/[^\s<]+)/g, (url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  const formatPhone = (code, digits) => {
    const grouped = digits.length === 10
      ? digits.replace(/(\d{3})(\d{3})(\d{2})(\d{2})/, '$1 $2-$3-$4')
      : digits.replace(/(\d{3})(?=\d)/g, '$1 ');
    return `${code} ${grouped}`.trim();
  };

  const formatPhoneDisplay = (phone) => {
    if (!phone) return '';
    const raw = String(phone).trim();
    if (/\s/.test(raw)) return raw;
    const knownCodes = ['+995', '+972', '+971', '+375', '+380', '+374', '+44', '+49', '+90', '+1', '+7'];
    const code = knownCodes.find((item) => raw.startsWith(item));
    if (code) return formatPhone(code, raw.slice(code.length));
    return raw;
  };

  /* ---------------------------------------------------------
     Storage
     --------------------------------------------------------- */

  const loadState = () => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      console.warn('Не удалось прочитать состояние:', error);
      return null;
    }
  };

  const save = () => {
    if (!state) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (error) {
      console.warn('Не удалось сохранить состояние:', error);
    }
  };

  const hasSession = () => {
    try {
      return localStorage.getItem(SESSION_KEY) === '1';
    } catch (error) {
      return false;
    }
  };

  const setSession = (active) => {
    try {
      if (active) localStorage.setItem(SESSION_KEY, '1');
      else localStorage.removeItem(SESSION_KEY);
    } catch (error) {
      /* localStorage может быть недоступен */
    }
  };

  const loadToken = () => {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (error) {
      return '';
    }
  };

  const storeToken = (token) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (error) {
      /* localStorage может быть недоступен */
    }
  };

  /* ---------------------------------------------------------
     Remote backend (реальная переписка между устройствами)
     --------------------------------------------------------- */

  let authToken = '';
  let syncVersion = 0;
  let syncTimer = null;
  let syncBusy = false;
  let syncAbort = null;
  let syncGeneration = 0;

  async function api(path, options = {}) {
    const { method = 'GET', body, timeout = 20000, signal } = options;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers = {};
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (authToken) headers.Authorization = `Bearer ${authToken}`;

      const response = await fetch(API_BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      let data = {};
      try {
        data = await response.json();
      } catch (error) {
        data = {};
      }

      if (!response.ok) {
        const failure = new Error(data.error || `Ошибка сервера (${response.status})`);
        failure.status = response.status;
        if (response.status === 401 && authToken) handleUnauthorized();
        throw failure;
      }

      return data;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  function handleUnauthorized() {
    stopSync();
    authToken = '';
    storeToken('');
    setSession(false);
    state = null;
    closeModal('settings');
    showAuth();
    toast('Сессия истекла — войдите снова');
  }

  function normalizeRemoteChat(chat) {
    const messages = (chat.messages || []).map((message, index) => ({
      id: message.id || `m_${chat.id}_${index}`,
      from: message.from === 'me' ? 'me' : 'them',
      text: String(message.text || ''),
      ts: Number(message.ts) || Date.now(),
      status: message.status === 'read' ? 'read' : 'sent',
      ...(message.sender ? { sender: message.sender } : {}),
    }));

    return {
      id: chat.id,
      name: chat.name || 'Чат',
      phone: chat.phone || '',
      hue: typeof chat.hue === 'number' ? chat.hue : hueFor(chat.name || ''),
      demo: false,
      group: Boolean(chat.group),
      pinned: Boolean(chat.pinned),
      unread: Number(chat.unread) || 0,
      createdAt: Number(chat.createdAt) || Date.now(),
      messages,
    };
  }

  function applyRemoteState(data) {
    if (!data || !data.user) return;

    const version = Number(data.version) || 0;
    if (version && version < syncVersion) return;

    const previous = state;
    const previousActiveId = previous?.activeChatId || null;
    const previousChat = previous?.chats.find((chat) => chat.id === previousActiveId) || null;
    const previousLast = previousChat?.messages[previousChat.messages.length - 1];

    const chats = (data.chats || []).map(normalizeRemoteChat);
    const active = chats.find((chat) => chat.id === previousActiveId) || null;
    const nextLast = active?.messages[active.messages.length - 1];

    state = {
      version: 2,
      user: {
        id: data.user.id,
        name: data.user.name || 'Пользователь',
        phone: data.user.phone || '',
        username: data.user.username || '',
        hue: typeof data.user.hue === 'number' ? data.user.hue : hueFor(data.user.phone || ''),
      },
      activeChatId: active ? active.id : null,
      settings: previous?.settings || { theme: 'dark', notifications: true },
      chats,
      calls: previous?.calls || [],
    };
    syncVersion = version || syncVersion;
    save();

    if ($('#app').hidden) return;

    if (active && active.unread > 0 && !document.hidden) {
      active.unread = 0;
      api(`/api/chats/${active.id}/read`, { method: 'POST' }).catch(() => {});
    }

    renderMe();
    renderTabs();
    renderChatList();
    renderCalls();

    if (active) {
      renderChatHeader();
      const changed = !previousLast || !nextLast || nextLast.id !== previousLast.id;
      renderMessages(Boolean(changed));
    } else if (previousActiveId) {
      showWelcome();
    }
  }

  async function loadRemote(enter) {
    const data = await api('/api/state?since=0&timeout=0', { timeout: 15000 });
    applyRemoteState(data);
    if (enter) enterApp();
    startSync();
  }

  async function refreshRemote() {
    if (!REMOTE || !authToken) return;
    try {
      const data = await api('/api/state?since=0&timeout=0', { timeout: 15000 });
      applyRemoteState(data);
    } catch (error) {
      /* следующая синхронизация повторит попытку */
    }
  }

  function scheduleSync(delay = 250) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runSync, delay);
  }

  async function runSync() {
    if (!REMOTE || !authToken) return;
    if (syncBusy) return;

    syncBusy = true;
    const generation = syncGeneration;
    const controller = new AbortController();
    syncAbort = controller;

    try {
      const data = await api(`/api/state?since=${syncVersion}&timeout=25`, {
        timeout: 30000,
        signal: controller.signal,
      });
      if (generation !== syncGeneration) return;
      applyRemoteState(data);
    } catch (error) {
      if (generation !== syncGeneration) return;
      if (error.name === 'AbortError') return;
      if (error.status === 401) return;
      scheduleSync(3000);
      return;
    } finally {
      if (generation === syncGeneration) {
        syncBusy = false;
        syncAbort = null;
      }
    }

    if (generation === syncGeneration) scheduleSync(250);
  }

  function startSync() {
    if (!REMOTE || !authToken) return;
    stopSync();
    runSync();
  }

  function stopSync() {
    syncGeneration += 1;
    clearTimeout(syncTimer);
    syncTimer = null;
    if (syncAbort) {
      syncAbort.abort();
      syncAbort = null;
    }
    syncBusy = false;
  }

  /* ---------------------------------------------------------
     State
     --------------------------------------------------------- */

  let state = loadState();
  let toastTimer = null;

  const ui = {
    tab: 'chats',
    query: '',
    call: null,
    typingTimers: {},
  };

  function normalizeState(candidate) {
    if (!candidate || !candidate.user || !Array.isArray(candidate.chats)) return null;
    candidate.calls = Array.isArray(candidate.calls) ? candidate.calls : [];
    candidate.settings = candidate.settings || {};
    candidate.settings.theme = candidate.settings.theme === 'light' ? 'light' : 'dark';
    candidate.settings.notifications = candidate.settings.notifications !== false;
    candidate.chats = candidate.chats.filter((chat) => chat && chat.id && chat.name);
    candidate.chats.forEach((chat) => {
      chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
      chat.unread = Number(chat.unread) || 0;
      chat.hue = typeof chat.hue === 'number' ? chat.hue : hueFor(chat.name);
      chat.demo = Boolean(chat.demo);
      chat.group = Boolean(chat.group);
      chat.pinned = Boolean(chat.pinned);
    });
    return candidate;
  }

  function seedState(user) {
    const now = Date.now();
    return {
      version: 2,
      user,
      activeChatId: null,
      settings: { theme: 'dark', notifications: true },
      chats: [
        {
          id: 'chat-anya',
          name: 'Аня Соколова',
          phone: '+79162001122',
          hue: 322,
          demo: true,
          group: false,
          pinned: true,
          unread: 2,
          createdAt: now - 3 * DAY,
          messages: [
            { id: 'm-a1', from: 'them', text: 'Привет! Ты уже посмотрел новый макет?', ts: now - 2 * HOUR, status: 'read' },
            { id: 'm-a2', from: 'me', text: 'Да, выглядит отлично. Особенно тёмная тема 🔥', ts: now - 2 * HOUR + 4 * MINUTE, status: 'read' },
            { id: 'm-a3', from: 'them', text: 'Супер. Тогда собираем релиз в пятницу?', ts: now - 26 * MINUTE, status: 'read' },
            { id: 'm-a4', from: 'them', text: 'Скинь, пожалуйста, финальную версию вечером', ts: now - 24 * MINUTE, status: 'read' },
          ],
        },
        {
          id: 'chat-team',
          name: 'Команда GOmetta',
          phone: '',
          hue: 215,
          demo: true,
          group: true,
          pinned: false,
          unread: 0,
          createdAt: now - 8 * DAY,
          messages: [
            { id: 'm-t1', from: 'them', sender: 'Дима', text: 'Всем привет! Созвон в 16:00, скидываю ссылку.', ts: now - 5 * HOUR, status: 'read' },
            { id: 'm-t2', from: 'them', sender: 'Аня', text: 'Я буду. Возьму заметки по звонкам.', ts: now - 4.6 * HOUR, status: 'read' },
            { id: 'm-t3', from: 'me', text: 'Ок, тоже подключусь.', ts: now - 4.4 * HOUR, status: 'read' },
            { id: 'm-t4', from: 'them', sender: 'Костя', text: 'Не забудьте про демо-режим 😉', ts: now - 3.8 * HOUR, status: 'read' },
          ],
        },
        {
          id: 'chat-assistant',
          name: 'Ассистент',
          phone: '',
          hue: 265,
          demo: true,
          group: false,
          pinned: false,
          unread: 0,
          createdAt: now - 2 * DAY,
          messages: [
            { id: 'm-s1', from: 'them', text: 'Привет! Я демо-ассистент GOmetta. Напишите мне что-нибудь — покажу, как работают сообщения.', ts: now - HOUR, status: 'read' },
            { id: 'm-s2', from: 'them', text: 'Кстати, звонки уже можно попробовать: кнопки телефона и камеры в шапке чата.', ts: now - 55 * MINUTE, status: 'read' },
          ],
        },
        {
          id: 'chat-maxim',
          name: 'Максим Орлов',
          phone: '+79995553311',
          hue: 150,
          demo: true,
          group: false,
          pinned: false,
          unread: 0,
          createdAt: now - 4 * DAY,
          messages: [
            { id: 'm-x1', from: 'me', text: 'Максим, привет! Отправил файлы на почту.', ts: now - 26 * HOUR, status: 'read' },
            { id: 'm-x2', from: 'them', text: 'Спасибо, гляну завтра с утра 👍', ts: now - 25 * HOUR, status: 'read' },
          ],
        },
      ],
      calls: [
        { id: 'call-1', chatId: 'chat-anya', name: 'Аня Соколова', media: 'audio', type: 'out', ts: now - 3 * HOUR, duration: 254 },
        { id: 'call-2', chatId: 'chat-team', name: 'Команда GOmetta', media: 'video', type: 'in', ts: now - 28 * HOUR, duration: 1830 },
      ],
    };
  }

  const REPLY_POOLS = {
    'chat-anya': [
      'Ок, договорились 👍',
      'Хорошо, скину вечером',
      'Спасибо! Тогда на связи',
      'Ага, я поняла',
      'Супер, спасибо большое!',
    ],
    'chat-team': [
      'Принято 👌',
      'Согласен с Аней.',
      'Давайте обсудим на созвоне.',
      'Я записал, спасибо.',
      'Ок, беру на себя.',
    ],
    'chat-assistant': [
      'Это демо-ответ. Подключите backend — и сообщения станут настоящими.',
      'Я на связи 24/7 🙂',
      'Можно отправлять ссылки: https://github.com',
      'Попробуйте позвонить — кнопки в шапке чата.',
    ],
    'chat-maxim': [
      'Ок, спасибо!',
      'Понял, отвечу позже.',
      'Договорились.',
      '👍',
    ],
  };

  const DEFAULT_REPLIES = ['Ок 👍', 'Понял, спасибо!', 'Договорились.', 'Хорошо, отвечу чуть позже.'];
  const GROUP_SENDERS = ['Аня', 'Дима', 'Костя'];
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  /* ---------------------------------------------------------
     Theme
     --------------------------------------------------------- */

  function syncThemeButtons() {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    $$('#themeSwitch [data-theme-value]').forEach((button) => {
      const active = button.dataset.themeValue === current;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function applyTheme(theme, persist = false) {
    const value = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = value;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', value === 'light' ? '#eef2f9' : '#0b0e14');
    const toggleUse = $('#themeToggle use');
    if (toggleUse) toggleUse.setAttribute('href', value === 'dark' ? '#i-sun' : '#i-moon');
    if (persist && state) {
      state.settings.theme = value;
      save();
    }
    syncThemeButtons();
  }

  /* ---------------------------------------------------------
     Auth — только через Telegram
     --------------------------------------------------------- */

  function telegramOpenUrl() {
    return botUsername ? `https://t.me/${botUsername}?startapp=login` : '';
  }

  function showAuth() {
    $('#app').hidden = true;
    $('#authScreen').hidden = false;
    $('#app').classList.remove('chat-open');
    $('#tgError').hidden = true;
    $('#stepTelegram').hidden = false;
  }

  function refreshTelegramLink() {
    const url = telegramOpenUrl();
    const openBot = $('#tgOpenBot');
    openBot.hidden = inTelegram || !url;
    if (url) openBot.href = url;
    if (!inTelegram) {
      $('#tgHint').textContent = url
        ? 'GOmetta работает внутри Telegram. Откройте бота и нажмите «Подтвердить номер».'
        : 'GOmetta работает только внутри Telegram. Укажите GOMETTA_BOT на сервере (см. README).';
    }
  }

  /* ---------------------------------------------------------
     Вход через Telegram (единственный способ)
     --------------------------------------------------------- */

  function telegramDisplayName() {
    const full = [tgUser?.first_name, tgUser?.last_name].filter(Boolean).join(' ').trim();
    return full || tgUser?.username || 'Пользователь';
  }

  async function loginWithTelegram(rawPhone) {
    const error = $('#tgError');
    const phone = normalizePhoneInput(rawPhone);

    if (!REMOTE) {
      error.textContent = 'Сервер не подключён. Откройте GOmetta на рабочем сервере.';
      error.hidden = false;
      return;
    }
    if (!phone) {
      error.textContent = 'Telegram не передал номер. Попробуйте ещё раз.';
      error.hidden = false;
      return;
    }

    const button = $('#tgPhoneBtn');
    button.disabled = true;
    error.hidden = true;
    try {
      const result = await api('/api/auth/telegram', {
        method: 'POST',
        body: {
          phone,
          name: telegramDisplayName(),
          telegramId: tgUser?.id ? String(tgUser.id) : '',
          initData: tg?.initData || '',
        },
      });
      authToken = result.token;
      storeToken(result.token);
      setSession(true);
      await loadRemote(true);
      toast(`Добро пожаловать, ${result.user.name}!`);
    } catch (failure) {
      error.textContent = failure.message || 'Не удалось войти через Telegram.';
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  function requestTelegramPhone() {
    const error = $('#tgError');
    const button = $('#tgPhoneBtn');
    error.hidden = true;

    if (!tg || typeof tg.requestContact !== 'function') {
      error.textContent = 'Обновите Telegram, чтобы поделиться номером.';
      error.hidden = false;
      return;
    }

    const handle = (shared, event) => {
      button.disabled = false;
      const contact = event?.contact || (shared && typeof shared === 'object' ? shared : null);
      const approved = typeof shared === 'boolean' ? shared : Boolean(contact);
      const phone = approved ? contact?.phone_number : '';
      if (!phone) {
        error.textContent = 'Номер не получен. Разрешите доступ к контакту и попробуйте ещё раз.';
        error.hidden = false;
        return;
      }
      loginWithTelegram(phone);
    };

    button.disabled = true;
    try {
      tg.requestContact(handle);
    } catch (err) {
      button.disabled = false;
      error.textContent = 'Не удалось запросить номер. Откройте GOmetta из бота Telegram.';
      error.hidden = false;
    }
  }

  function initTelegram() {
    if (inTelegram) {
      try {
        tg.ready();
        tg.expand();
        tg.setHeaderColor?.('#0b0e14');
        tg.setBackgroundColor?.('#0b0e14');
      } catch (err) {
        /* вне Telegram методы могут быть недоступны */
      }

      $('#tgBlock').hidden = false;
      $('#tgOpenBot').hidden = true;
      const first = tgUser?.first_name || '';
      if (first) $('#tgGreeting').textContent = `Привет, ${first}!`;
      $('#tgHint').textContent = 'Номер подтвердит сам Telegram — SMS и коды не нужны.';

      $('#tgPhoneBtn').addEventListener('click', requestTelegramPhone);

      /* Некоторые версии клиента присылают контакт событием, а не в callback. */
      tg.onEvent?.('contactRequested', (event) => {
        const phone = event?.contact?.phone_number;
        if (!phone) return;
        $('#tgPhoneBtn').disabled = false;
        loginWithTelegram(phone);
      });
    } else {
      $('#tgBlock').hidden = true;
    }

    refreshTelegramLink();
  }

  function normalizePhoneInput(value) {
    const raw = String(value || '').trim();
    let digits = raw.replace(/\D/g, '');
    if (!digits) return '';
    if (!raw.startsWith('+')) {
      if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
      else if (digits.length === 10) digits = `7${digits}`;
    }
    return `+${digits}`;
  }

  /* ---------------------------------------------------------
     App entry
     --------------------------------------------------------- */

  function enterApp() {
    $('#authScreen').hidden = true;
    $('#app').hidden = false;
    applyTheme(state.settings?.theme || 'dark');
    ui.tab = 'chats';
    ui.query = '';
    $('#searchInput').value = '';
    renderMe();
    renderTabs();
    renderChatList();
    renderCalls();

    const savedChat = state.activeChatId ? getChat(state.activeChatId) : null;
    if (savedChat && !window.matchMedia(MOBILE_QUERY).matches) {
      openChat(savedChat.id, true);
    } else {
      state.activeChatId = null;
      showWelcome();
    }
  }

  function renderMe() {
    if (!state) return;
    const avatar = $('#meAvatar');
    avatar.textContent = initials(state.user.name);
    avatar.style.cssText = avatarStyle(state.user.hue ?? hueFor(state.user.name));
    avatar.title = state.user.name;
  }

  function getChat(id) {
    return state?.chats.find((chat) => chat.id === id) || null;
  }

  function activeChat() {
    return state?.activeChatId ? getChat(state.activeChatId) : null;
  }

  const lastTs = (chat) =>
    chat.messages.length ? chat.messages[chat.messages.length - 1].ts : (chat.createdAt || 0);

  /* ---------------------------------------------------------
     Chat list
     --------------------------------------------------------- */

  function renderChatList() {
    if (!state) return;
    const list = $('#chatList');
    const query = ui.query.trim().toLowerCase();

    let chats = state.chats.slice().sort((a, b) => {
      const pinDiff = Number(b.pinned) - Number(a.pinned);
      return pinDiff || lastTs(b) - lastTs(a);
    });

    if (query) {
      chats = chats.filter((chat) =>
        chat.name.toLowerCase().includes(query) ||
        chat.messages.some((message) => message.text.toLowerCase().includes(query)));
    }

    if (!chats.length) {
      list.innerHTML = `
        <div class="empty-list">
          <svg class="icon"><use href="#i-${query ? 'search' : 'chat'}" /></svg>
          <span>${query ? 'Ничего не найдено' : 'Чатов пока нет.<br>Создайте первый чат.'}</span>
        </div>`;
    } else {
      list.innerHTML = chats.map(chatRowHTML).join('');
    }

    const unread = state.chats.reduce((sum, chat) => sum + (chat.unread || 0), 0);
    const badge = $('#totalUnread');
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = unread === 0;
    document.title = unread ? `(${unread > 99 ? '99+' : unread}) GOmetta` : 'GOmetta — мессенджер';
  }

  function chatRowHTML(chat) {
    const last = chat.messages[chat.messages.length - 1];
    let preview = 'Нет сообщений';
    if (chat.typing) {
      preview = 'печатает…';
    } else if (last) {
      const prefix = last.from === 'me'
        ? 'Вы: '
        : (chat.group && last.sender ? `${last.sender}: ` : '');
      preview = prefix + last.text.replace(/\s+/g, ' ');
    }

    return `
      <button class="chat-row ${state.activeChatId === chat.id ? 'active' : ''}" data-chat="${chat.id}">
        ${avatarHTML(chat.name, chat.hue)}
        <span class="chat-row-main">
          <span class="chat-row-top">
            <strong>${esc(chat.name)}</strong>
            <time>${last ? fmtListTime(last.ts) : ''}</time>
          </span>
          <span class="chat-row-bottom">
            <span class="preview ${chat.typing ? 'typing' : ''}">${esc(preview)}</span>
            ${chat.unread ? `<span class="unread">${chat.unread > 99 ? '99+' : chat.unread}</span>` : ''}
          </span>
        </span>
      </button>`;
  }

  /* ---------------------------------------------------------
     Tabs / calls
     --------------------------------------------------------- */

  function renderTabs() {
    $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === ui.tab));
    $('#chatList').hidden = ui.tab !== 'chats';
    $('#callsList').hidden = ui.tab !== 'calls';
    if (state) {
      const unread = state.chats.reduce((sum, chat) => sum + (chat.unread || 0), 0);
      const badge = $('#totalUnread');
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.hidden = unread === 0;
    }
  }

  function switchTab(tab) {
    ui.tab = tab === 'calls' ? 'calls' : 'chats';
    renderTabs();
    if (ui.tab === 'chats') renderChatList();
    else renderCalls();
  }

  function renderCalls() {
    if (!state) return;
    const list = $('#callsList');

    if (!state.calls.length) {
      list.innerHTML = `
        <div class="empty-list">
          <svg class="icon"><use href="#i-phone" /></svg>
          <span>Звонков пока нет.<br>Позвоните из любого чата — история появится здесь.</span>
        </div>`;
      return;
    }

    list.innerHTML = state.calls
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .map((call) => {
        const chat = getChat(call.chatId);
        const hue = chat ? chat.hue : hueFor(call.name);
        const outgoing = call.type === 'out';
        return `
          <button class="chat-row" data-call-chat="${call.chatId || ''}">
            ${avatarHTML(call.name, hue)}
            <span class="chat-row-main">
              <span class="chat-row-top">
                <strong>${esc(call.name)}</strong>
                <time>${fmtListTime(call.ts)}</time>
              </span>
              <span class="chat-row-bottom">
                <span class="preview">
                  <svg class="tick" style="vertical-align:-2px;opacity:.7"><use href="#i-arrow-${outgoing ? 'up-right' : 'down-left'}" /></svg>
                  ${outgoing ? 'Исходящий' : 'Входящий'} · ${call.media === 'video' ? 'видео' : 'аудио'} · ${fmtDuration(call.duration)}
                </span>
              </span>
            </span>
          </button>`;
      })
      .join('');
  }

  /* ---------------------------------------------------------
     Chat view
     --------------------------------------------------------- */

  function showWelcome() {
    $('#welcome').hidden = false;
    $('#chatView').hidden = true;
    $('#app').classList.remove('chat-open');
  }

  function openChat(id, silent = false) {
    const chat = getChat(id);
    if (!chat) return;

    const hadUnread = chat.unread > 0;
    state.activeChatId = id;
    chat.unread = 0;
    save();

    if (REMOTE && hadUnread) {
      api(`/api/chats/${id}/read`, { method: 'POST' }).catch(() => {});
    }

    $('#welcome').hidden = true;
    $('#chatView').hidden = false;
    $('#app').classList.add('chat-open');
    $('#chatMenu').hidden = true;

    renderTabs();
    renderChatList();
    renderChatHeader();
    renderMessages(true);

    if (!silent && !window.matchMedia(MOBILE_QUERY).matches) {
      $('#messageInput').focus();
    }
  }

  function closeChat() {
    if (!state) return;
    state.activeChatId = null;
    save();
    $('#chatMenu').hidden = true;
    showWelcome();
    renderChatList();
  }

  function renderChatHeader() {
    const chat = activeChat();
    if (!chat) return;

    const avatar = $('#chatAvatar');
    avatar.textContent = initials(chat.name);
    avatar.style.cssText = avatarStyle(chat.hue);
    $('#chatName').textContent = chat.name;

    const status = $('#chatStatus');
    if (chat.typing) {
      status.textContent = 'печатает…';
      status.classList.add('typing');
    } else {
      status.textContent = chat.group ? 'групповой чат' : 'в сети';
      status.classList.remove('typing');
    }
  }

  function renderMessages(scrollToBottom = false) {
    const chat = activeChat();
    if (!chat) return;

    const box = $('#messages');
    const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    let html = '';
    let lastDay = null;

    if (!chat.messages.length) {
      html = `
        <div class="chat-empty">
          <svg class="icon"><use href="#i-chat" /></svg>
          <span>Сообщений пока нет.<br>Напишите первым 👋</span>
        </div>`;
    } else {
      for (const message of chat.messages) {
        const day = startOfDay(message.ts);
        if (day !== lastDay) {
          html += `<div class="day"><span>${fmtDay(message.ts)}</span></div>`;
          lastDay = day;
        }
        html += messageHTML(message, chat);
      }
    }

    if (chat.typing) {
      html += `
        <div class="msg in">
          <div class="bubble typing-bubble" aria-label="Печатает">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
        </div>`;
    }

    box.innerHTML = html;
    if (scrollToBottom || wasNearBottom) {
      requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
    }
  }

  function messageHTML(message, chat) {
    const mine = message.from === 'me';
    const sender = chat.group && !mine && message.sender
      ? `<div class="sender">${esc(message.sender)}</div>`
      : '';
    const tick = mine
      ? `<svg class="tick ${message.status === 'read' ? 'read' : ''}"><use href="#i-${message.status === 'read' ? 'checks' : 'check'}" /></svg>`
      : '';

    return `
      <div class="msg ${mine ? 'out' : 'in'}" data-msg="${message.id}">
        <div class="bubble">
          ${sender}
          <div class="text">${linkify(esc(message.text))}</div>
          <div class="meta">
            <span>${fmtTime(message.ts)}</span>
            ${tick}
          </div>
        </div>
      </div>`;
  }

  function updateMessageStatus(chatId, messageId) {
    if (state.activeChatId !== chatId) return;
    const tick = document.querySelector(`[data-msg="${messageId}"] .tick`);
    if (!tick) return;
    tick.classList.add('read');
    tick.querySelector('use')?.setAttribute('href', '#i-checks');
  }

  async function sendMessage(text) {
    const chat = activeChat();
    const clean = text.trim();
    if (!chat || !clean) return;

    if (REMOTE) {
      const message = { id: uid('m'), from: 'me', text: clean, ts: Date.now(), status: 'sent' };
      chat.messages.push(message);
      chat.unread = 0;
      save();
      renderChatList();
      renderMessages(true);

      try {
        await api(`/api/chats/${chat.id}/messages`, {
          method: 'POST',
          body: { text: clean },
        });
        await refreshRemote();
      } catch (failure) {
        message.failed = true;
        save();
        renderMessages(false);
        toast(failure.message || 'Не удалось отправить сообщение');
      }
      return;
    }

    const message = { id: uid('m'), from: 'me', text: clean, ts: Date.now(), status: 'sent' };
    chat.messages.push(message);
    chat.unread = 0;
    save();

    renderChatList();
    renderMessages(true);

    setTimeout(() => {
      if (!state || !state.chats.includes(chat)) return;
      message.status = 'read';
      save();
      updateMessageStatus(chat.id, message.id);
    }, 1100);

    scheduleBotReply(chat);
  }

  function scheduleBotReply(chat) {
    if (!chat.demo || ui.typingTimers[chat.id]) return;

    chat.typing = true;
    save();
    renderChatList();
    if (state.activeChatId === chat.id) {
      renderChatHeader();
      renderMessages(true);
    }

    ui.typingTimers[chat.id] = setTimeout(() => {
      delete ui.typingTimers[chat.id];
      if (!state || !state.chats.includes(chat)) return;

      chat.typing = false;
      const pool = REPLY_POOLS[chat.id] || DEFAULT_REPLIES;
      const reply = {
        id: uid('m'),
        from: 'them',
        text: pick(pool),
        ts: Date.now(),
        status: 'read',
      };
      if (chat.group) reply.sender = pick(GROUP_SENDERS);
      chat.messages.push(reply);

      if (state.activeChatId !== chat.id) chat.unread = (chat.unread || 0) + 1;
      save();
      renderChatList();

      if (state.activeChatId === chat.id) {
        renderChatHeader();
        renderMessages(true);
      }
    }, 1200 + Math.random() * 1400);
  }

  function autoGrow(element) {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 140)}px`;
  }

  function handleSend(event) {
    event.preventDefault();
    const input = $('#messageInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    autoGrow(input);
    sendMessage(text);
  }

  async function clearChat() {
    const chat = activeChat();
    if (!chat) return;
    if (!window.confirm(`Очистить историю чата «${chat.name}»?`)) return;
    if (ui.typingTimers[chat.id]) {
      clearTimeout(ui.typingTimers[chat.id]);
      delete ui.typingTimers[chat.id];
    }
    chat.typing = false;

    if (REMOTE) {
      try {
        await api(`/api/chats/${chat.id}/clear`, { method: 'POST' });
        await refreshRemote();
        toast('История очищена');
      } catch (failure) {
        toast(failure.message || 'Не удалось очистить историю');
      }
      return;
    }

    chat.messages = [];
    chat.unread = 0;
    save();
    renderMessages(true);
    renderChatList();
    toast('История очищена');
  }

  async function deleteChat() {
    const chat = activeChat();
    if (!chat) return;
    if (!window.confirm(`Удалить чат «${chat.name}»? Это действие нельзя отменить.`)) return;

    if (ui.typingTimers[chat.id]) {
      clearTimeout(ui.typingTimers[chat.id]);
      delete ui.typingTimers[chat.id];
    }

    if (REMOTE) {
      try {
        await api(`/api/chats/${chat.id}`, { method: 'DELETE' });
        state.activeChatId = null;
        await refreshRemote();
        showWelcome();
        toast('Чат удалён');
      } catch (failure) {
        toast(failure.message || 'Не удалось удалить чат');
      }
      return;
    }

    state.chats = state.chats.filter((item) => item.id !== chat.id);
    state.calls = state.calls.filter((call) => call.chatId !== chat.id);
    state.activeChatId = null;
    save();
    showWelcome();
    renderChatList();
    renderCalls();
    toast('Чат удалён');
  }

  function toggleChatMenu() {
    const menu = $('#chatMenu');
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    const rect = $('#chatMenuBtn').getBoundingClientRect();
    menu.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 130)}px`;
    menu.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
    menu.hidden = false;
  }

  /* ---------------------------------------------------------
     Calls
     --------------------------------------------------------- */

  function startCall(media) {
    const chat = activeChat();
    if (!chat || ui.call) return;

    ui.call = {
      chatId: chat.id,
      media,
      connected: false,
      seconds: 0,
      timer: null,
    };

    const avatar = $('#callAvatar');
    avatar.textContent = initials(chat.name);
    avatar.style.cssText = avatarStyle(chat.hue);
    $('#callName').textContent = chat.name;
    $('#callStatus').textContent = 'Соединение…';
    $('#callMute').classList.remove('off');
    $('#callSpeaker').classList.remove('off');
    $('#callVideoToggle').classList.toggle('off', media !== 'video');
    $('#callOverlay').hidden = false;

    ui.call.connectTimer = setTimeout(() => {
      if (!ui.call) return;
      ui.call.connected = true;
      $('#callStatus').textContent = '00:00';
      ui.call.timer = setInterval(() => {
        if (!ui.call) return;
        ui.call.seconds += 1;
        $('#callStatus').textContent = fmtDuration(ui.call.seconds);
      }, 1000);
    }, 1500);
  }

  function endCall() {
    if (!ui.call) return;
    const { chatId, seconds, media, connected, timer, connectTimer } = ui.call;
    clearTimeout(connectTimer);
    clearInterval(timer);
    ui.call = null;
    $('#callOverlay').hidden = true;

    const chat = getChat(chatId);
    if (chat) {
      state.calls.unshift({
        id: uid('call'),
        chatId,
        name: chat.name,
        media,
        type: 'out',
        ts: Date.now(),
        duration: seconds,
      });
      save();
      renderCalls();
    }

    toast(connected ? `Звонок завершён · ${fmtDuration(seconds)}` : 'Звонок отменён');
  }

  function toggleCallControl(selector) {
    $(selector).classList.toggle('off');
  }

  /* ---------------------------------------------------------
     Settings
     --------------------------------------------------------- */

  function openSettings() {
    if (!state) return;
    const avatar = $('#settingsAvatar');
    avatar.textContent = initials(state.user.name);
    avatar.style.cssText = avatarStyle(state.user.hue ?? hueFor(state.user.name));
    $('#settingsNameLabel').textContent = state.user.name;
    $('#settingsPhoneLabel').textContent = formatPhoneDisplay(state.user.phone);
    $('#settingsName').value = state.user.name;
    $('#settingsUsername').value = state.user.username || '';
    $('#notifToggle').checked = state.settings.notifications !== false;
    syncThemeButtons();
    $('#settingsModal').hidden = false;
  }

  function closeModal(name) {
    if (name === 'settings') $('#settingsModal').hidden = true;
    if (name === 'newchat') $('#newChatModal').hidden = true;
  }

  async function saveSettings() {
    if (!state) return;
    const name = $('#settingsName').value.trim();
    const username = $('#settingsUsername').value.trim().replace(/^@+/, '');
    if (!name) {
      toast('Имя не может быть пустым');
      $('#settingsName').focus();
      return;
    }

    if (REMOTE) {
      const button = $('#saveSettingsBtn');
      button.disabled = true;
      try {
        const result = await api('/api/me', {
          method: 'PATCH',
          body: { name, username },
        });
        state.user.name = result.user.name;
        state.user.username = result.user.username;
        state.settings.notifications = $('#notifToggle').checked;
        save();
        renderMe();
        closeModal('settings');
        toast('Настройки сохранены');
        await refreshRemote();
      } catch (failure) {
        toast(failure.message || 'Не удалось сохранить настройки');
      } finally {
        button.disabled = false;
      }
      return;
    }

    state.user.name = name;
    state.user.username = username;
    state.settings.notifications = $('#notifToggle').checked;
    save();
    renderMe();
    closeModal('settings');
    toast('Настройки сохранены');
  }

  function setTheme(theme) {
    if (!state) {
      applyTheme(theme);
      return;
    }
    state.settings.theme = theme === 'light' ? 'light' : 'dark';
    save();
    applyTheme(state.settings.theme);
  }

  function logout() {
    if (!window.confirm('Выйти из аккаунта?')) return;

    if (REMOTE) {
      api('/api/logout', { method: 'POST' }).catch(() => {});
      stopSync();
      authToken = '';
      storeToken('');
      setSession(false);
      state = null;
      closeModal('settings');
      showWelcome();
      showAuth();
      toast('Вы вышли из аккаунта');
      return;
    }

    setSession(false);
    if (state) {
      state.activeChatId = null;
      save();
    }
    closeModal('settings');
    showWelcome();
    showAuth();
    toast('Вы вышли из аккаунта');
  }

  function resetData() {
    if (!window.confirm('Сбросить все данные? Чаты, настройки и аккаунт будут удалены.')) return;
    if (REMOTE && authToken) {
      api('/api/logout', { method: 'POST' }).catch(() => {});
    }
    stopSync();
    try {
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(TOKEN_KEY);
    } catch (error) {
      /* ignore */
    }
    state = null;
    authToken = '';
    window.location.reload();
  }

  /* ---------------------------------------------------------
     New chat
     --------------------------------------------------------- */

  function openNewChat() {
    $('#newChatName').value = '';
    $('#newChatPhone').value = '';
    $('#newChatError').hidden = true;
    $('#newChatModal').hidden = false;
    setTimeout(() => (REMOTE ? $('#newChatPhone') : $('#newChatName')).focus(), 80);
  }

  async function createChat() {
    if (!state) return;
    const name = $('#newChatName').value.trim();
    const phone = $('#newChatPhone').value.trim();
    const error = $('#newChatError');

    if (REMOTE) {
      if (!phone) {
        error.textContent = 'Введите номер друга, зарегистрированного в GOmetta.';
        error.hidden = false;
        $('#newChatPhone').focus();
        return;
      }

      error.hidden = true;
      const button = $('#createChatBtn');
      button.disabled = true;
      try {
        const result = await api('/api/chats', {
          method: 'POST',
          body: { phone: normalizePhoneInput(phone), name },
        });
        closeModal('newchat');
        await refreshRemote();
        ui.tab = 'chats';
        renderTabs();
        openChat(result.chat.id);
        toast('Чат создан');
      } catch (failure) {
        error.textContent = failure.message || 'Не удалось создать чат.';
        error.hidden = false;
      } finally {
        button.disabled = false;
      }
      return;
    }

    if (!name) {
      error.textContent = 'Введите имя или название чата.';
      error.hidden = false;
      $('#newChatName').focus();
      return;
    }

    error.hidden = true;
    const chat = {
      id: uid('chat'),
      name,
      phone,
      hue: hueFor(name + phone),
      demo: false,
      group: false,
      pinned: false,
      unread: 0,
      createdAt: Date.now(),
      messages: [],
    };

    state.chats.unshift(chat);
    save();
    closeModal('newchat');
    ui.tab = 'chats';
    renderTabs();
    renderChatList();
    openChat(chat.id);
    toast('Чат создан');
  }

  /* ---------------------------------------------------------
     Toast
     --------------------------------------------------------- */

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimer);
    requestAnimationFrame(() => element.classList.add('show'));
    toastTimer = setTimeout(() => {
      element.classList.remove('show');
      setTimeout(() => { element.hidden = true; }, 220);
    }, 2600);
  }

  /* ---------------------------------------------------------
     Events
     --------------------------------------------------------- */

  function bindEvents() {
    /* App */
    $('#openSettings').addEventListener('click', openSettings);
    $('#settingsFootBtn').addEventListener('click', openSettings);
    $('#themeToggle').addEventListener('click', () => {
      setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    });
    $('#newChatBtn').addEventListener('click', openNewChat);
    $('#newChatWelcome').addEventListener('click', openNewChat);

    $('#searchInput').addEventListener('input', (event) => {
      ui.query = event.target.value;
      if (ui.tab !== 'chats') {
        ui.tab = 'chats';
        renderTabs();
      }
      renderChatList();
    });

    $('#chatList').addEventListener('click', (event) => {
      const row = event.target.closest('[data-chat]');
      if (row) openChat(row.dataset.chat);
    });

    $('#callsList').addEventListener('click', (event) => {
      const row = event.target.closest('[data-call-chat]');
      if (row && row.dataset.callChat) openChat(row.dataset.callChat);
    });

    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    $('#backBtn').addEventListener('click', closeChat);
    $('#callAudio').addEventListener('click', () => startCall('audio'));
    $('#callVideo').addEventListener('click', () => startCall('video'));

    $('#chatMenuBtn').addEventListener('click', (event) => {
      event.stopPropagation();
      toggleChatMenu();
    });

    $('#chatMenu').addEventListener('click', (event) => {
      const button = event.target.closest('[data-menu]');
      if (!button) return;
      $('#chatMenu').hidden = true;
      if (button.dataset.menu === 'clear') clearChat();
      if (button.dataset.menu === 'delete') deleteChat();
    });

    $('#composer').addEventListener('submit', handleSend);
    $('#messageInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        handleSend(event);
      }
    });
    $('#messageInput').addEventListener('input', (event) => autoGrow(event.target));
    $('#attachBtn').addEventListener('click', () => toast('Вложения появятся в следующей версии'));

    /* Settings */
    $$('[data-close]').forEach((button) => {
      button.addEventListener('click', () => closeModal(button.dataset.close));
    });
    $('#saveSettingsBtn').addEventListener('click', saveSettings);
    $('#logoutBtn').addEventListener('click', logout);
    $('#resetBtn').addEventListener('click', resetData);
    $('#themeSwitch').addEventListener('click', (event) => {
      const button = event.target.closest('[data-theme-value]');
      if (button) setTheme(button.dataset.themeValue);
    });
    $('#notifToggle').addEventListener('change', (event) => {
      if (!state) return;
      state.settings.notifications = event.target.checked;
      save();
    });

    /* New chat */
    $('#createChatBtn').addEventListener('click', createChat);
    $('#newChatName').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') createChat();
    });

    /* Call */
    $('#callEnd').addEventListener('click', endCall);
    $('#callMute').addEventListener('click', () => toggleCallControl('#callMute'));
    $('#callSpeaker').addEventListener('click', () => toggleCallControl('#callSpeaker'));
    $('#callVideoToggle').addEventListener('click', () => toggleCallControl('#callVideoToggle'));

    /* Global */
    document.addEventListener('click', (event) => {
      if (!event.target.closest('#chatMenu') && !event.target.closest('#chatMenuBtn')) {
        $('#chatMenu').hidden = true;
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (ui.call) { endCall(); return; }
      if (!$('#chatMenu').hidden) { $('#chatMenu').hidden = true; return; }
      if (!$('#settingsModal').hidden) { closeModal('settings'); return; }
      if (!$('#newChatModal').hidden) { closeModal('newchat'); return; }
      if ($('#app').classList.contains('chat-open') && window.matchMedia(MOBILE_QUERY).matches) {
        closeChat();
      }
    });

    window.addEventListener('resize', () => {
      $('#chatMenu').hidden = true;
    });
  }

  /* ---------------------------------------------------------
     Service worker (PWA, только http/https)
     --------------------------------------------------------- */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        /* офлайн-режим необязателен */
      });
    });
  }

  /* ---------------------------------------------------------
     Init
     --------------------------------------------------------- */

  async function loadConfig() {
    if (!REMOTE) return;
    try {
      const cfg = await api('/api/config');
      if (cfg.bot) botUsername = String(cfg.bot).replace(/^@/, '');
      refreshTelegramLink();
    } catch (err) {
      /* сервер может быть недоступен — ссылка останется из config.js */
    }
  }

  function init() {
    bindEvents();
    initTelegram();
    applyTheme(state?.settings?.theme || document.documentElement.dataset.theme || 'dark');

    if (REMOTE) {
      authToken = loadToken();
      $('#authFootText').textContent = 'GOmetta · вход только через Telegram';
      $('#newChatHint').textContent = 'Введите номер друга, который уже зарегистрирован в GOmetta. Можно без +7.';
      showAuth();
      loadConfig();
      if (authToken) {
        loadRemote(true).catch((failure) => {
          if (failure?.status === 401) return;
          toast('Сервер недоступен. Проверьте подключение.');
        });
      }
    } else {
      $('#authFootText').textContent = 'GOmetta · демо · нужен сервер и Telegram';
      $('#tgHint').textContent = 'Демо-режим без сервера. Для входа подключите backend и Telegram-бота (см. README).';
      $('#newChatHint').textContent = 'Демо: чат хранится только в этом браузере.';
      if (state && state.user && hasSession()) {
        enterApp();
      } else {
        showAuth();
      }
    }

    registerServiceWorker();
  }

  loadTelegramSdk(() => {
    detectTelegram();
    init();
  });
})();
