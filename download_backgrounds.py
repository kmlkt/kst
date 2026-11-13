"""
Скачивает фото промышленных помещений с Wikimedia Commons для фонов.

Ключи и регистрация не нужны, сторонние библиотеки тоже.
Запуск:    python download_backgrounds.py
Результат: папка backgrounds/ с картинками и licenses.csv (автор и лицензия
           каждого файла: пригодится, если данные будут где-то публиковаться).
"""
import csv
import json
import os
import time
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
HEADERS = {"User-Agent": "background-collector/1.0 (personal research script)"}
OUT_DIR = "backgrounds"

QUERIES = [
    "factory interior",
    "industrial workshop interior",
    "pump room",
    "boiler room",
    "machine hall",
    "engine room",
    "warehouse interior",
    "industrial plant floor",
]
PER_QUERY = 20     # максимум 50 за один запрос
MIN_WIDTH = 800    # мелкие картинки пропускаем
PAUSE = 1.0        # пауза между скачиваниями, чтобы не нагружать сервер


def api(params):
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def search(query, limit):
    data = api({
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": f"{query} filetype:bitmap",
        "gsrnamespace": 6,          # только файлы
        "gsrlimit": limit,
        "prop": "imageinfo",
        "iiprop": "url|size|mime|extmetadata",
        "iiurlwidth": 1280,         # просим уменьшенную копию, оригиналы огромные
    })
    return list(data.get("query", {}).get("pages", {}).values())


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    seen, rows = set(), []
    for query in QUERIES:
        try:
            pages = search(query, PER_QUERY)
        except Exception as e:
            print(f"[ошибка поиска] {query}: {e}")
            continue
        print(f"{query}: найдено {len(pages)}")
        for page in pages:
            info = (page.get("imageinfo") or [{}])[0]
            if page.get("pageid") in seen or info.get("mime") != "image/jpeg":
                continue
            if info.get("width", 0) < MIN_WIDTH:
                continue
            seen.add(page["pageid"])
            url = info.get("thumburl") or info.get("url")
            path = os.path.join(OUT_DIR, f"bg_{page['pageid']}.jpg")
            try:
                req = urllib.request.Request(url, headers=HEADERS)
                with urllib.request.urlopen(req, timeout=60) as resp, open(path, "wb") as f:
                    f.write(resp.read())
            except Exception as e:
                print(f"  [пропуск] {page.get('title')}: {e}")
                continue
            meta = info.get("extmetadata", {})
            rows.append([
                os.path.basename(path),
                page.get("title", ""),
                meta.get("LicenseShortName", {}).get("value", ""),
                meta.get("Artist", {}).get("value", ""),
                info.get("descriptionurl", ""),
            ])
            time.sleep(PAUSE)

    with open(os.path.join(OUT_DIR, "licenses.csv"), "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["file", "title", "license", "author", "source"])
        writer.writerows(rows)
    print(f"Скачано: {len(rows)} файлов в папку {OUT_DIR}/")


if __name__ == "__main__":
    main()

