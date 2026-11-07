/* Адрес backend GOmetta.
 *
 * Если сайт открыт с GitHub Pages, backend живёт отдельно — укажите его URL:
 *   window.GOMETTA_API = 'https://ваш-сервис.onrender.com';
 *
 * Если сайт и сервер на одном домене (локально или на Render), оставьте
 * автоопределение: API = текущий origin.
 *
 * Пустая строка = демо-режим без сервера (вход только через Telegram
 * на рабочем сервере).
 *
 * Имя Telegram-бота можно задать здесь для GitHub Pages, но надёжнее —
 * переменная GOMETTA_BOT на сервере: сайт сам спросит её через /api/config.
 */
(function () {
  if (typeof window.GOMETTA_API !== 'string') {
    var host = location.hostname;
    var isStaticHost = location.protocol === 'file:' || /\.github\.io$/i.test(host);
    window.GOMETTA_API = isStaticHost ? '' : location.origin;
  }
  if (typeof window.GOMETTA_BOT !== 'string') {
    window.GOMETTA_BOT = '';
  }
})();
