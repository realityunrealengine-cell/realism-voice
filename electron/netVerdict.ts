// Определение причины «Нет соединения с сервером» по результатам диагностики (общий код main и интерфейса).
// Чистая функция без зависимостей — покрыта тестами.

export interface NetFacts {
  /** Открываются ли сторонние сайты (Google, Cloudflare) напрямую */
  internetOk: boolean;
  /** DNS нашёл адрес сервера */
  dnsOk: boolean;
  dnsCode: string | null;
  /** Защищённое соединение с сервером (напрямую, без прокси) */
  tlsOk: boolean;
  tlsCode: string | null;
  /** Ответ сервера на прямой запрос (null — запрос не прошёл) */
  httpStatus: number | null;
  /** Запрос через сетевой стек приложения (Chromium, с системным прокси) — именно так работает Realism Voice */
  appOk: boolean;
  appError: string | null;
  /** Системный прокси для адреса сервера ('DIRECT' — без прокси) */
  proxy: string | null;
  /** WebSocket Realtime (null — не проверялся) */
  wsOk: boolean | null;
  /** Разница часов компьютера и сервера, секунды (+ — часы компьютера спешат) */
  clockSkewSec: number | null;
}

export type NetVerdict = 'ok' | 'offline' | 'clock' | 'tls-intercept' | 'dns' | 'blocked' | 'proxy' | 'websocket' | 'server' | 'unknown';

const CLOCK_CODES = new Set(['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED']);
const INTERCEPT_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENODATA', 'ESERVFAIL', 'EREFUSED']);
/** Пять минут: больше — проверка сертификатов и токенов начинает ломаться */
export const CLOCK_SKEW_LIMIT_SEC = 300;

export function netVerdict(f: NetFacts): NetVerdict {
  if (f.clockSkewSec !== null && Math.abs(f.clockSkewSec) > CLOCK_SKEW_LIMIT_SEC) return 'clock';
  if (f.tlsCode && CLOCK_CODES.has(f.tlsCode)) return 'clock';
  if (f.appOk) {
    // Приложение до сервера достаёт; не работает только WebSocket — сообщения и статусы не обновляются
    if (f.wsOk === false) return 'websocket';
    if (f.httpStatus !== null && f.httpStatus >= 500) return 'server';
    return 'ok';
  }
  // Дальше — приложение до сервера не достало
  if (f.httpStatus !== null && f.httpStatus >= 500) return 'server';
  if (f.httpStatus !== null) {
    // Напрямую сервер отвечает, а через сетевой стек приложения — нет: прокси или фильтрация
    return f.proxy && f.proxy !== 'DIRECT' ? 'proxy' : 'tls-intercept';
  }
  if (!f.internetOk && !f.dnsOk && !f.tlsOk) return 'offline';
  if (f.tlsCode && INTERCEPT_CODES.has(f.tlsCode)) return 'tls-intercept';
  if (!f.dnsOk && f.dnsCode && DNS_CODES.has(f.dnsCode)) return f.internetOk ? 'dns' : 'offline';
  if (!f.internetOk) return 'offline';
  if (!f.tlsOk) return 'blocked';
  return 'unknown';
}

export interface VerdictText {
  title: string;
  explain: string;
  steps: string[];
  severity: 'ok' | 'warn' | 'bad';
}

export function verdictText(v: NetVerdict, f: NetFacts): VerdictText {
  switch (v) {
    case 'ok':
      return {
        severity: 'ok',
        title: 'Соединение с сервером в порядке',
        explain: 'Сейчас сервер Realism Voice доступен. Если ошибка была раньше — скорее всего, это был кратковременный обрыв сети.',
        steps: ['Если ошибка повторяется, запустите диагностику в момент ошибки и отправьте отчёт разработчику.'],
      };
    case 'offline':
      return {
        severity: 'bad',
        title: 'Нет подключения к интернету',
        explain: 'Компьютер не может открыть ни сервер Realism Voice, ни другие сайты.',
        steps: ['Проверьте Wi-Fi или кабель.', 'Перезагрузите роутер.', 'Если интернет в браузере работает — отключите VPN или прокси и попробуйте снова.'],
      };
    case 'clock': {
      const min = f.clockSkewSec !== null ? Math.round(Math.abs(f.clockSkewSec) / 60) : null;
      return {
        severity: 'bad',
        title: 'Неверное время на компьютере',
        explain: `Часы Windows ${min !== null ? `отличаются от точного времени примерно на ${min} мин` : 'показывают неверное время'}. Из-за этого не проходит проверка защищённого соединения и входа.`,
        steps: [
          'Откройте «Параметры» → «Время и язык» → «Дата и время».',
          'Включите «Установить время автоматически» и нажмите «Синхронизировать».',
          'Проверьте часовой пояс и перезапустите Realism Voice.',
        ],
      };
    }
    case 'tls-intercept':
      return {
        severity: 'bad',
        title: 'Защищённое соединение перехватывается',
        explain: 'Сервер отвечает, но антивирус, фильтр или прокси на компьютере подменяет защищённое (HTTPS) соединение, и приложение ему не доверяет.',
        steps: [
          'В антивирусе (Kaspersky, ESET, Avast, Dr.Web и др.) отключите «Проверку защищённых соединений» / «HTTPS-сканирование» или добавьте Realism Voice в исключения.',
          'Отключите программы-фильтры трафика и родительский контроль.',
          'Если компьютер рабочий — сеть может фильтроваться организацией; попробуйте другую сеть.',
        ],
      };
    case 'dns':
      return {
        severity: 'bad',
        title: 'DNS не находит сервер',
        explain: 'Интернет работает, но DNS-сервер провайдера не отдаёт адрес сервера Realism Voice. Так бывает при блокировке на уровне провайдера или сбое DNS.',
        steps: [
          'Смените DNS на 1.1.1.1 и 1.0.0.1 (Cloudflare) или 8.8.8.8 (Google): «Параметры» → «Сеть и Интернет» → свойства подключения → «Назначение DNS-сервера».',
          'Или попробуйте другую сеть (например, мобильный интернет).',
        ],
      };
    case 'blocked':
      return {
        severity: 'bad',
        title: 'Сервер недоступен из вашей сети',
        explain: `Интернет работает и адрес сервера найден, но соединение с ним ${f.tlsCode ? `обрывается (${f.tlsCode})` : 'не устанавливается'}. Скорее всего, доступ ограничивает провайдер, роутер или фаервол.`,
        steps: [
          'Попробуйте другую сеть — например, раздайте мобильный интернет с телефона.',
          'Проверьте, не блокирует ли Realism Voice брандмауэр Windows или антивирус.',
          'Если в другой сети всё работает — отправьте отчёт разработчику: возможна блокировка у провайдера.',
        ],
      };
    case 'proxy':
      return {
        severity: 'bad',
        title: 'Мешает прокси-сервер',
        explain: `Напрямую сервер доступен, но в Windows настроен прокси (${f.proxy}), через который соединение не проходит.`,
        steps: ['Откройте «Параметры» → «Сеть и Интернет» → «Прокси» и отключите прокси-сервер (или исправьте его настройки).', 'Перезапустите Realism Voice.'],
      };
    case 'websocket':
      return {
        severity: 'warn',
        title: 'Заблокирована мгновенная синхронизация',
        explain: 'Сервер доступен, но постоянное соединение (WebSocket) не устанавливается. Сообщения и статусы будут обновляться с задержкой.',
        steps: [
          'Проверьте антивирус и фаервол: разрешите Realism Voice сетевые подключения.',
          'Отключите VPN или прокси, если они включены.',
          'Попробуйте другую сеть.',
        ],
      };
    case 'server':
      return {
        severity: 'warn',
        title: 'Проблема на стороне сервера',
        explain: `Сервер Realism Voice отвечает ошибкой (${f.httpStatus}). С вашим интернетом всё в порядке.`,
        steps: ['Подождите несколько минут и попробуйте снова.'],
      };
    default:
      return {
        severity: 'warn',
        title: 'Причину определить не удалось',
        explain: 'Проверки дали противоречивый результат.',
        steps: ['Перезапустите Realism Voice и роутер.', 'Нажмите «Скопировать отчёт» и отправьте его разработчику.'],
      };
  }
}
