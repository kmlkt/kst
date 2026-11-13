"""
Осмотр насосной станции по фото: Grounding DINO + SAM + CLIP, всё локально.

  1. Grounding DINO находит станцию, узлы и кандидатов в масляные пятна (рамки).
  2. SAM превращает рамки в точные контуры.
  3. CLIP перепроверяет каждый узел и каждое пятно.

Установка: pip install torch transformers pillow opencv-python numpy
Запуск:    python pump_inspect.py photo.jpg
Результат: result.jpg рядом со скриптом и отчёт в консоли.

Веса скачиваются с Hugging Face один раз, дальше работает без сети.
"""
import sys

import cv2
import numpy as np
import torch
from PIL import Image
from transformers import (
    AutoModelForZeroShotObjectDetection,
    AutoProcessor,
    CLIPModel,
    CLIPProcessor,
    SamModel,
    SamProcessor,
)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

DINO_ID = "IDEA-Research/grounding-dino-tiny"
SAM_ID = "facebook/sam-vit-base"
CLIP_ID = "openai/clip-vit-base-patch32"

# --- Текстовые запросы: главное место для настройки под ваши фото ---
STATION_PROMPTS = ["pumping station"]
NODE_PROMPTS = ["pump", "electric motor", "valve", "handwheel", "flange", "pressure gauge"]
OIL_PROMPTS = ["oil leak", "oil stain", "oil puddle"]

# Первое описание = норма, остальные = виды дефектов
NODE_STATES = [
    "a photo of clean industrial equipment in good condition",
    "a photo of industrial equipment with an oil leak",
    "a photo of rusty corroded industrial equipment",
    "a photo of broken damaged industrial equipment",
]
# Первое описание = масло, остальные = то, с чем его путают
OIL_CHECK = [
    "a dark oil stain or oil drip",
    "a shadow",
    "a clean metal surface",
    "a wet spot of water",
]

# --- Пороги: подбирать на своих снимках ---
NODE_BOX_THR = 0.22      # уверенность DINO для узлов
MAX_NODE_AREA = 0.60     # узел больше 60% кадра: это не узел, а вся сцена
DEBUG = True             # печатать все сырые рамки DINO
OIL_BOX_THR = 0.20       # для масла ниже: лучше лишний кандидат, CLIP отсеет
DEFECT_THR = 0.70        # вероятность дефекта по CLIP (норма против самого похожего дефекта)
BACKGROUND = "a floor, a wall or background clutter"  # кропы с таким ответом CLIP выбрасываем
OIL_CONFIRM_THR = 0.50   # вероятность масла по CLIP
MAX_OIL_AREA = 0.30      # пятно больше 30% кадра считаем ошибкой

print(f"Загрузка моделей на {DEVICE}...")
dino_proc = AutoProcessor.from_pretrained(DINO_ID)
dino = AutoModelForZeroShotObjectDetection.from_pretrained(DINO_ID).to(DEVICE).eval()
sam_proc = SamProcessor.from_pretrained(SAM_ID)
sam = SamModel.from_pretrained(SAM_ID).to(DEVICE).eval()
clip_proc = CLIPProcessor.from_pretrained(CLIP_ID)
clip = CLIPModel.from_pretrained(CLIP_ID).to(DEVICE).eval()


def detect(image, labels, box_thr, text_thr=0.25):
    """Grounding DINO: список (рамка [x1, y1, x2, y2], уверенность, название)."""
    text = ". ".join(labels) + "."  # формат DINO: строчные фразы через точку
    inputs = dino_proc(images=image, text=text, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        outputs = dino(**inputs)
    kwargs = dict(text_threshold=text_thr, target_sizes=[image.size[::-1]])
    try:  # в разных версиях transformers параметр называется по-разному
        res = dino_proc.post_process_grounded_object_detection(
            outputs, inputs.input_ids, threshold=box_thr, **kwargs
        )[0]
    except TypeError:
        res = dino_proc.post_process_grounded_object_detection(
            outputs, inputs.input_ids, box_threshold=box_thr, **kwargs
        )[0]
    names = res["text_labels"] if "text_labels" in res else res["labels"]
    return [
        (box.tolist(), float(score), str(name))
        for box, score, name in zip(res["boxes"], res["scores"], names)
    ]


def iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def detect_each(image, labels, box_thr, max_area_frac):
    """Запускает DINO отдельно на каждый запрос (так классы не мешают друг другу),
    выбрасывает рамки на весь кадр и убирает дубли (NMS)."""
    img_area = image.size[0] * image.size[1]
    dets = []
    for label in labels:
        for box, score, _ in detect(image, [label], box_thr):
            frac = (box[2] - box[0]) * (box[3] - box[1]) / img_area
            if DEBUG:
                print(f"    dino: {label:15s} score={score:.2f} площадь={frac:.0%}")
            if frac <= max_area_frac:
                dets.append((box, score, label))
    keep = []
    for d in sorted(dets, key=lambda d: -d[1]):
        if all(iou(d[0], k[0]) < 0.5 for k in keep):
            keep.append(d)
    return keep


def clean_mask(mask, k_frac=0.01, min_frac=0.0005):
    """Чистит маску SAM: склеивает разрывы, убирает мелкий мусор, заливает дыры."""
    h, w = mask.shape
    k = max(3, int(max(h, w) * k_frac)) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    m = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel)
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    big = [c for c in contours if cv2.contourArea(c) > min_frac * h * w]
    out = np.zeros_like(mask)
    cv2.drawContours(out, big, -1, 1, cv2.FILLED)
    return out


def segment(image, boxes):
    """SAM: по списку рамок возвращает список бинарных масок (H x W, uint8)."""
    if not boxes:
        return []
    inputs = sam_proc(image, input_boxes=[boxes], return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        outputs = sam(**inputs, multimask_output=False)
    masks = sam_proc.image_processor.post_process_masks(
        outputs.pred_masks.cpu(),
        inputs["original_sizes"].cpu(),
        inputs["reshaped_input_sizes"].cpu(),
    )[0]
    return [m[0].numpy().astype(np.uint8) for m in masks]


def classify(crop, texts):
    """CLIP: вероятности того, что фрагмент соответствует каждому описанию."""
    inputs = clip_proc(text=texts, images=crop, return_tensors="pt", padding=True).to(DEVICE)
    with torch.no_grad():
        probs = clip(**inputs).logits_per_image.softmax(dim=1)[0]
    return probs.cpu().numpy()


def crop_box(image, box, pad=0.10):
    """Вырезает рамку с небольшим запасом: CLIP нужен контекст вокруг."""
    x1, y1, x2, y2 = box
    dx, dy = (x2 - x1) * pad, (y2 - y1) * pad
    w, h = image.size
    return image.crop((max(0, x1 - dx), max(0, y1 - dy), min(w, x2 + dx), min(h, y2 + dy)))


def draw_mask(canvas, mask, color, thickness=2):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(canvas, contours, -1, color, thickness)


def draw_label(canvas, box, text, color):
    x, y = int(box[0]), max(15, int(box[1]) - 5)
    cv2.putText(canvas, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)


def main(path):
    image = Image.open(path).convert("RGB")
    canvas = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
    img_area = image.size[0] * image.size[1]
    GREEN, RED, BLUE, YELLOW = (0, 200, 0), (0, 0, 255), (255, 120, 0), (0, 220, 255)

    # 1. Узлы: по одному запросу за раз, без дублей и рамок на весь кадр
    nodes = detect_each(image, NODE_PROMPTS, NODE_BOX_THR, MAX_NODE_AREA)
    node_masks = [clean_mask(m) for m in segment(image, [n[0] for n in nodes])]
    # DINO на одиночный запрос находит одни и те же заметные объекты под любым
    # названием, поэтому название каждой рамки переопределяет CLIP.
    names = NODE_PROMPTS + [BACKGROUND]
    relabeled, kept_masks = [], []
    for (box, score, dino_name), mask in zip(nodes, node_masks):
        probs = classify(crop_box(image, box), [f"a photo of {n}" for n in names])
        best = int(np.argmax(probs))
        if DEBUG:
            print(f"    clip: dino='{dino_name}' -> '{names[best]}' p={probs[best]:.2f}")
        if names[best] != BACKGROUND:
            relabeled.append((box, score, names[best]))
            kept_masks.append(mask)
    nodes, node_masks = relabeled, kept_masks
    print(f"Узлов найдено: {len(nodes)}")

    # 2. Станция = объединение масок узлов. SAM по рамке на весь кадр даёт
    #    рваную маску, поэтому запасной вариант (если узлов нет) тоже чистим.
    station = None
    if node_masks:
        station = clean_mask(np.clip(sum(node_masks), 0, 1).astype(np.uint8), k_frac=0.06, min_frac=0.01)
    else:
        found = detect(image, STATION_PROMPTS, NODE_BOX_THR)
        if found:
            best = max(found, key=lambda d: d[1])
            station = clean_mask(segment(image, [best[0]])[0], k_frac=0.06, min_frac=0.01)
    if station is not None and station.any():
        draw_mask(canvas, station, BLUE, 3)
    else:
        print("Станция не найдена: попробуйте другие запросы или ниже порог")

    # Состояние каждого узла через CLIP
    for (box, score, name), mask in zip(nodes, node_masks):
        probs = classify(crop_box(image, box), NODE_STATES)
        # норма сравнивается с каждым дефектом по отдельности, иначе три
        # описания дефектов в сумме всегда перевешивают одно описание нормы
        p_defect = float(max(probs[1:] / (probs[0] + probs[1:])))
        if p_defect > DEFECT_THR:
            kind = NODE_STATES[1 + int(np.argmax(probs[1:]))].split("with ")[-1].split("a photo of ")[-1]
            color, text = RED, f"{name}: DEFECT {p_defect:.2f}"
            print(f"  [!] {name}: вероятный дефект ({kind}), p={p_defect:.2f}")
        else:
            color, text = GREEN, name
            print(f"  [ok] {name}: норма, p дефекта={p_defect:.2f}")
        draw_mask(canvas, mask, color)
        draw_label(canvas, box, text, color)

    # 3. Масло: DINO даёт кандидатов, CLIP отсеивает тени и воду, SAM обводит
    confirmed = []
    for box, score, name in detect(image, OIL_PROMPTS, OIL_BOX_THR):
        area = (box[2] - box[0]) * (box[3] - box[1])
        if area > MAX_OIL_AREA * img_area:
            continue  # рамка на полкадра: почти всегда ошибка
        p_oil = float(classify(crop_box(image, box, pad=0.25), OIL_CHECK)[0])
        if p_oil > OIL_CONFIRM_THR:
            confirmed.append((box, p_oil))
    for (box, p_oil), mask in zip(confirmed, segment(image, [c[0] for c in confirmed])):
        draw_mask(canvas, mask, YELLOW)
        draw_label(canvas, box, f"oil {p_oil:.2f}", YELLOW)
    print(f"Масляных пятен подтверждено: {len(confirmed)}")

    cv2.imwrite("result.jpg", canvas)
    print("Сохранено: result.jpg")


main("gem2.jpg")