"""Собирает архив для Chrome Web Store: только файлы расширения, без тестов и картинок стора.

Запуск из корня репозитория: python tools/pack.py
Архив ложится рядом с репозиторием: ../drops-<версия>-store.zip
"""
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = ["manifest.json", "background.js", "popup.html", "popup.css", "popup.js", "integrity-hook.js", "kick-hook.js"]
FOLDERS = ["lib", "icons", "_locales"]


def main():
    files = list(FILES)
    for folder in FOLDERS:
        for base, _, names in os.walk(os.path.join(ROOT, folder)):
            for name in names:
                files.append(os.path.relpath(os.path.join(base, name), ROOT).replace(os.sep, "/"))

    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)
    out = os.path.join(os.path.dirname(ROOT), f"drops-{manifest['version']}-store.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(files):
            archive.write(os.path.join(ROOT, name), name)

    names = set(zipfile.ZipFile(out).namelist())
    need = {manifest["background"]["service_worker"], manifest["action"]["default_popup"]}
    need |= set(manifest["icons"].values()) | set(manifest["action"]["default_icon"].values())
    for script in manifest["content_scripts"]:
        need |= set(script["js"])
    missing = sorted(need - names)
    print(out, os.path.getsize(out) // 1024, "KB,", len(names), "files")
    if missing:
        raise SystemExit(f"missing from archive: {missing}")


if __name__ == "__main__":
    main()
