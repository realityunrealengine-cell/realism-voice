# Realism Voice

Десктопный мессенджер для Windows: серверы, текстовые и голосовые каналы, личные сообщения, друзья, видеозвонки и демонстрация экрана.

**Стек:** Electron 37 · React 18 + TypeScript · Vite 6 · Tailwind CSS · Zustand · Framer Motion · Lucide ·
Supabase (Auth, PostgreSQL + RLS, Realtime, Storage, Edge Functions) · LiveKit (WebRTC SFU) · electron-builder + NSIS.

Всё работает через облако: ваш компьютер не нужно держать включённым, друзья подключаются из любой страны.

---

## 1. Быстрый старт (разработка)

```bash
npm install
npm run dev          # Vite + Electron с горячей перезагрузкой
```

`.env.local` уже содержит URL и publishable key вашего проекта Supabase. Образец — `.env.example`.

| Команда | Что делает |
|---|---|
| `npm run typecheck` | Проверка TypeScript (renderer + main/preload) |
| `npm run test:sql` | Прогон миграций и 70+ проверок RLS на встроенном PostgreSQL (PGlite) |
| `npm run build` | typecheck + сборка main/preload + сборка интерфейса |
| `npm run dist` | Сборка установщика `release/RealismVoice-Setup.exe` |
| `npm run icons` | Перегенерировать иконки в `build/` |
| `npm run sql:bundle` | Пересобрать `supabase/setup.sql` из миграций |
| `npm run test:updater` | Проверка обновлений без окон: сбои сети, повреждённый файл, звонок, реальная установка тестовых версий |
| `npm run update-test:build` | Сборка отдельного тестового приложения 1.0.3 и 1.0.4 в `release-test/` |
| `npm run update-test:serve` | Локальный сервер, раздающий тестовую 1.0.4 |

---

## 2. Настройка Supabase (обязательно, один раз)

### 2.1. База данных — миграции

**Вариант А (проще): SQL Editor**
1. Откройте <https://supabase.com/dashboard/project/yqoxdrkxgnputpqsclzx/sql/new>.
2. Вставьте **всё** содержимое файла `supabase/setup.sql` и нажмите **Run**.
3. Скрипт идемпотентен — повторный запуск безопасен и не удаляет данные.

**Вариант Б: Supabase CLI**
```bash
npx supabase login
npx supabase link --project-ref yqoxdrkxgnputpqsclzx
npx supabase db push
```
(`link` спросит пароль базы данных — вводите его сами в терминале.)

Миграции создают: таблицы, индексы, ограничения, триггеры, RPC-функции, RLS-политики,
Storage-бакеты `avatars`, `server-icons`, `attachments` с политиками, публикацию Realtime и политики Realtime Authorization.

### 2.2. Аутентификация — ссылки из писем

Authentication → **URL Configuration** → **Redirect URLs** → добавьте:
```
realismvoice://auth/callback
realismvoice://auth/reset
```
После этого ссылки «Подтвердить email» и «Сбросить пароль» из писем будут открывать Realism Voice.

Рекомендуется:
- **Authentication → Emails → SMTP Settings** — подключите свой SMTP. Встроенная почта Supabase отправляет лишь несколько писем в час и годится только для тестов.
- (необязательно) В шаблоны писем «Confirm signup» и «Reset password» добавьте `{{ .Token }}` — тогда в письме будет код, который можно ввести прямо в приложении, без перехода по ссылке.

### 2.3. Edge Function `livekit-token`

**Через Dashboard:** Edge Functions → **Deploy a new function** → «Via Editor» → имя `livekit-token` →
вставьте содержимое `supabase/functions/livekit-token/index.ts` → Deploy.
Затем в настройках функции **выключите «Verify JWT with legacy secret»** — функция сама проверяет пользователя через `auth.getUser()` (это работает и с новыми ключами подписи JWT).

**Через CLI:**
```bash
npx supabase functions deploy livekit-token --no-verify-jwt --project-ref yqoxdrkxgnputpqsclzx
```

---

## 3. Настройка LiveKit (голос, видео, экран)

1. Зарегистрируйтесь на <https://cloud.livekit.io> и создайте проект (бесплатного тарифа достаточно для старта).
2. **Settings → API Keys → Create key**. Скопируйте:
   - **URL** вида `wss://ваш-проект.livekit.cloud`
   - **API Key**
   - **API Secret** (показывается один раз)
3. Supabase Dashboard → **Edge Functions → Secrets** (Manage secrets) → добавьте:
   ```
   LIVEKIT_URL=wss://ваш-проект.livekit.cloud
   LIVEKIT_API_KEY=APIxxxxxxxx
   LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxx
   ```
   или через CLI:
   ```bash
   npx supabase secrets set LIVEKIT_URL=wss://... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... --project-ref yqoxdrkxgnputpqsclzx
   ```

Секреты LiveKit **никогда** не попадают в приложение: ни в renderer, ни в preload, ни в переменные Vite.
Пока секреты не заданы, приложение честно показывает «Голосовой сервер LiveKit не настроен», а не имитирует связь.

Можно использовать и self-hosted LiveKit — укажите его `wss://` адрес в `LIVEKIT_URL`.

---

## 4. Сборка установщика Windows

```bash
npm run dist
```
Результат: `release/RealismVoice-Setup.exe` (Windows 10/11 x64). Установщик NSIS: выбор папки, ярлыки на рабочем столе и в меню «Пуск»,
корректное удаление через «Приложения и возможности». Node.js у пользователя не нужен.

Установщик не подписан цифровой подписью, поэтому Windows SmartScreen при первом запуске покажет предупреждение —
«Подробнее» → «Выполнить в любом случае». Для распространения без предупреждения нужен сертификат подписи кода.

Workflow `.github/workflows/build-windows.yml` собирает установщик без публикации (запускается вручную).

---

## 4а. Автообновления

Приложение проверяет `latest.yml` в GitHub Releases через 30 секунд после запуска, каждые 4 часа и по кнопке в
**Настройки → Обновления**, скачивает новую версию в фоне и предлагает перезапуск. Во время звонка, демонстрации экрана
или входящего вызова перезапуск недоступен; после звонка появляется предложение «Обновить и перезапустить / Позже».
Выход из приложения и выключение Windows ничего не устанавливают (`autoInstallOnAppQuit = false`).
Журнал: `%APPDATA%\Realism Voice\logs\updater.log`.

Версия 1.0.2 не умеет обновляться сама: версию 1.0.3 нужно один раз поставить вручную поверх старой.
Данные сохраняются, потому что `appId` и папка `%APPDATA%\Realism Voice` не меняются.

### Настройка (один раз)

Исходники: закрытый репозиторий `realityunrealengine-cell/realism-voice` (`origin`).
Обновления: публичный `realityunrealengine-cell/realism-voice-releases`, только установщики и `latest.yml`; приложение читает их без токена.
Исходный код в публичный репозиторий не отправляется.

1. Включите двухфакторную защиту GitHub.
2. Создайте Fine-grained token (**Settings → Developer settings → Personal access tokens**): доступ только к
   `realism-voice-releases`, **Repository permissions → Contents: Read and write**, срок до года.
3. В репозитории исходников, **Settings → Secrets and variables → Actions**:
   - Secrets: `RELEASES_GH_TOKEN` — токен из шага 2;
   - Variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, при необходимости `VITE_ENABLE_GOOGLE_AUTH`;
   - подпись: Secrets `CSC_LINK` и `CSC_KEY_PASSWORD` **или**, осознанно и до покупки сертификата, Variable `ALLOW_UNSIGNED_UPDATES=true`.

   Без токена, переменных Supabase и решения о подписи `release.yml` остановится до начала сборки.

### Выпуск версии

1. Опишите изменения в `build/release-notes.md`; в файле должен быть номер новой версии.
2. Закоммитьте их и поднимите версию, а затем отправьте тег:
   ```bash
   git add build/release-notes.md
   git commit -m "Описание версии"
   npm version patch
   git push --follow-tags
   ```
3. Workflow `.github/workflows/release.yml` проверит версию, TypeScript и RLS, соберёт установщик, загрузит
   `RealismVoice-Setup.exe`, `.blockmap` и `latest.yml` в черновик релиза, сверит SHA-512 и опубликует релиз.
   Пока идёт загрузка, пользователи обновление не видят.

Постоянная ссылка для новых пользователей:
`https://github.com/realityunrealengine-cell/realism-voice-releases/releases/latest/download/RealismVoice-Setup.exe`.

Выпуск с ошибкой: снимите его с публикации или удалите в GitHub. Загруженную версию приложение больше не предложит,
но у тех, кто уже обновился, она останется: выпустите исправление с более высоким номером.

### Проверка на своём ПК

Тестовое приложение «Realism Voice Update Test» ставится отдельно и не затрагивает рабочую версию:

```bash
npm run update-test:build
```
```bash
npm run update-test:serve
```

Установите `release-test/1.0.3/RealismVoice-UpdateTest-1.0.3-Setup.exe`, войдите и измените настройки. Примерно через 30 секунд
начнётся загрузка 1.0.4. Проверьте звонок, перезапуск и сохранность данных, затем удалите приложение через «Приложения и возможности».

### Подпись и безопасность

- Токены GitHub, ключи Supabase service_role и секреты LiveKit в приложение не попадают; `check-release.mjs post` проверяет `app-update.yml`.
- Сертификат для работы механизма не обязателен. Но без него electron-updater проверяет только SHA-512 из `latest.yml`,
  а оба файла лежат в одном релизе. Это защищает от повреждения при передаче, но не от злоумышленника с доступом к GitHub.
- Поэтому релиз без сертификата собирается только при явной переменной `ALLOW_UNSIGNED_UPDATES=true`.
- С сертификатом electron-builder запишет издателя в `app-update.yml`, и приложение начнёт отклонять обновления с чужой подписью.
  Установленные неподписанные версии примут первое подписанное обновление, проверку получат уже следующие.
  Издатель (`CN`) должен оставаться прежним: при смене имени выпустите промежуточную версию с обоими именами в `win.signtoolOptions.publisherName`.
- Варианты: Azure Artifact Signing (`win.azureSignOptions`) или OV/EV-сертификат. Для аппаратного токена нужен собственный runner или облачный HSM.
- Защитите канал: двухфакторная защита GitHub, токен только на один репозиторий, защита тегов `v*` (**Settings → Rules → Rulesets**),
  Environment с обязательным подтверждением для release.yml.

---

## 5. Вход через Google (подготовлено)

1. Google Cloud Console → OAuth Client ID (Web application), redirect URI: `https://yqoxdrkxgnputpqsclzx.supabase.co/auth/v1/callback`.
2. Supabase → Authentication → Providers → Google → включить, вставить Client ID/Secret.
3. В `.env.local` установить `VITE_ENABLE_GOOGLE_AUTH=true` и пересобрать.

Вход открывается в системном браузере (PKCE) и возвращается в приложение через `realismvoice://auth/callback`.
Для пользователей Google username генерируется автоматически и меняется в настройках.

---

## 6. Архитектура и безопасность

```
electron/        main-процесс, preload, шифрованное хранилище сессии, PTT, настройки
src/             интерфейс (React), stores (Zustand), lib (Supabase, Realtime, LiveKit-шлюз)
supabase/        migrations/*.sql, setup.sql, functions/livekit-token
scripts/         генерация иконок, склейка SQL, тест RLS
```

**Electron:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; узкий preload API; каждый IPC-вызов проверяет,
что он пришёл из главного фрейма приложения; строгий CSP (`script-src 'self'`); приложение загружается через собственный
протокол `app://rv` (не `file://`); внешние ссылки — только http(s) в системном браузере; навигация и новые окна запрещены;
разрешения (микрофон, камера, экран, уведомления) выдаются только своему origin.

**Сессия:** токены Supabase шифруются через `safeStorage` (Windows DPAPI) в main-процессе и не лежат в `localStorage`.

**База данных:** все права проверяются в PostgreSQL:
- чужие ЛС недоступны (RLS по участникам переписки; вложения ЛС — в приватном бакете, по подписанным ссылкам);
- значок Owner (`profiles.badge`) привязан к аккаунту и меняется только через SQL Editor или service_role, клиенту колонка недоступна;
- роли меняются только через `set_member_role` с проверкой старшинства — прямых UPDATE/INSERT для участников нет;
- редактирование только своих сообщений (`edit_message`), удаление — автор или модератор старше автора;
- приватные каналы: чтение/запись/вложения/голос — только по роли или явному списку участников;
- антиспам: лимиты на сообщения (8 за 10 с, 120 за 5 мин), приглашения (20/час), заявки в друзья (30/час),
  новые переписки (30/час), серверы (10/сутки), медленный режим каналов;
- Realtime: postgres_changes фильтруются RLS, приватные каналы набора текста / presence — политиками `realtime.messages`.

**Голос:** Edge Function проверяет JWT, членство на сервере, доступ к приватному каналу, право говорить и лимит участников —
и только после этого выдаёт LiveKit-токен на конкретную комнату.

---

## 7. Известные ограничения

- Звук при демонстрации экрана — это весь системный звук Windows (Chromium не умеет захватывать звук отдельного окна).
- Глобальный Push-to-Talk использует нативный модуль `uiohook-napi`; перехват клавиш включается только во время голосового подключения в режиме PTT. Если модуль недоступен, PTT работает при активном окне.
- Звонки в ЛС — один на один. Групповые ЛС не реализованы.
- Автообновление начинает работать после настройки репозитория релизов (раздел 4а); пока он не указан, приложение честно показывает, что канал не настроен.
- Удаление аккаунта требует серверных полномочий и пока не реализовано в интерфейсе.
