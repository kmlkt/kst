"""
Генерация обучающего набора: вклейка насоса на фото цехов с разметкой YOLO-seg.

Что нужно:
  насос/   изображения насоса (белый или прозрачный фон) и рядом с каждым
           JSON от labelme с тем же именем (pump1.png + pump1.json)
  цех/     фото цехов, без разметки

Установка: pip install opencv-python numpy
Запуск:    python make_dataset.py
Результат: dataset/images/{train,val}, dataset/labels/{train,val},
           dataset/data.yaml и dataset/preview/ (картинки с нарисованной
           разметкой: просмотрите их перед обучением).
"""
import json
import math
import random
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

# ---------------------------- настройки ----------------------------
PUMP_DIR = Path("насос")
BG_DIR = Path("цех")
OUT_DIR = Path("dataset")

N_IMAGES = 100            # сколько картинок сгенерировать
SIZE = 1024                # сторона квадратной картинки (отверстия мелкие, меньше не стоит)
VAL_FRACTION = 0.1         # доля для проверки
NEGATIVE_FRACTION = 0.1    # доля картинок без насоса

PUMP_CLASS = "pump"        # класс насоса целиком, добавляется автоматически
SEE_THROUGH_LABELS = {"bolt_hole"}  # в этих деталях фон вырезается насквозь
BG_TOLERANCE = 8           # насколько пиксель может отличаться от цвета фона (0-255)
CUT_ENCLOSED = 0.01        # замкнутые просветы фона крупнее этой доли насоса вырезаются
                           # (щели между шпильками и т.п.); None = не вырезать

SCALE_RANGE = (0.35, 0.90) # длинная сторона насоса в долях кадра
MAX_ROTATION = 25          # поворот, градусы в обе стороны
FLIP_PROB = 0.5            # зеркальное отражение
SHADOW_PROB = 0.7          # тень под насосом
OCCLUSION_PROB = 0.25      # частичное перекрытие посторонним предметом
MIN_VISIBLE = 0.30         # деталь размечается, если видно не меньше этой доли
MIN_AREA = 12              # и не меньше стольких пикселей
N_PREVIEW = 12
SEED = 0
# -------------------------------------------------------------------

EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
K3 = np.ones((3, 3), np.uint8)


def imread(path, flags=cv2.IMREAD_COLOR):
    """Чтение через numpy: cv2.imread на Windows не открывает пути с кириллицей."""
    try:
        return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), flags)
    except Exception:
        return None


def imwrite(path, img):
    ok, buf = cv2.imencode(Path(path).suffix, img)
    if ok:
        buf.tofile(str(path))


def shape_points(shape):
    """Фигура labelme -> массив точек полигона (или None, если тип не поддержан)."""
    pts = np.array(shape.get("points", []), dtype=np.float32)
    kind = shape.get("shape_type", "polygon")
    if kind == "polygon" and len(pts) >= 3:
        return pts
    if kind == "rectangle" and len(pts) == 2:
        (x1, y1), (x2, y2) = pts
        return np.array([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], np.float32)
    if kind == "circle" and len(pts) == 2:
        r = float(np.linalg.norm(pts[1] - pts[0]))
        a = np.linspace(0, 2 * np.pi, 20, endpoint=False)
        return np.stack([pts[0][0] + r * np.cos(a), pts[0][1] + r * np.sin(a)], 1).astype(np.float32)
    return None


def fill(shape_hw, pts):
    m = np.zeros(shape_hw, np.uint8)
    cv2.fillPoly(m, [np.round(pts).astype(np.int32)], 1)
    return m


def load_pump(path):
    """Возвращает dict(bgr, mask, shapes) для одного изображения насоса, обрезанный по маске."""
    img = imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        print(f"  [пропуск] не читается: {path.name}")
        return None
    if img.dtype != np.uint8:
        img = (img / 257).astype(np.uint8)
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    bgr = np.ascontiguousarray(img[..., :3])
    h, w = bgr.shape[:2]

    shapes = []
    json_path = path.with_suffix(".json")
    if json_path.exists():
        data = json.loads(json_path.read_text(encoding="utf-8"))
        for sh in data.get("shapes", []):
            pts = shape_points(sh)
            if pts is None:
                print(f"  [внимание] {path.name}: фигура '{sh.get('label')}' типа "
                      f"'{sh.get('shape_type')}' не поддерживается, пропущена")
            else:
                shapes.append((str(sh["label"]).strip(), pts))
    else:
        print(f"  [внимание] {path.name}: нет файла разметки, будет размечен только насос целиком")

    manual = [pts for label, pts in shapes if label == PUMP_CLASS]
    if manual:  # насос обведён вручную: берём этот контур
        mask = np.zeros((h, w), np.uint8)
        for pts in manual:
            mask |= fill((h, w), pts)
        how = "ручной контур"
    elif img.shape[2] == 4 and img[..., 3].min() < 250:
        mask = (img[..., 3] > 127).astype(np.uint8)
        how = "прозрачный фон"
    else:  # однотонный фон: его цвет берётся с краёв кадра
        edge = np.concatenate([bgr[0], bgr[-1], bgr[:, 0], bgr[:, -1]]).astype(np.int16)
        bg_color = np.median(edge, axis=0)
        white = (np.abs(bgr.astype(np.int16) - bg_color).max(axis=2) <= BG_TOLERANCE).astype(np.uint8)
        n, lab, st, _ = cv2.connectedComponentsWithStats(white, connectivity=4)
        border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
        border = border[border != 0]
        # фоном считается только то, что связано с краем кадра: светлые детали
        # внутри насоса (табличка, блики на алюминии) остаются
        mask = (~np.isin(lab, border)).astype(np.uint8)
        if CUT_ENCLOSED:  # крупные замкнутые просветы: фон виден сквозь насос
            limit = CUT_ENCLOSED * mask.sum()
            holes = [i for i in range(1, n) if i not in border and st[i, cv2.CC_STAT_AREA] > limit]
            mask[np.isin(lab, holes)] = 0
        for label, pts in shapes:  # сквозные отверстия: фон внутри них тоже вырезается
            if label in SEE_THROUGH_LABELS:
                mask[(fill((h, w), pts) > 0) & (white > 0)] = 0
        mask = cv2.erode(mask, K3)  # убираем светлую кайму по краю
        how = "однотонный фон"
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, K3)

    share = mask.mean()
    if share < 0.01 or share > 0.90:
        print(f"  [пропуск] {path.name}: фон не отделился (маска {share:.0%} кадра). "
              f"Обведите насос в labelme полигоном с меткой '{PUMP_CLASS}'")
        return None
    x, y, bw, bh = cv2.boundingRect(mask)
    shapes = [(label, pts - np.float32([x, y])) for label, pts in shapes if label != PUMP_CLASS]
    print(f"  {path.name}: {how}, деталей {len(shapes)}")
    return dict(bgr=bgr[y:y + bh, x:x + bw], mask=mask[y:y + bh, x:x + bw], shapes=shapes)


def random_background(bg_paths):
    for _ in range(20):
        img = imread(random.choice(bg_paths))
        if img is None or min(img.shape[:2]) < 300:
            continue
        h, w = img.shape[:2]
        side = int(random.uniform(0.5, 1.0) * min(h, w))
        x, y = random.randint(0, w - side), random.randint(0, h - side)
        img = cv2.resize(img[y:y + side, x:x + side], (SIZE, SIZE), interpolation=cv2.INTER_AREA)
        return img[:, ::-1].copy() if random.random() < 0.5 else img
    raise RuntimeError("Не удалось прочитать ни одного фона из папки " + str(BG_DIR))


def random_affine(w, h):
    """Случайные масштаб, поворот, отражение и положение. Возвращает матрицу 2x3."""
    scale = random.uniform(*SCALE_RANGE) * SIZE / max(w, h)
    ang = math.radians(random.uniform(-MAX_ROTATION, MAX_ROTATION))
    A = scale * np.array([[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]])
    if random.random() < FLIP_PROB:
        A = A @ np.array([[-1.0, 0.0], [0.0, 1.0]])
    corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float64) @ A.T
    mn, (bw, bh) = corners.min(0), corners.max(0) - corners.min(0)
    # насос может выходить за кадр не больше чем на 15%
    tx = random.uniform(-0.15 * bw, SIZE - 0.85 * bw) - mn[0]
    ty = random.uniform(-0.15 * bh, SIZE - 0.85 * bh) - mn[1]
    return np.hstack([A, [[tx], [ty]]])


def largest_polygon(mask):
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    c = max(contours, key=cv2.contourArea)
    c = cv2.approxPolyDP(c, 0.75, True).reshape(-1, 2)
    return c if len(c) >= 3 else None


def make_sample(pump, bg_paths):
    """Одна картинка с насосом. Возвращает (изображение, [(метка, полигон), ...])."""
    canvas = random_background(bg_paths).astype(np.float32)
    h, w = pump["mask"].shape
    M = random_affine(w, h)
    warped = cv2.warpAffine(pump["bgr"], M, (SIZE, SIZE), flags=cv2.INTER_LINEAR).astype(np.float32)
    mask = cv2.warpAffine(pump["mask"] * 255, M, (SIZE, SIZE), flags=cv2.INTER_LINEAR) > 127

    # яркость, контраст и лёгкий сдвиг цвета насоса
    gain = random.uniform(0.75, 1.2) * np.array([random.uniform(0.95, 1.05) for _ in range(3)])
    warped = np.clip(warped * gain + random.uniform(-25, 25), 0, 255)

    if random.random() < SHADOW_PROB:
        shift = np.float32([[1, 0, random.uniform(-30, 30)], [0, 1, random.uniform(10, 50)]])
        shadow = cv2.warpAffine(mask.astype(np.float32), shift, (SIZE, SIZE))
        shadow = cv2.GaussianBlur(shadow, (61, 61), 0) * random.uniform(0.3, 0.6)
        canvas *= 1 - shadow[..., None]

    # мягкий край: маска слегка сжимается и размывается, чтобы не было ореола
    alpha = cv2.GaussianBlur(cv2.erode(mask.astype(np.float32), K3), (5, 5), 0)[..., None]
    canvas = canvas * (1 - alpha) + warped * alpha

    occluded = np.zeros((SIZE, SIZE), bool)
    if random.random() < OCCLUSION_PROB:  # закрываем часть насоса куском другого фона
        x, y, bw, bh = cv2.boundingRect(mask.astype(np.uint8))
        ow, oh = int(bw * random.uniform(0.15, 0.4)), int(bh * random.uniform(0.15, 0.4))
        if ow > 4 and oh > 4:
            ox, oy = random.randint(x, x + bw - ow), random.randint(y, y + bh - oh)
            occluded[oy:oy + oh, ox:ox + ow] = True
            canvas[occluded] = random_background(bg_paths).astype(np.float32)[occluded]

    # общие искажения, как у съёмки с рук
    if random.random() < 0.2:
        k = random.choice([3, 5])
        canvas = cv2.GaussianBlur(canvas, (k, k), 0)
    if random.random() < 0.3:
        canvas += np.random.normal(0, random.uniform(2, 8), canvas.shape)
    canvas = np.clip(canvas * random.uniform(0.85, 1.15), 0, 255).astype(np.uint8)

    labels = []
    visible_pump = mask & ~occluded
    if visible_pump.sum() < MIN_VISIBLE * max(1, mask.sum()):
        return None
    poly = largest_polygon(visible_pump)
    if poly is None:
        return None
    labels.append((PUMP_CLASS, poly))
    for label, pts in pump["shapes"]:
        pts_t = pts.astype(np.float64) @ M[:, :2].T + M[:, 2]
        full_area = cv2.contourArea(pts_t.astype(np.float32))
        visible = (fill((SIZE, SIZE), pts_t) > 0) & ~occluded
        if visible.sum() < max(MIN_AREA, MIN_VISIBLE * full_area):
            continue  # деталь ушла за кадр, закрыта или слишком мелкая
        poly = largest_polygon(visible)
        if poly is not None:
            labels.append((label, poly))
    return canvas, labels


def draw_preview(img, labels, classes):
    out = img.copy()
    for label, poly in labels:
        i = classes.index(label)
        color = tuple(int(c) for c in cv2.cvtColor(
            np.uint8([[[(i * 47) % 180, 255, 255]]]), cv2.COLOR_HSV2BGR)[0, 0])
        cv2.polylines(out, [poly.astype(np.int32)], True, color, 2)
        x, y = poly.min(0)
        cv2.putText(out, str(i), (int(x), max(12, int(y) - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
    return out


def main():
    random.seed(SEED)
    np.random.seed(SEED)
    for d in (PUMP_DIR, BG_DIR):
        if not d.is_dir():
            raise SystemExit(f"Нет папки '{d}'. Запускайте скрипт из папки, где лежат '{PUMP_DIR}' и '{BG_DIR}'")

    print("Изображения насоса:")
    files = sorted(p for p in PUMP_DIR.iterdir() if p.suffix.lower() in EXTS)
    pumps = [p for p in map(load_pump, files) if p is not None]
    bg_paths = sorted(p for p in BG_DIR.iterdir() if p.suffix.lower() in EXTS)
    if not pumps or not bg_paths:
        raise SystemExit(f"Нужны изображения в обеих папках: насосов {len(pumps)}, фонов {len(bg_paths)}")

    classes = [PUMP_CLASS] + sorted({label for p in pumps for label, _ in p["shapes"]})
    print(f"Фонов: {len(bg_paths)}. Классы: " + ", ".join(f"{i}={c}" for i, c in enumerate(classes)))

    for sub in ("images/train", "images/val", "labels/train", "labels/val", "preview"):
        (OUT_DIR / sub).mkdir(parents=True, exist_ok=True)

    stats, n_val, previews = Counter(), int(N_IMAGES * VAL_FRACTION), 0
    for i in range(N_IMAGES):
        split = "val" if i < n_val else "train"
        if random.random() < NEGATIVE_FRACTION:
            img, labels = random_background(bg_paths), []
        else:
            sample = None
            while sample is None:
                sample = make_sample(random.choice(pumps), bg_paths)
            img, labels = sample
        name = f"{i:05d}"
        imwrite(OUT_DIR / "images" / split / f"{name}.jpg", img)
        lines = []
        for label, poly in labels:
            coords = np.clip(poly / SIZE, 0, 1).reshape(-1)
            lines.append(f"{classes.index(label)} " + " ".join(f"{v:.5f}" for v in coords))
            stats[label] += 1
        (OUT_DIR / "labels" / split / f"{name}.txt").write_text("\n".join(lines), encoding="utf-8")
        if labels and previews < N_PREVIEW:
            imwrite(OUT_DIR / "preview" / f"{name}.jpg", draw_preview(img, labels, classes))
            previews += 1
        if (i + 1) % 100 == 0:
            print(f"  готово {i + 1}/{N_IMAGES}")

    yaml = [f"path: {OUT_DIR.resolve().as_posix()}", "train: images/train", "val: images/val", "names:"]
    yaml += [f"  {i}: {json.dumps(c, ensure_ascii=False)}" for i, c in enumerate(classes)]
    (OUT_DIR / "data.yaml").write_text("\n".join(yaml) + "\n", encoding="utf-8")

    print("Меток по классам: " + ", ".join(f"{c}={stats[c]}" for c in classes))
    print(f"Набор сохранён в '{OUT_DIR}'. Просмотрите папку preview перед обучением.")


if __name__ == "__main__":
    main()