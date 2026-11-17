[English](README.md) | [Русский](README.ru.md)

# figma-to-manifest

CLI-утилита на **Node.js / TypeScript**, которая преобразует сырой JSON-экспорт из Figma (`raw.json`, полученный через плагин `air-ds-manifest-exporter`) в компактное промежуточное представление `skeleton-page/` (`manifest.json` + `chunks/`), оптимизированное для LLM-агентов, с заменой переменных Figma на семантические токены `--lib-*`.

**Ключевой результат:** сжимает объём передаваемого контекста в **~10 раз** (например, с ~400 KB до ~40 KB), предотвращает галлюцинации ИИ при генерации вёрстки и привязывает макет к реальным компонентам дизайн-системы.

## Установка

```bash
npm install --save-dev figma-to-manifest
```

Для локального тестирования (из собранного архива до публикации в реестр):

```bash
# В репозитории figma-to-manifest
npm pack

# В целевом проекте
npm install <path-to>/figma-to-manifest-0.1.0.tgz
```

## Использование

```bash
figma-to-manifest raw.json
# → создаёт ./skeleton-page/manifest.json (и ./skeleton-page/chunks/*.json при превышении порога)

figma-to-manifest raw.json --out=custom/path/manifest.json
# → создаёт ./custom/path/manifest.json
```

### Параметры CLI

| Опция | Описание |
|---|---|
| `--map=<path>` | Явный путь к карте токенов `figma-tokens-map.yaml`. |
| `--code-map=<path>` | Явный путь к карте компонентов `figma-to-code.map.yaml`. |
| `--out=<path>` | Путь для выходного манифеста (по умолчанию `skeleton-page/manifest.json`). |
| `--threshold=<bytes>` | Порог размера в байтах для нарезки на чанки (по умолчанию `20480` — 20 KB). |
| `--quiet` | Отключить вывод прогресса и статистики. |
| `-h`, `--help` | Показать справку. |

## Как утилита находит YAML-карты

### `figma-tokens-map.yaml` (переменные Figma → `--lib-*`)

1. Аргумент CLI `--map=<path>`.
2. Переменная окружения `FIGMA_TOKENS_MAP`.
3. Экспорт внутри установленного npm-пакета дизайн-системы (через поле `exports`).
4. Файл `./figma-tokens-map.yaml` в текущей рабочей директории.

### `figma-to-code.map.yaml` (компоненты Figma → Angular-сниппеты)

1. Аргумент CLI `--code-map=<path>`.
2. Переменная окружения `FIGMA_TO_CODE_MAP`.
3. Экспорт внутри установленного npm-пакета дизайн-системы (через поле `exports`).
4. Файл `./figma-to-code.map.yaml` в текущей рабочей директории.

Если карта не найдена, утилита завершается с ошибкой и выводит список проверенных путей.

## Что делает утилита

Для каждого узла в дереве макета:

- Копирует структурные поля: `name`, `type`, `mainComponent`, `text`, `font`, `layout`, `size`, `fills`, `strokes`, `children`.
- Для каждой записи в `boundVariables` отрезает суффикс коллекции (`[Collection]`) и ищет имя в `figma-tokens-map.yaml`:
  - **Найдено** → заменяет на токен `--lib-*`.
  - **Не найдено** → помечает префиксом `UNMAPPED: ` и передаёт как есть.
- Отбрасывает нулевой шум `paragraphspacing/*` и `paragraphindent/*`.
- Для узлов, найденных в `figma-to-code.map.yaml`, заменяет всё поддерево детей на `$snippet` и `$inputs`.
- Резолвит иконки: убирает префикс семейства (например, `Arrows/chevron-right` → `chevron-right`) и применяет маппинг `icons` из `figma-to-code.map.yaml`.
- Удаляет `null`/`undefined` поля из `$inputs` (никаких пустых привязок).
- Дедуплицирует повторяющиеся несмапленные компоненты (`$total`).
- Нарезает манифест на чанки, если его размер превышает порог (20 KB по умолчанию).

## Структура выходных данных

```text
skeleton-page/
  manifest.json       # корневой скелет экрана с плейсхолдерами CHUNK_REF
  chunks/
    <name>-chunk-1.json
    <name>-chunk-2.json
```

- Если итоговый манифест меньше порога, папка `chunks/` не создаётся.
- Поле `manifest.chunks[]` содержит список всех чанков с полями `file`, `name` и `reason`.

## Как LLM-агент обрабатывает `UNMAPPED`

LLM-агент (например, Cline, Cursor, Claude Code) обрабатывает записи `UNMAPPED: <name>` согласно системным правилам генерации проекта (например, `.clinerules`, `.cursorrules` или `CLAUDE.md`):

1. Пытается подобрать подходящий токен `--lib-*` через **Tokens MCP** (`search_tokens`).
2. Если токен найден — применяет его и оставляет комментарий `// AUTONOMY(token-missing): <name> — matched <token>`.
3. Если подходящего токена нет — использует локальную CSS-переменную с пометкой `TODO`.
4. Записывает предупреждение в `warnings.json`.

Сам трансформер намеренно не пытается угадывать значения `UNMAPPED` — эта задача делегирована LLM-агенту.

## Формат `raw.json`

На вход ожидается JSON, сформированный плагином Figma `air-ds-manifest-exporter`. Структура представляет собой дерево узлов Figma со следующими полями:

- `name`, `type`
- `mainComponent` (для узлов `INSTANCE`)
- `componentProps` (`BOOLEAN`, `TEXT`, `VARIANT`, `INSTANCE_SWAP`)
- `text`, `font` (для узлов `TEXT`)
- `layout`, `size`, `position`
- `fills`, `strokes`
- `boundVariables` — карта `property → "variable-name [Collection]"`
- `children` — вложенные узлы

## Формат `manifest.json`

```json
{
  "screen": {
    "name": "Catalog Home",
    "type": "FRAME"
  },
  "root": {
    "name": "Catalog Home",
    "type": "FRAME",
    "layout": { ... },
    "tokens": {
      "fills.0": "--lib-background-color-screen-base"
    },
    "children": [ ... ]
  },
  "chunks": [
    {
      "file": "block-filter-section-chunk-1.json",
      "name": "Block_filter section",
      "reason": "size"
    }
  ]
}
```

## Пример преобразования

**Вход (`raw.json`, фрагмент):**

```json
{
  "name": "XText",
  "type": "TEXT",
  "text": "HA",
  "font": { "size": 12, "family": "DM Sans", "style": "SemiBold" },
  "boundVariables": {
    "fills.0": "color/global/neutral/text/accent [Themes]",
    "fontSize.0": "typography/fontsize/xs [Primitives]",
    "fontWeight.0": "typography/font weight/semibold [Primitives]"
  }
}
```

**Выход (`manifest.json`, фрагмент):**

```json
{
  "name": "XText",
  "type": "TEXT",
  "text": "HA",
  "font": { "size": 12, "family": "DM Sans", "style": "SemiBold" },
  "tokens": {
    "fills.0": "--lib-text-color-neutral-accent",
    "fontSize.0": "--lib-font-size-xs",
    "fontWeight.0": "UNMAPPED: typography/font weight/semibold"
  }
}
```

## Зависимости

- **Node.js** ≥ 20.19.0
- **`js-yaml`** ^4.1.0
- **`figma-tokens-map.yaml`** и **`figma-to-code.map.yaml`** — передаются через флаги CLI, переменные окружения, установленный пакет дизайн-системы или текущую рабочую директорию.
