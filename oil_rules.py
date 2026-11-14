"""
Поиск следов масла на фото насосов по правилам (без обучения).

Конвейер:
  1. (опц.) детектор деталей YOLO -> корпус, источники течи, фундамент, тёмные детали
  2. зона поиска: от уровня источника течи (уплотнение/фланец/вал) вниз + фундамент
  3. кандидаты: пятна, локально темнее своей окрестности
  4. признаки каждого пятна -> баллы -> решение «масло / нет»
  5. результат: размеченные картинки, маски, CSV по пятнам и по снимкам

Все настройки — константы ниже.
"""

import csv
from pathlib import Path

import cv2
import numpy as np

# ============================ ПУТИ ============================
INPUT_DIR = Path("насос/oil")          # папка с фото насосов
OUTPUT_DIR = Path("oil_results")    # куда сохранять результат
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"}

# ===================== ДЕТЕКТОР ДЕТАЛЕЙ (опц.) =====================
# Путь к весам YOLO (ultralytics). None — работать без детектора.
YOLO_WEIGHTS = Path("models/m.pt")                 # например: Path("parts_best.pt")
YOLO_CONF = 0.3
# Имена классов вашего детектора (в нижнем регистре). Лишние/отсутствующие — не страшно.
HOUSING_CLASSES = {"housing", "pump", "корпус"}
SOURCE_CLASSES = {"seal", "flange", "bearing_cover", "plug", "уплотнение", "фланец"}
FOUNDATION_CLASSES = {"foundation", "foundation_mount", "base", "frame", "фундамент", "рама"}
EXCLUDE_CLASSES = {"bolt", "nut", "hole", "empty_hole", "coupling_guard", "cable",
                   "болт", "гайка", "отверстие", "кожух"}
EXCLUDE_PAD_FRAC = 0.15             # расширение рамок исключаемых деталей
 
# ===================== МАСКА НАСОСА =====================
# Тёмный насос/рама по яркости неотличимы от масла — их пиксели надо исключить.
# Источник 1: сегментационная модель YOLO-seg (классы ниже) — берутся её маски.
PUMP_SEG_CLASSES = HOUSING_CLASSES | FOUNDATION_CLASSES | {"hose", "pipe", "motor", "шланг", "труба"}
# Источник 2: папка с готовыми масками <имя_фото>.png (белое = насос), например из SAM/CVAT.
PUMP_MASKS_DIR = None               # например: Path("pump_masks")
PUMP_MASK_DILATE = 9                # расширить маску насоса на столько пикселей (кромки, блики)
SHADOW_TOUCH_MAX = 0.35             # доля окрестности пятна, занятая насосом; больше -> скорее тень, -1
 
# ===================== ЗОНА ПОИСКА =====================
SOURCE_LEVEL_FRAC = 0.35   # если источников нет: уровень течи = верх корпуса + доля высоты
BELOW_MARGIN_FRAC = 0.35   # запас вниз от корпуса (доля высоты корпуса) — лужи на полу/раме
SIDE_MARGIN_FRAC = 0.10    # запас по бокам (доля ширины корпуса)
NO_DET_ZONE_TOP_FRAC = 0.35  # без детектора: искать в кадре ниже этой доли высоты
 
# ===================== КАНДИДАТЫ =====================
MAX_SIDE = 1600            # уменьшать фото до этого размера по длинной стороне
BG_SIGMA_FRAC = 0.035      # размер «окрестности» для локального фона (доля длинной стороны)
LOCAL_DARK_RATIO = 0.55   # пиксель темнее локального фона в это число раз
FLOOR_DARK_RATIO = 0.40   # или темнее пола в это число раз (ловит крупные лужи)
MIN_AREA_FRAC = 0.0004     # мин. площадь пятна (доля кадра)
MAX_AREA_FRAC = 0.08       # макс. площадь (больше — это сам насос/рама/тень)
OPEN_K = 3                 # морфология: убрать мелкий шум
CLOSE_K = 7                # морфология: склеить разорванные потёки (большое значение склеит лужу с насосом!)
 
# ===================== ПОЛ =====================
# Пол — самая частая светлая поверхность в зоне поиска. Масло на полу видно лучше всего.
FLOOR_TOL = 0.22           # пиксель считается полом, если |L - L_пола| < FLOOR_TOL * L_пола
FLOOR_CHROMA_TOL = 12      # ... и цвет близок к цвету пола
RING_FLOOR_MIN = 0.45      # доля пола в окрестности пятна -> «пятно лежит на полу», +2
 
# ===================== ПРИЗНАКИ И БАЛЛЫ =====================
RING_FRAC = 0.6            # ширина кольца-окрестности вокруг пятна (доля от размера пятна)
CONTRAST_STRONG = 0.35     # яркость пятна / яркость кольца ниже этого -> +2 (тени обычно 0.4–0.7)
CONTRAST_WEAK = 0.55       # ... ниже этого -> +1
COLOR_SHIFT_MIN = 7.0      # сдвиг цвета (a,b в LAB) относительно кольца -> +1 (тень цвет почти не меняет)
LOW_CHROMA_MAX = 12.0      # пятно почти бесцветное (чёрно-бурое) -> +1
GLOSS_RATIO = 1.15         # блик: пиксель ярче кольца в это число раз
GLOSS_MAX_CHROMA = 15      # ... и белёсый
GLOSS_MIN_FRAC = 0.005     # доля бликов в пятне -> +1
DRIP_ELONGATION = 1.4      # высота/ширина > этого -> потёк, +1
POOL_LOW_FRAC = 0.75       # пятно в нижней части зоны и шире, чем выше -> лужа, +1
RECT_FILL_MAX = 0.85       # заполнение рамки > этого -> щель/кромка, -2
SMOOTH_STD_MAX = 14.0      # масло гладкое; std яркости внутри больше -> текстура (ржавчина/грязь), -1
UNDER_SOURCE_BONUS = 1     # пятно прямо под источником течи -> +1
ROUND_CIRC_MIN = 0.80      # круглое (4πS/P²) ...
ROUND_MAX_AREA_FRAC = 0.002  # ... и маленькое -> болт/отверстие, -2
THIN_MAX_FRAC = 0.012      # толщина пятна < этой доли длинной стороны кадра -> щель/кромка, -2
 
SCORE_THRESHOLD = 4        # итог: балл >= порога -> масло
 
# ===================== ВЫВОД =====================
SAVE_DEBUG = True          # сохранять маски кандидатов и карту темноты
DRAW_REJECTED = True       # рисовать отклонённые кандидаты (жёлтым) с баллом
 
 
# ------------------------------------------------------------------
def load_detector():
    if YOLO_WEIGHTS is None:
        return None
    from ultralytics import YOLO
    return YOLO(str(YOLO_WEIGHTS))
 
 
def detect_parts(model, img):
    """Возвращает dict: группа -> список рамок (x1,y1,x2,y2) в координатах img,
    и маску насоса из сегментации (если модель сегментационная)."""
    h, w = img.shape[:2]
    groups = {"housing": [], "source": [], "foundation": [], "exclude": [],
              "pump_mask": np.zeros((h, w), np.uint8)}
    if model is None:
        return groups
    res = model.predict(img, conf=YOLO_CONF, verbose=False)[0]
    names = res.names
    seg = res.masks.data.cpu().numpy() if res.masks is not None else None
    for j, (box, cls) in enumerate(zip(res.boxes.xyxy.cpu().numpy(), res.boxes.cls.cpu().numpy())):
        name = str(names[int(cls)]).lower()
        b = tuple(int(v) for v in box)
        if seg is not None and name in PUMP_SEG_CLASSES:
            m = cv2.resize(seg[j].astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST)
            groups["pump_mask"][m > 0] = 255
        if name in HOUSING_CLASSES:
            groups["housing"].append(b)
        if name in SOURCE_CLASSES:
            groups["source"].append(b)
        if name in FOUNDATION_CLASSES:
            groups["foundation"].append(b)
        if name in EXCLUDE_CLASSES:
            groups["exclude"].append(b)
    return groups
 
 
def clip_box(x1, y1, x2, y2, w, h):
    return max(0, int(x1)), max(0, int(y1)), min(w, int(x2)), min(h, int(y2))
 
 
def build_zones(shape, parts):
    """Маска зоны поиска, маска исключений, маска «под источником»."""
    h, w = shape[:2]
    search = np.zeros((h, w), np.uint8)
    exclude = np.zeros((h, w), np.uint8)
    under_src = np.zeros((h, w), np.uint8)
 
    if not parts["housing"] and not parts["foundation"]:
        search[int(h * NO_DET_ZONE_TOP_FRAC):, :] = 255
    for (x1, y1, x2, y2) in parts["housing"]:
        bw, bh = x2 - x1, y2 - y1
        inside = [s for s in parts["source"]
                  if s[0] < x2 and s[2] > x1 and s[1] < y2 and s[3] > y1]
        top = min(s[1] for s in inside) if inside else y1 + SOURCE_LEVEL_FRAC * bh
        zx1, zy1, zx2, zy2 = clip_box(x1 - SIDE_MARGIN_FRAC * bw, top,
                                      x2 + SIDE_MARGIN_FRAC * bw, y2 + BELOW_MARGIN_FRAC * bh, w, h)
        search[zy1:zy2, zx1:zx2] = 255
    for (x1, y1, x2, y2) in parts["foundation"]:
        search[y1:y2, x1:x2] = 255
    for (x1, y1, x2, y2) in parts["source"]:
        bw = x2 - x1
        ux1, uy1, ux2, uy2 = clip_box(x1 - 0.5 * bw, y1, x2 + 0.5 * bw, h, w, h)
        under_src[uy1:uy2, ux1:ux2] = 255
    for (x1, y1, x2, y2) in parts["exclude"]:
        px, py = EXCLUDE_PAD_FRAC * (x2 - x1), EXCLUDE_PAD_FRAC * (y2 - y1)
        ex1, ey1, ex2, ey2 = clip_box(x1 - px, y1 - py, x2 + px, y2 + py, w, h)
        exclude[ey1:ey2, ex1:ex2] = 255
    return search, exclude, under_src
 
 
def estimate_floor(lab, valid):
    """Цвет пола = пик гистограммы яркости среди светлой половины пикселей зоны."""
    L = lab[:, :, 0][valid].astype(np.float32)
    if L.size < 100:
        L = lab[:, :, 0].ravel().astype(np.float32)
        a = lab[:, :, 1].ravel(); b = lab[:, :, 2].ravel()
    else:
        a, b = lab[:, :, 1][valid], lab[:, :, 2][valid]
    bright = L >= np.median(L)
    hist = np.bincount(L[bright].astype(int), minlength=256).astype(np.float32)
    hist = cv2.GaussianBlur(hist.reshape(1, -1), (1, 0), 4).ravel()
    fL = float(np.argmax(hist))
    near = bright & (np.abs(L - fL) < FLOOR_TOL * fL)
    fa = float(np.median(a[near])) if near.any() else 128.0
    fb = float(np.median(b[near])) if near.any() else 128.0
    return fL, fa, fb
 
 
def floor_mask(lab, floor):
    fL, fa, fb = floor
    L = lab[:, :, 0].astype(np.float32)
    d_ab = np.hypot(lab[:, :, 1].astype(np.float32) - fa, lab[:, :, 2].astype(np.float32) - fb)
    return (np.abs(L - fL) < FLOOR_TOL * fL) & (d_ab < FLOOR_CHROMA_TOL)
 
 
def find_candidates(lab, search, exclude, floor):
    h, w = lab.shape[:2]
    L = lab[:, :, 0].astype(np.float32)
 
    sigma = BG_SIGMA_FRAC * max(h, w)
    bg = cv2.GaussianBlur(L, (0, 0), sigma)
    ratio = L / (bg + 1.0)
 
    valid = (search > 0) & (exclude == 0)
    local_dark = ratio < LOCAL_DARK_RATIO
    floor_dark = L < floor[0] * FLOOR_DARK_RATIO
    mask = ((local_dark | floor_dark) & valid).astype(np.uint8) * 255
 
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((OPEN_K, OPEN_K), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (CLOSE_K, CLOSE_K)))
    mask &= valid.astype(np.uint8) * 255
    return mask, ratio
 
 
def load_pump_mask(img_path, shape, parts):
    """Объединяет маску из сегментации и маску из PUMP_MASKS_DIR."""
    h, w = shape[:2]
    m = parts["pump_mask"].copy()
    if PUMP_MASKS_DIR is not None:
        p = Path(PUMP_MASKS_DIR) / f"{img_path.stem}.png"
        if p.exists():
            ext = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
            ext = cv2.resize(ext, (w, h), interpolation=cv2.INTER_NEAREST)
            m[ext > 127] = 255
    if m.any() and PUMP_MASK_DILATE > 0:
        k = PUMP_MASK_DILATE * 2 + 1
        m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    return m
 
 
def blob_features(lab, labels, idx, stats, search, exclude, under_src, floor_m, pump_m):
    x, y, bw, bh, area = stats[idx]
    h, w = labels.shape
    pad = int(max(bw, bh) * RING_FRAC) + 3
    X1, Y1, X2, Y2 = max(0, x - pad), max(0, y - pad), min(w, x + bw + pad), min(h, y + bh + pad)
 
    blob = (labels[Y1:Y2, X1:X2] == idx).astype(np.uint8)
    k = max(3, pad | 1)
    dil = cv2.dilate(blob, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    ring_all = (dil > 0) & (blob == 0)
    pump_touch = float((pump_m[Y1:Y2, X1:X2][ring_all] > 0).mean()) if ring_all.any() else 0.0
    ring = ring_all & (labels[Y1:Y2, X1:X2] == 0) & (exclude[Y1:Y2, X1:X2] == 0) \
        & (pump_m[Y1:Y2, X1:X2] == 0)
    b = blob > 0
 
    patch = lab[Y1:Y2, X1:X2].astype(np.float32)
    L, A, B = patch[:, :, 0], patch[:, :, 1] - 128, patch[:, :, 2] - 128
    chroma = np.hypot(A, B)
 
    if ring.sum() < 10:  # окрестность почти вся занята — берём просто рамку вокруг
        ring = (blob == 0)
    ring_floor = float(floor_m[Y1:Y2, X1:X2][ring].mean())
    Lb, Lr = L[b].mean(), L[ring].mean() + 1e-6
    contrast = Lb / Lr
    color_shift = float(np.hypot(A[b].mean() - A[ring].mean(), B[b].mean() - B[ring].mean()))
    blob_chroma = float(chroma[b].mean())
    core = b & (L < Lr)                       # без бликов — они дают ложную «текстуру»
    l_std = float(L[core].std()) if core.sum() > 10 else float(L[b].std())
 
    near = cv2.dilate(blob, np.ones((5, 5), np.uint8)) > 0  # блики часто по краю/внутри
    gloss = (near & (L > Lr * GLOSS_RATIO) & (chroma < GLOSS_MAX_CHROMA)).sum() / max(1, near.sum())
 
    elong = bh / max(bw, 1)
    fill = area / max(bw * bh, 1)
    cnts, _ = cv2.findContours(blob, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    perim = max(cv2.arcLength(max(cnts, key=cv2.contourArea), True), 1.0) if cnts else 1.0
    circ = 4 * np.pi * area / perim ** 2
    # толщина = удвоенное макс. расстояние до края внутри пятна
    thick = 2 * float(cv2.distanceTransform(blob, cv2.DIST_L2, 5).max())
 
    ys = np.where(search.any(axis=1))[0]
    z_top, z_bot = (ys.min(), ys.max()) if len(ys) else (0, h)
    cy = y + bh / 2
    low_pos = (cy - z_top) / max(z_bot - z_top, 1)
    under = under_src[y:y + bh, x:x + bw].mean() / 255 > 0.5
 
    return dict(x=int(x), y=int(y), w=int(bw), h=int(bh), area=int(area),
                contrast=round(float(contrast), 3), color_shift=round(color_shift, 2),
                chroma=round(blob_chroma, 2), gloss=round(float(gloss), 4),
                elong=round(float(elong), 2), fill=round(float(fill), 3),
                l_std=round(l_std, 2), low_pos=round(float(low_pos), 3), under_source=bool(under),
                ring_floor=round(ring_floor, 3), pump_touch=round(pump_touch, 3),
                circ=round(float(circ), 3), area_frac=area / (h * w), thick_frac=thick / max(h, w))
 
 
def score_blob(f):
    s, why = 0, []
    if f["contrast"] < CONTRAST_STRONG:
        s += 2; why.append("dark++")
    elif f["contrast"] < CONTRAST_WEAK:
        s += 1; why.append("dark+")
    if f["color_shift"] > COLOR_SHIFT_MIN:
        s += 1; why.append("color")
    if f["chroma"] < LOW_CHROMA_MAX:
        s += 1; why.append("blackish")
    if f["gloss"] > GLOSS_MIN_FRAC:
        s += 1; why.append("gloss")
    if f["elong"] > DRIP_ELONGATION:
        s += 1; why.append("drip")
    elif f["low_pos"] > POOL_LOW_FRAC and f["elong"] < 1.0:
        s += 1; why.append("pool")
    if f["under_source"]:
        s += UNDER_SOURCE_BONUS; why.append("under_src")
    if f["ring_floor"] > RING_FLOOR_MIN:
        s += 2; why.append("on_floor")
    if f["pump_touch"] > SHADOW_TOUCH_MAX:
        s -= 1; why.append("hugs_pump-")
    if f["circ"] > ROUND_CIRC_MIN and f["area_frac"] < ROUND_MAX_AREA_FRAC:
        s -= 2; why.append("bolt-")
    if f["thick_frac"] < THIN_MAX_FRAC:
        s -= 2; why.append("thin-")
    if f["fill"] > RECT_FILL_MAX:
        s -= 2; why.append("rect-")
    if f["l_std"] > SMOOTH_STD_MAX:
        s -= 1; why.append("texture-")
    return s, why
 
 
def process(img_path, model, writer):
    img0 = cv2.imread(str(img_path))
    if img0 is None:
        print(f"[skip] не читается: {img_path}")
        return None
    scale = min(1.0, MAX_SIDE / max(img0.shape[:2]))
    img = cv2.resize(img0, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else img0
    h, w = img.shape[:2]
 
    parts = detect_parts(model, img)
    search, exclude, under_src = build_zones(img.shape, parts)
    pump_m = load_pump_mask(img_path, img.shape, parts)
    exclude = np.maximum(exclude, pump_m)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    floor = estimate_floor(lab, (search > 0) & (exclude == 0))
    floor_m = floor_mask(lab, floor)
    mask, ratio = find_candidates(lab, search, exclude, floor)
 
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    min_area, max_area = MIN_AREA_FRAC * h * w, MAX_AREA_FRAC * h * w
 
    vis = img.copy()
    cnts, _ = cv2.findContours(search, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(vis, cnts, -1, (255, 160, 0), 2)  # зона поиска — голубым
    for (x1, y1, x2, y2) in parts["exclude"]:
        cv2.rectangle(vis, (x1, y1), (x2, y2), (128, 128, 128), 1)
    pc, _ = cv2.findContours(pump_m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(vis, pc, -1, (200, 200, 200), 1)  # маска насоса — серым
 
    oil_mask = np.zeros((h, w), np.uint8)
    n_oil, best = 0, -99
    for i in range(1, n):
        if not (min_area <= stats[i, cv2.CC_STAT_AREA] <= max_area):
            continue
        f = blob_features(lab, labels, i, stats, search, exclude, under_src, floor_m, pump_m)
        s, why = score_blob(f)
        is_oil = s >= SCORE_THRESHOLD
        best = max(best, s)
 
        inv = 1 / scale  # координаты — в исходном разрешении
        writer.writerow({"file": img_path.name, "x": int(f["x"] * inv), "y": int(f["y"] * inv),
                         "w": int(f["w"] * inv), "h": int(f["h"] * inv),
                         **{k: v for k, v in f.items() if k not in ("x", "y", "w", "h", "area_frac", "thick_frac")},
                         "score": s, "reasons": " ".join(why), "is_oil": int(is_oil)})
 
        x, y, bw, bh = f["x"], f["y"], f["w"], f["h"]
        if is_oil:
            n_oil += 1
            oil_mask[labels == i] = 255
            cv2.rectangle(vis, (x, y), (x + bw, y + bh), (0, 0, 255), 2)
            cv2.putText(vis, f"OIL {s}", (x, max(12, y - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
        elif DRAW_REJECTED:
            cv2.rectangle(vis, (x, y), (x + bw, y + bh), (0, 220, 255), 1)
            cv2.putText(vis, str(s), (x, max(12, y - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 220, 255), 1)
 
    overlay = vis.copy()
    overlay[oil_mask > 0] = (0, 0, 255)
    vis = cv2.addWeighted(overlay, 0.35, vis, 0.65, 0)
 
    stem = img_path.stem
    cv2.imwrite(str(OUTPUT_DIR / f"{stem}_result.jpg"), vis)
    cv2.imwrite(str(OUTPUT_DIR / f"{stem}_oilmask.png"),
                cv2.resize(oil_mask, (img0.shape[1], img0.shape[0]), interpolation=cv2.INTER_NEAREST))
    if SAVE_DEBUG:
        dbg = OUTPUT_DIR / "debug"
        cv2.imwrite(str(dbg / f"{stem}_candidates.png"), mask)
        cv2.imwrite(str(dbg / f"{stem}_floor.png"), floor_m.astype(np.uint8) * 255)
        cv2.imwrite(str(dbg / f"{stem}_darkness.png"),
                    np.clip((1.2 - ratio) * 255, 0, 255).astype(np.uint8))
 
    return {"file": img_path.name, "has_oil": int(n_oil > 0), "oil_spots": n_oil,
            "max_score": best if best > -99 else ""}
 
 
def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if SAVE_DEBUG:
        (OUTPUT_DIR / "debug").mkdir(exist_ok=True)
    model = load_detector()
 
    files = sorted(p for p in INPUT_DIR.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    if not files:
        print(f"Нет картинок в {INPUT_DIR.resolve()}")
        return
 
    spot_fields = ["file", "x", "y", "w", "h", "area", "contrast", "color_shift", "chroma",
                   "gloss", "elong", "fill", "l_std", "low_pos", "under_source", "ring_floor", "pump_touch", "circ",
                   "score", "reasons", "is_oil"]
    summary = []
    with open(OUTPUT_DIR / "spots.csv", "w", newline="", encoding="utf-8-sig") as fs:
        writer = csv.DictWriter(fs, fieldnames=spot_fields, delimiter=";")
        writer.writeheader()
        for p in files:
            r = process(p, model, writer)
            if r:
                summary.append(r)
                print(f"{r['file']:40s} масло: {'ДА ' if r['has_oil'] else 'нет'}  "
                      f"пятен: {r['oil_spots']}  макс. балл: {r['max_score']}")
 
    with open(OUTPUT_DIR / "summary.csv", "w", newline="", encoding="utf-8-sig") as f:
        wr = csv.DictWriter(f, fieldnames=["file", "has_oil", "oil_spots", "max_score"], delimiter=";")
        wr.writeheader()
        wr.writerows(summary)
    print(f"\nГотово: {len(summary)} фото -> {OUTPUT_DIR.resolve()}")
 
 
if __name__ == "__main__":
    main()
 
