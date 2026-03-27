#!/usr/bin/env python
import os
import sys

from PIL import Image


def main() -> int:
    if len(sys.argv) < 4:
        print("Usage: trim_alpha_png_set.py <output_dir> <input1> <input2> [...]", file=sys.stderr)
        return 1

    output_dir = os.path.abspath(sys.argv[1])
    input_paths = [os.path.abspath(path) for path in sys.argv[2:]]
    os.makedirs(output_dir, exist_ok=True)

    bounds = None
    images = []
    for input_path in input_paths:
        image = Image.open(input_path).convert("RGBA")
        bbox = image.getbbox()
        images.append((input_path, image))
        if bbox is None:
            continue
        if bounds is None:
            bounds = list(bbox)
        else:
            bounds[0] = min(bounds[0], bbox[0])
            bounds[1] = min(bounds[1], bbox[1])
            bounds[2] = max(bounds[2], bbox[2])
            bounds[3] = max(bounds[3], bbox[3])

    crop_box = tuple(bounds) if bounds is not None else None
    for input_path, image in images:
        output_path = os.path.join(output_dir, os.path.basename(input_path))
        if crop_box is None:
            image.save(output_path)
        else:
            image.crop(crop_box).save(output_path)
        print(output_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
