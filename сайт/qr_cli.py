"""
Сохраняет QR-код с текстом в PDF формата A4 (код по центру листа).

  python qr_cli.py "Test"                -> Test.pdf
  python qr_cli.py "Test" -o tag.pdf     -> tag.pdf
  python qr_cli.py "Test" --size 150     -> код 150 мм
  python qr_cli.py                       -> спросит текст
"""

import argparse
import sys

import segno

MM = 72 / 25.4                      # 1 мм в пунктах PDF
A4_WIDTH, A4_HEIGHT = 210 * MM, 297 * MM


def make_filename(text):
    """Имя файла из текста, без недопустимых символов."""
    safe = "".join(ch for ch in text if ch.isalnum() or ch in " -_").strip()
    return (safe[:40] or "qr") + ".pdf"


def write_a4_pdf(path, rows, size_mm):
    """
    Рисует QR-код на листе A4 и сохраняет PDF.
    rows — строки кода, в каждой True для чёрного квадратика.
    size_mm — сторона кода на листе (вместе с белой рамкой).
    """
    count = len(rows)
    module = size_mm * MM / count                 # сторона квадратика
    left = (A4_WIDTH - size_mm * MM) / 2
    top = (A4_HEIGHT + size_mm * MM) / 2          # в PDF ось Y идёт снизу вверх

    # Соседние чёрные квадратики в строке объединяем в один прямоугольник
    commands = ["0 g"]
    for r, row in enumerate(rows):
        y = top - (r + 1) * module
        c = 0
        while c < len(row):
            if row[c]:
                start = c
                while c < len(row) and row[c]:
                    c += 1
                commands.append(f"{left + start * module:.3f} {y:.3f} "
                                f"{(c - start) * module:.3f} {module:.3f} re")
            else:
                c += 1
    commands.append("f")
    content = "\n".join(commands).encode("ascii")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {A4_WIDTH:.2f} {A4_HEIGHT:.2f}] "
        f"/Contents 4 0 R /Resources << >> >>".encode("ascii"),
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n"
        + content + b"\nendstream",
    ]

    pdf = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"

    xref = len(pdf)
    pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii")
    for offset in offsets:
        pdf += f"{offset:010d} 00000 n \n".encode("ascii")
    pdf += (f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref}\n%%EOF\n").encode("ascii")

    with open(path, "wb") as f:
        f.write(pdf)


def main():
    parser = argparse.ArgumentParser(description="Сохранить QR-код с текстом в PDF формата A4")
    parser.add_argument("text", nargs="?", help="текст для QR-кода (если не указан, будет спрошен)")
    parser.add_argument("-o", "--output", help="имя PDF-файла (по умолчанию из текста)")
    parser.add_argument("--size", type=float, default=100,
                        help="сторона кода на листе в мм, от 20 до 200 (по умолчанию 100)")
    args = parser.parse_args()

    if not 20 <= args.size <= 200:
        sys.exit("Ошибка: --size должен быть от 20 до 200 мм")

    text = args.text if args.text is not None else input("Текст для QR-кода: ")
    if not text:
        sys.exit("Ошибка: пустой текст")

    output = args.output or make_filename(text)
    if not output.lower().endswith(".pdf"):
        output += ".pdf"

    try:
        qr = segno.make_qr(text)
        # Сетка квадратиков вместе с белой рамкой в 4 квадратика
        rows = [[bool(v) for v in row] for row in qr.matrix_iter(scale=1, border=4)]
        write_a4_pdf(output, rows, args.size)
    except Exception as err:
        sys.exit(f"Ошибка: {err}")

    print(f"Сохранено: {output} (A4, код {args.size:g} мм)")


if __name__ == "__main__":
    main()
