"""
Осмотр насоса по загруженному фото: насос, ржавчина на нём, масло рядом с ним.

Установка: pip install fastapi uvicorn python-multipart ultralytics opencv-python numpy
Запуск:    uvicorn inspect_pump:app --host 0.0.0.0 --port 8000
Проверка:  curl -F "file=@photo.jpg" http://localhost:8000/inspect

Главная функция: inspect_pump(file: UploadFile) -> dict
"""
import threading

import cv2
import numpy as np
from fastapi import HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from ultralytics import YOLO

# ---------------------------- настройки ----------------------------
PUMP_WEIGHTS = "models/m.pt"   # модель деталей (сегментация), в ней есть класс насоса
RUST_WEIGHTS = "models/Basic_YOLO11_v1.pt"   # модель ржавчины (сегментация или детекция)
OIL_WEIGHTS = "models/best_oil.pt"     # модель масла (детекция или сегментация)

PUMP_CLASS = "pump"                # имя класса насоса в модели деталей
PUMP_IMGSZ, RUST_IMGSZ, OIL_IMGSZ = 1024, 640, 640   # как при обучении каждой модели
PUMP_CONF, RUST_CONF, OIL_CONF = 0.40, 0.25, 0.25

OIL_MARGIN = 0.5      # "рядом": на сколько расширить рамку насоса, в долях её размера
RUST_MIN_AREA = 50    # пятно ржавчины меньше стольких пикселей на насосе отбрасывается
ON_PUMP_SHARE = 0.3   # масло считается "на насосе", если такая доля пятна лежит на его маске
DEVICE = None         # None = выбрать автоматически, "cpu" или 0 = задать явно
# -------------------------------------------------------------------

_models = {}
_lock = threading.Lock()  # одна модель YOLO не рассчитана на вызовы из нескольких потоков сразу


def _model(path):
    if path not in _models:
        _models[path] = YOLO(path)
    return _models[path]


def _regions(model, img, conf, imgsz, offset=(0, 0), only_class=None):
    """Запускает модель и возвращает найденные области в координатах всего кадра.
    Работает и с сегментацией (контуры), и с детекцией (тогда контур = рамка)."""
    res = model(img, imgsz=imgsz, conf=conf, device=DEVICE, verbose=False)[0]
    if res.boxes is None or len(res.boxes) == 0:
        return []
    shift = np.float32(offset)
    polygons = res.masks.xy if res.masks is not None else [None] * len(res.boxes)
    out = []
    for box, poly in zip(res.boxes, polygons):
        name = res.names[int(box.cls)]
        if only_class is not None and name != only_class:
            continue
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        if poly is None or len(poly) < 3:
            poly = np.float32([[x1, y1], [x2, y1], [x2, y2], [x1, y2]])
        out.append({"label": name, "confidence": float(box.conf), "polygon": np.float32(poly) + shift})
    return out


def _fill(shape_hw, polygon):
    mask = np.zeros(shape_hw, np.uint8)
    cv2.fillPoly(mask, [np.round(polygon).astype(np.int32)], 1)
    return mask


def _crop_box(box, margin, w, h):
    """Рамка, расширенная на долю margin от своего размера и обрезанная по кадру."""
    x1, y1, x2, y2 = box
    dx, dy = (x2 - x1) * margin, (y2 - y1) * margin
    return max(0, int(x1 - dx)), max(0, int(y1 - dy)), min(w, int(x2 + dx)), min(h, int(y2 + dy))


def _public(region):
    poly = region["polygon"]
    x1, y1 = poly.min(0)
    x2, y2 = poly.max(0)
    return {
        "label": region["label"],
        "confidence": round(region["confidence"], 3),
        "box": [round(float(v), 1) for v in (x1, y1, x2, y2)],
        "polygon": np.round(poly, 1).tolist(),
    }


def analyze(img):
    """Вся логика на готовом изображении BGR. Возвращает словарь, пригодный для JSON."""
    h, w = img.shape[:2]
    result = {
        "image_size": [w, h],
        "pump": {"found": False},
        "rust": {"found": False, "share_of_pump": 0.0, "regions": []},
        "oil": {"found": False, "regions": []},
    }

    with _lock:
        # 1. Насос: самая уверенная находка нужного класса
        pumps = _regions(_model(PUMP_WEIGHTS), img, PUMP_CONF, PUMP_IMGSZ, only_class=PUMP_CLASS)
        if not pumps:
            return result  # без насоса ржавчину и масло не ищем
        pump = max(pumps, key=lambda r: r["confidence"])
        pump_mask = _fill((h, w), pump["polygon"])
        pump_area = int(pump_mask.sum())
        if pump_area == 0:
            return result
        result["pump"] = {"found": True, **_public(pump)}
        box = result["pump"]["box"]

        # 2. Ржавчина: ищем во фрагменте с насосом, оставляем только то, что лежит на его маске
        x1, y1, x2, y2 = _crop_box(box, 0.05, w, h)
        rust = _regions(_model(RUST_WEIGHTS), img[y1:y2, x1:x2], RUST_CONF, RUST_IMGSZ, offset=(x1, y1))

        # 3. Масло: ищем в расширенной области вокруг насоса
        ox1, oy1, ox2, oy2 = _crop_box(box, OIL_MARGIN, w, h)
        oil = _regions(_model(OIL_WEIGHTS), img[oy1:oy2, ox1:ox2], OIL_CONF, OIL_IMGSZ, offset=(ox1, oy1))

    rust_total = np.zeros((h, w), np.uint8)
    for region in rust:
        on_pump = _fill((h, w), region["polygon"]) & pump_mask
        if int(on_pump.sum()) < RUST_MIN_AREA:
            continue
        rust_total |= on_pump
        contours, _ = cv2.findContours(on_pump, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        region["polygon"] = max(contours, key=cv2.contourArea).reshape(-1, 2).astype(np.float32)
        result["rust"]["regions"].append(_public(region))
    result["rust"]["found"] = bool(result["rust"]["regions"])
    result["rust"]["share_of_pump"] = round(float(rust_total.sum()) / pump_area, 4)

    for region in oil:
        mask = _fill((h, w), region["polygon"])
        area = int(mask.sum())
        if area == 0:
            continue
        item = _public(region)
        item["on_pump"] = bool((mask & pump_mask).sum() / area >= ON_PUMP_SHARE)
        result["oil"]["regions"].append(item)
    result["oil"]["found"] = bool(result["oil"]["regions"])
    return result


async def inspect_pump(file: UploadFile) -> dict:
    """Принимает загруженное фото, находит насос, ржавчину на нём и масло рядом с ним."""
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Пустой файл")
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Файл не является изображением")
    # модели работают долго, поэтому запускаются в отдельном потоке и не блокируют сервер
    return await run_in_threadpool(analyze, img)
