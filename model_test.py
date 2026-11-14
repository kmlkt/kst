from ultralytics import YOLO

model = YOLO("runs/detect/oil_det_finetune/weights/best.pt")  # загружается один раз
result = model("насос/oil-leak-pump-v1/02_cool_led.png", imgsz=1024, conf=0.05)[0]

if result.masks is not None:
    for box, polygon in zip(result.boxes, result.masks.xy):
        name = result.names[int(box.cls)]
        print(name, f"{float(box.conf):.2f}", box.xyxy[0].tolist(), len(polygon))

result.save("result.jpg")  # картинка с контурами