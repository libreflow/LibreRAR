"""Génère l'icône source de LibreRAR (1024x1024, PNG) : trois livres empilés."""

from PIL import Image, ImageDraw

SIZE = 1024
BG = (18, 19, 26, 255)
COLORS = [
    (124, 92, 255, 255),  # violet — libre
    (62, 207, 142, 255),  # vert — libre
    (255, 159, 67, 255),  # orange — libre
]


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_book(draw, y_top, color):
    """Un livre vu de face : dos épais avec une tranche claire."""
    height = 150
    x0, x1 = 172, 852
    # corps du livre
    rounded_rect(draw, (x0, y_top, x1, y_top + height), 28, color)
    # tranche intérieure claire
    light = tuple(min(255, c + 70) for c in color)
    rounded_rect(
        draw, (x0 + 18, y_top + 22, x0 + 52, y_top + height - 22), 14, light
    )
    # pages (bandes horizontales)
    pages = (232, 234, 242, 255)
    rounded_rect(
        draw, (x0 + 64, y_top + 26, x1 - 26, y_top + 44), 8, pages
    )
    rounded_rect(
        draw, (x0 + 64, y_top + 60, x1 - 26, y_top + 74), 7, pages
    )
    rounded_rect(
        draw, (x0 + 64, y_top + 90, x1 - 26, y_top + 100), 6, pages
    )


def main():
    image = Image.new("RGBA", (SIZE, SIZE), BG)
    draw = ImageDraw.Draw(image)
    # Léger arrondi global
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), 190, fill=255)
    image.putalpha(mask)

    # Trois livres légèrement décalés, comme des archives empilées
    draw_book(draw, 190, COLORS[0])
    draw_book(draw, 380, COLORS[1])
    draw_book(draw, 570, COLORS[2])

    image.save("src-tauri/app-icon.png")
    image.save("public/favicon.png")
    image.resize((512, 512)).save("public/logo.png")
    print("icônes générées")


if __name__ == "__main__":
    main()
